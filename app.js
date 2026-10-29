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

  // ---------- storage (device only for now; sync comes with the backend) ----------
  let tasks = [];
  const store = {
    load() { tasks = Object.entries(ls.get("dl.tasks", {})).map(([id, d]) => ({ id, ...d })); },
    save() { ls.set("dl.tasks", Object.fromEntries(tasks.map(({ id, ...d }) => [id, d]))); render(); },
    put(id, data) { tasks = tasks.filter(t => t.id !== id).concat({ id, ...data }); this.save(); },
    patch(id, p) { tasks = tasks.map(t => t.id === id ? { ...t, ...p } : t); this.save(); },
    remove(id) { tasks = tasks.filter(t => t.id !== id); this.save(); }
  };
  window.addEventListener("storage", e => { if (e.key === "dl.tasks") { store.load(); render(); } });

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
      title, time: $("addTime").value || null,
      repeat: daily ? "daily" : "once", days: [], date: daily ? null : ymd(new Date()),
      lastDone: null, createdAt: Date.now()
    });
    $("addTitle").value = ""; $("addTime").value = "";
    $("addTitle").focus();
  });

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
      ...prev, title, repeat, time: $("eTime").value || null,
      days: repeat === "days" ? eDays.slice().sort() : [],
      date: repeat === "once" ? ($("eDate").value || ymd(new Date())) : null,
      lastDone: repeat === prev.repeat ? prev.lastDone : null
    });
    closeEdit();
  });

  // ---------- notifications ----------
  let swReg = null;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").then(r => { swReg = r; }).catch(() => {});
  const canNotify = "Notification" in window;
  const paintNotify = () => { $("notifyBtn").hidden = !canNotify || Notification.permission !== "default"; };
  $("notifyBtn").onclick = async () => { try { await Notification.requestPermission(); } catch {} paintNotify(); };
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
    if (document.hidden && canNotify && Notification.permission === "granted") {
      const opts = { body: "Due at " + t.time, tag: "task-" + t.id, icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
      try { swReg ? swReg.showNotification(t.title, opts) : new Notification(t.title, opts); } catch {}
    }
  }
  function hideToast() { $("toast").hidden = true; toastTask = null; setTimeout(checkReminders, 400); }
  $("tDone").onclick = () => { const t = toastTask; hideToast(); store.patch(t.id, { lastDone: ymd(new Date()) }); };
  $("tSnooze").onclick = () => { const s = remState(); s.snooze[toastTask.id] = Date.now() + 10 * 60 * 1000; ls.set("dl.rem", s); hideToast(); };
  $("tClose").onclick = hideToast;

  let lastMinute = "";
  setInterval(() => {
    const m = hm(new Date());
    if (m !== lastMinute) { lastMinute = m; render(); }
    checkReminders();
  }, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); checkReminders(); } });

  store.load();
  render();
  setTimeout(checkReminders, 1000);
})();
