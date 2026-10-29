(() => {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ls = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- API ----------
  const API = window.MYREMINDER_API;
  let session = ls.get("dl.session", null); // {token, username}

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(session ? { Authorization: "Bearer " + session.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session) { signOutLocal(); throw new Error(data.error || "Please sign in again."); }
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }

  // ---------- storage: server is the source of truth, local copy keeps it fast and offline-readable ----------
  let tasks = [];
  const showSync = msg => { $("syncMsg").textContent = msg || ""; $("syncMsg").hidden = !msg; };
  const cache = () => ls.set("dl.cache", tasks);
  const send = (p, again) => p.then(() => showSync(""), e => { showSync("Couldn't save: " + e.message); again && setTimeout(store.pull, 3000); });
  const store = {
    async pull() {
      if (!session) return;
      try { tasks = (await api("/api/tasks")).tasks; cache(); showSync(""); render(); }
      catch (e) { if (session) showSync("Offline. Showing your last synced list."); }
    },
    put(id, data) {
      tasks = tasks.filter(t => t.id !== id).concat({ id, ...data }); cache(); render();
      send(api("/api/tasks/" + id, { method: "PUT", body: data }), true);
    },
    patch(id, p) {
      const t = tasks.find(x => x.id === id); if (!t) return;
      const { id: _, ...rest } = { ...t, ...p };
      this.put(id, rest);
    },
    remove(id) {
      tasks = tasks.filter(t => t.id !== id); cache(); render();
      send(api("/api/tasks/" + id, { method: "DELETE" }), true);
    }
  };

  // Tasks made before accounts existed live under dl.tasks; upload them once.
  async function migrateLocal() {
    const old = ls.get("dl.tasks", null);
    if (!old) return;
    for (const [id, d] of Object.entries(old)) {
      try { await api("/api/tasks/" + id, { method: "PUT", body: d }); } catch { return; }
    }
    try { localStorage.removeItem("dl.tasks"); } catch {}
  }

  // ---------- sign in ----------
  async function showAuth() {
    $("app").hidden = true; $("auth").hidden = false;
    $("aError").textContent = "";
    let open = false;
    try { open = (await api("/api/status")).signupOpen; } catch { $("aError").textContent = "Can't reach the server. Check your connection."; }
    $("auth").dataset.mode = open ? "register" : "login";
    $("aSubmit").textContent = open ? "Create account" : "Sign in";
    $("authHint").textContent = open ? "Create your account. You'll use it to sign in on your phone and computer." : "Sign in to see your tasks on every device.";
    $("aPass").autocomplete = open ? "new-password" : "current-password";
    $("aUser").focus();
  }
  $("auth").addEventListener("submit", async e => {
    e.preventDefault();
    $("aSubmit").disabled = true; $("aError").textContent = "";
    try {
      const mode = $("auth").dataset.mode === "register" ? "register" : "login";
      session = await api("/api/" + mode, { method: "POST", body: { username: $("aUser").value, password: $("aPass").value } });
      ls.set("dl.session", session);
      $("aPass").value = "";
      await startApp();
    } catch (err) { $("aError").textContent = err.message; }
    $("aSubmit").disabled = false;
  });
  function signOutLocal() {
    session = null; tasks = [];
    try { localStorage.removeItem("dl.session"); localStorage.removeItem("dl.cache"); } catch {}
    showAuth();
  }
  $("signOut").onclick = async () => {
    await dropPush();
    try { await api("/api/logout", { method: "POST" }); } catch {}
    signOutLocal();
  };

  async function startApp() {
    $("auth").hidden = true; $("app").hidden = false;
    $("who").textContent = session.username;
    tasks = ls.get("dl.cache", []);
    render();
    await migrateLocal();
    await store.pull();
    syncPush().catch(() => {}).finally(paintNotify);
    setTimeout(checkReminders, 500);
  }

  // ---------- schedule ----------
  function scheduledOn(t, date, dow) {
    if (t.repeat === "daily") return true;
    if (t.repeat === "weekdays") return dow >= 1 && dow <= 5;
    if (t.repeat === "days") return (t.days || []).includes(dow);
    return t.date === date || (t.date < date && !t.lastDone);
  }
  const isDone = (t, today) => t.repeat === "once" ? !!t.lastDone : t.lastDone === today;
  function repeatText(t) {
    if (t.repeat === "daily") return "Every day";
    if (t.repeat === "weekdays") return "Weekdays";
    if (t.repeat === "days") return [1, 2, 3, 4, 5, 6, 0].filter(d => (t.days || []).includes(d)).map(d => DAYS[d]).join(", ");
    const [y, m, d] = (t.date || "").split("-").map(Number);
    return y ? new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "";
  }
  const byTime = (a, b) => (a.time || "99").localeCompare(b.time || "99") || a.title.localeCompare(b.title);

  // ---------- render ----------
  function row(t, today, nowHM, showRepeat) {
    const done = isDone(t, today);
    const late = !done && ((t.repeat === "once" && t.date < today) || (t.time && t.time <= nowHM));
    const li = document.createElement("li");
    li.className = "item" + (done ? " done" : "") + (late && !showRepeat ? " late" : "");
    const box = document.createElement("button");
    box.className = "box"; box.type = "button";
    box.setAttribute("aria-label", (done ? "Undo " : "Complete ") + t.title);
    box.onclick = () => store.patch(t.id, { lastDone: done ? null : today });
    if (showRepeat) box.style.visibility = "hidden";
    const text = document.createElement("button");
    text.className = "text"; text.type = "button";
    text.textContent = t.title;
    if (t.note) { const n = document.createElement("span"); n.className = "note"; n.textContent = t.note; text.append(n); }
    const sub = showRepeat ? repeatText(t) : (t.repeat !== "once" ? repeatText(t) : (t.date < today ? "Overdue" : ""));
    if (sub) { const s = document.createElement("span"); s.className = "rep"; s.textContent = sub; text.append(s); }
    text.onclick = () => openEdit(t);
    const meta = document.createElement("span");
    meta.className = "meta"; meta.textContent = t.time || "";
    li.append(box, text, meta);
    return li;
  }

  function render() {
    const now = new Date(), today = ymd(now), dow = now.getDay(), nowHM = hm(now);
    $("date").textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    const todays = tasks.filter(t => scheduledOn(t, today, dow));
    const open = todays.filter(t => !isDone(t, today)).sort(byTime);
    const done = todays.filter(t => isDone(t, today)).sort(byTime);
    $("count").textContent = todays.length ? `${done.length} of ${todays.length}` : "";
    $("list").replaceChildren(...open.concat(done).map(t => row(t, today, nowHM, false)));
    $("empty").hidden = todays.length > 0;
    const others = tasks.filter(t => !scheduledOn(t, today, dow) && !(t.repeat === "once" && t.lastDone && t.date < today)).sort(byTime);
    $("otherWrap").hidden = !others.length;
    $("otherCount").textContent = `(${others.length})`;
    $("other").replaceChildren(...others.map(t => row(t, today, nowHM, true)));
  }

  // ---------- quick add ----------
  $("addRepeat").onclick = e => { const b = e.currentTarget; b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); };
  $("addForm").addEventListener("submit", e => {
    e.preventDefault();
    const title = $("addTitle").value.trim();
    if (!title) { $("addTitle").focus(); return; }
    const daily = $("addRepeat").getAttribute("aria-pressed") === "true";
    store.put(newId(), {
      title, note: $("addNote").value.trim(), time: $("addTime").value || null,
      repeat: daily ? "daily" : "once", days: [], date: daily ? null : ymd(new Date()),
      lastDone: null, createdAt: Date.now()
    });
    $("addTitle").value = ""; $("addNote").value = ""; $("addTime").value = "";
    growNote();
    $("addTitle").focus();
  });
  // Enter in the topic jumps to the description; the description grows as you type.
  $("addTitle").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && $("addTitle").value.trim()) { e.preventDefault(); $("addNote").focus(); } });
  const growNote = () => { const n = $("addNote"); n.style.height = "auto"; n.style.height = n.scrollHeight + "px"; };
  $("addNote").addEventListener("input", growNote);

  // ---------- edit sheet ----------
  let editing = null, eDays = [], confirmDelete = false;
  function paintDays() {
    $("eDays").replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map(d => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = DAYS[d].slice(0, 2);
      b.setAttribute("aria-label", DAYS[d]);
      b.setAttribute("aria-pressed", eDays.includes(d));
      b.onclick = () => { eDays = eDays.includes(d) ? eDays.filter(x => x !== d) : eDays.concat(d); paintDays(); };
      return b;
    }));
  }
  function syncRepeat() {
    const r = $("eRepeat").value;
    $("eDays").hidden = r !== "days";
    $("eDateWrap").hidden = r !== "once";
  }
  function openEdit(t) {
    editing = t; confirmDelete = false;
    $("eDelete").textContent = "Delete";
    $("eTitle").value = t.title;
    $("eNote").value = t.note || "";
    $("eTime").value = t.time || "";
    $("eRepeat").value = t.repeat;
    $("eDate").value = t.date || ymd(new Date());
    eDays = (t.days && t.days.length) ? t.days.slice() : [new Date().getDay()];
    paintDays(); syncRepeat();
    $("scrim").hidden = false;
  }
  const closeEdit = () => { $("scrim").hidden = true; editing = null; };
  $("eRepeat").onchange = syncRepeat;
  $("eCancel").onclick = closeEdit;
  $("scrim").addEventListener("click", e => { if (e.target === $("scrim")) closeEdit(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && editing) closeEdit(); });
  $("eDelete").onclick = () => {
    if (!confirmDelete) { confirmDelete = true; $("eDelete").textContent = "Tap again to delete"; return; }
    store.remove(editing.id); closeEdit();
  };
  $("editForm").addEventListener("submit", e => {
    e.preventDefault();
    const title = $("eTitle").value.trim();
    if (!title) return;
    const repeat = $("eRepeat").value;
    const { id, ...prev } = editing;
    store.put(id, {
      ...prev, title, note: $("eNote").value.trim(), repeat, time: $("eTime").value || null,
      days: repeat === "days" ? eDays.slice().sort() : [],
      date: repeat === "once" ? ($("eDate").value || ymd(new Date())) : null,
      lastDone: repeat === prev.repeat ? prev.lastDone : null
    });
    closeEdit();
  });

  // ---------- notifications ----------
  // The server sends a push at each task's time; this device just needs to be subscribed.
  const swReady = "serviceWorker" in navigator
    ? navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);
  let swReg = null, pushOn = false;
  swReady.then(r => { swReg = r; });
  const canNotify = "Notification" in window;
  const canPush = canNotify && "PushManager" in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const keyBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

  async function syncPush() {
    if (!canPush || Notification.permission !== "granted" || !session) return;
    const reg = await swReady;
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(window.MYREMINDER_VAPID) });
    const j = sub.toJSON();
    await api("/api/push", { method: "POST", body: { endpoint: j.endpoint, keys: j.keys, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    pushOn = true;
  }
  async function dropPush() {
    try {
      const sub = await (await swReady)?.pushManager.getSubscription();
      if (sub) await api("/api/push", { method: "DELETE", body: { endpoint: sub.endpoint } });
    } catch {}
    pushOn = false;
  }
  function paintNotify() {
    const b = $("notifyBtn");
    $("testPush").hidden = !canPush || Notification.permission !== "granted";
    if (isIOS && !standalone) {
      b.hidden = false; b.disabled = true;
      b.textContent = "For notifications on iPhone: tap Share → Add to Home Screen, then open MyReminder from your home screen.";
      return;
    }
    b.disabled = false;
    b.textContent = "Turn on notifications to get reminders";
    b.hidden = !canPush || Notification.permission !== "default";
  }
  $("notifyBtn").onclick = async () => {
    try { await Notification.requestPermission(); await syncPush(); showSync(""); }
    catch (e) { showSync("Couldn't turn on notifications: " + e.message); }
    paintNotify();
  };
  $("testPush").onclick = async () => {
    try {
      await syncPush();
      const r = await api("/api/push/test", { method: "POST" });
      showSync(r.sent ? "" : "This device isn't set up for notifications yet.");
    } catch (e) { showSync(e.message); }
  };
  paintNotify();

  let audio = null;
  document.addEventListener("pointerdown", () => {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch {}
  }, { passive: true });
  function chime() {
    if (!audio || audio.state !== "running") return;
    const t0 = audio.currentTime;
    [880, 1318.5].forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * .18);
      g.gain.linearRampToValueAtTime(.18, t0 + i * .18 + .02);
      g.gain.exponentialRampToValueAtTime(.001, t0 + i * .18 + .6);
      o.connect(g).connect(audio.destination); o.start(t0 + i * .18); o.stop(t0 + i * .18 + .65);
    });
  }

  // Fired/snoozed state is per device, keyed by date.
  let toastTask = null;
  function remState() {
    const today = ymd(new Date()), s = ls.get("dl.rem", null);
    return s && s.date === today ? s : { date: today, fired: [], snooze: {} };
  }
  function checkReminders() {
    if (toastTask) return;
    const now = new Date(), today = ymd(now), dow = now.getDay(), nowHM = hm(now), s = remState();
    const due = tasks.filter(t => t.time && scheduledOn(t, today, dow) && !isDone(t, today) && t.time <= nowHM).sort(byTime)
      .find(t => s.snooze[t.id] ? Date.now() >= s.snooze[t.id] : !s.fired.includes(t.id));
    if (!due) return;
    const [h, m] = due.time.split(":").map(Number);
    const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m) > 120;
    if (!s.fired.includes(due.id)) s.fired.push(due.id);
    const snoozed = !!s.snooze[due.id];
    delete s.snooze[due.id];
    ls.set("dl.rem", s);
    if (late && !snoozed) return checkReminders();
    showToast(due);
  }
  function showToast(t) {
    toastTask = t;
    $("tTitle").textContent = `${t.time} · ${t.title}`;
    $("toast").hidden = false;
    chime();
    try { navigator.vibrate?.([120, 80, 120]); } catch {}
    if (document.hidden && !pushOn && canNotify && Notification.permission === "granted") {
      const opts = { body: "Due at " + t.time, tag: "task-" + t.id, icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
      try { swReg ? swReg.showNotification(t.title, opts) : new Notification(t.title, opts); } catch {}
    }
  }
  function hideToast() { $("toast").hidden = true; toastTask = null; setTimeout(checkReminders, 400); }
  $("tDone").onclick = () => { const t = toastTask; hideToast(); store.patch(t.id, { lastDone: ymd(new Date()) }); };
  $("tSnooze").onclick = () => { const s = remState(); s.snooze[toastTask.id] = Date.now() + 10 * 60 * 1000; ls.set("dl.rem", s); hideToast(); };
  $("tClose").onclick = hideToast;

  // Re-render each minute, pick up changes from other devices every 30 s and when the app comes back.
  let lastMinute = "", ticks = 0;
  setInterval(() => {
    if (!session) return;
    const m = hm(new Date());
    if (m !== lastMinute) { lastMinute = m; render(); }
    if (++ticks % 2 === 0 && !document.hidden && !editing) store.pull();
    checkReminders();
  }, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && session) { store.pull(); checkReminders(); } });

  session ? startApp() : showAuth();
})();
