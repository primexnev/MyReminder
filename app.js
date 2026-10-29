(() => {
  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ls = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  let tasks = [];          // [{id, ...data}]
  let loaded = false;
  let view = "today";
  let store = null;        // {set(id,data), update(id,patch), remove(id)}
  let editingId = null;
  let pendingDelete = null;
  let soundOn = ls.get("dl.sound", true);

  // ---------- storage ----------
  function localStore() {
    const read = () => ls.get("dl.tasks", {});
    const emit = () => { const all = read(); tasks = Object.entries(all).map(([id, d]) => ({ id, ...d })); loaded = true; render(); };
    const write = all => { ls.set("dl.tasks", all); emit(); };
    setTimeout(emit, 0);
    return {
      async set(id, data) { const a = read(); a[id] = data; write(a); },
      async update(id, patch) { const a = read(); a[id] = { ...a[id], ...patch }; write(a); },
      async remove(id) { const a = read(); delete a[id]; write(a); }
    };
  }

  // Sync between devices comes with the reminder backend; until then tasks live on this device.
  async function connect() {
    store = localStore();
    $("storeNote").textContent = "Saved on this device. Reminders show while the app is open.";
  }

  // ---------- service worker & system notifications ----------
  let swReg = null;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(r => { swReg = r; }).catch(() => {});
  }
  const canNotify = "Notification" in window;
  function paintNotify() {
    const b = $("notifyBtn");
    if (!canNotify) { b.hidden = true; return; }
    const p = Notification.permission;
    b.textContent = p === "granted" ? "Notifications: on" : p === "denied" ? "Notifications: blocked" : "Turn on notifications";
    b.disabled = p !== "default";
  }
  $("notifyBtn").onclick = async () => { try { await Notification.requestPermission(); } catch {} paintNotify(); };
  paintNotify();
  function systemNotify(t) {
    if (!canNotify || Notification.permission !== "granted") return;
    const opts = { body: "Due at " + t.time, tag: "task-" + t.id, icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
    try { swReg ? swReg.showNotification(t.title, opts) : new Notification(t.title, opts); } catch {}
  }

  // ---------- schedule logic ----------
  function scheduledOn(t, dateStr, dow) {
    switch (t.repeat) {
      case "daily": return true;
      case "weekdays": return dow >= 1 && dow <= 5;
      case "days": return (t.days || []).includes(dow);
      case "once": return t.date === dateStr || (t.date < dateStr && !t.lastDone);
    }
    return false;
  }
  const isDone = (t, today) => t.repeat === "once" ? !!t.lastDone : t.lastDone === today;
  function repeatLabel(t) {
    if (t.repeat === "daily") return "Every day";
    if (t.repeat === "weekdays") return "Weekdays";
    if (t.repeat === "days") return (t.days || []).slice().sort((a,b) => ((a+6)%7)-((b+6)%7)).map(d => DAYS[d]).join(" · ") || "No days";
    if (t.repeat === "once") {
      const [y,m,d] = (t.date || "").split("-").map(Number);
      return y ? new Date(y, m-1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "One day";
    }
    return "";
  }

  // ---------- render ----------
  const CHECK = '<svg viewBox="0 0 14 14" fill="none" stroke="var(--sheet)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5l3 3 6-7"/></svg>';

  function taskRow(t, today, opts = {}) {
    const li = document.createElement("li");
    li.className = "task" + (opts.manage ? "" : isDone(t, today) ? " done" : "");
    const time = document.createElement("div"); time.className = "time"; time.textContent = t.time || "—";
    const check = document.createElement("button");
    check.className = "check"; check.type = "button"; check.innerHTML = CHECK;
    const done = isDone(t, today);
    check.setAttribute("aria-label", (done ? "Mark not done: " : "Mark done: ") + t.title);
    check.onclick = () => toggle(t);
    if (opts.manage) check.style.visibility = "hidden";
    const body = document.createElement("div"); body.className = "body";
    const title = document.createElement("div"); title.className = "title"; title.textContent = t.title;
    const sub = document.createElement("div"); sub.className = "sub";
    const rep = document.createElement("span"); rep.textContent = repeatLabel(t); sub.append(rep);
    if (opts.overdue) { const p = document.createElement("span"); p.className = "pill"; p.textContent = "Overdue"; sub.append(p); }
    body.append(title, sub);
    const actions = document.createElement("div"); actions.className = "row-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "icon-btn"; edit.textContent = "Edit";
    edit.onclick = () => openForm(t);
    actions.append(edit);
    if (opts.manage) {
      const del = document.createElement("button"); del.type = "button"; del.className = "icon-btn";
      if (pendingDelete === t.id) { del.textContent = "Delete?"; del.classList.add("danger"); del.onclick = () => { pendingDelete = null; store.remove(t.id); }; }
      else { del.textContent = "Delete"; del.onclick = () => { pendingDelete = t.id; render(); }; }
      actions.append(del);
    }
    li.append(time, check, body, actions);
    return li;
  }

  function group(title, items, cls, today, opts) {
    if (!items.length) return null;
    const sec = document.createElement("section"); sec.className = "group " + (cls || "");
    const h = document.createElement("h2");
    const a = document.createElement("span"); a.textContent = title;
    const c = document.createElement("span"); c.className = "count"; c.textContent = items.length;
    h.append(a, c);
    const ul = document.createElement("ul");
    items.forEach(t => ul.append(taskRow(t, today, { ...opts, overdue: opts?.overdueFn?.(t) })));
    sec.append(h, ul);
    return sec;
  }

  const byTime = (a, b) => (a.time || "99").localeCompare(b.time || "99") || a.title.localeCompare(b.title);

  function emptyState(heading, text, withStarter) {
    const d = document.createElement("div"); d.className = "empty";
    const s = document.createElement("strong"); s.textContent = heading;
    const p = document.createElement("div"); p.textContent = text;
    d.append(s, p);
    const b = document.createElement("button"); b.className = "primary"; b.type = "button"; b.textContent = "+ Add your first task";
    b.onclick = () => openForm(); d.append(b);
    if (withStarter) {
      const g = document.createElement("button"); g.className = "ghost"; g.type = "button"; g.textContent = "Or start with 4 example tasks";
      g.onclick = addStarters; d.append(g);
    }
    return d;
  }

  function render() {
    const now = new Date(), today = ymd(now), dow = now.getDay(), nowHM = hm(now);
    $("weekday").textContent = now.toLocaleDateString(undefined, { weekday: "long" });
    $("date").textContent = now.toLocaleDateString(undefined, { day: "numeric", month: "long" });

    const todays = tasks.filter(t => scheduledOn(t, today, dow));
    const doneCount = todays.filter(t => isDone(t, today)).length;
    $("meterNum").textContent = `${doneCount} / ${todays.length}`;
    const C = 131.95;
    $("ring").setAttribute("stroke-dashoffset", todays.length ? C * (1 - doneCount / todays.length) : C);

    const list = $("list"); list.replaceChildren();
    if (!loaded) { list.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "Loading your list…" })); return; }

    if (view === "all") {
      if (!tasks.length) { list.append(emptyState("No tasks yet", "Add the things you want to do every day, on certain days, or just once.", true)); return; }
      const order = ["daily", "weekdays", "days", "once"];
      const names = { daily: "Every day", weekdays: "Weekdays", days: "Chosen days", once: "One day only" };
      order.forEach(r => {
        const g = group(names[r], tasks.filter(t => t.repeat === r).sort(byTime), "", today, { manage: true });
        if (g) list.append(g);
      });
      return;
    }

    if (!todays.length) {
      list.append(tasks.length
        ? emptyState("Nothing scheduled today", "Enjoy the free day, or add something for today.", false)
        : emptyState("Start your daily list", "Add a task, pick a time, and choose how often it repeats.", true));
      return;
    }
    const open = todays.filter(t => !isDone(t, today));
    const overdue = t => t.repeat === "once" && t.date < today;
    const attention = open.filter(t => overdue(t) || (t.time && t.time <= nowHM)).sort(byTime);
    const later = open.filter(t => !attention.includes(t) && t.time).sort(byTime);
    const anytime = open.filter(t => !attention.includes(t) && !t.time).sort(byTime);
    const done = todays.filter(t => isDone(t, today)).sort(byTime);
    [
      group("Due now", attention, "attention", today, { overdueFn: overdue }),
      group("Later today", later, "", today),
      group("Anytime today", anytime, "", today),
      group("Done", done, "", today)
    ].forEach(g => g && list.append(g));
  }

  // ---------- actions ----------
  function toggle(t) {
    const today = ymd(new Date());
    store.update(t.id, { lastDone: isDone(t, today) ? null : today });
  }

  const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function addStarters() {
    const today = ymd(new Date());
    [
      { title: "Drink a glass of water", time: "08:00", repeat: "daily" },
      { title: "Check calendar for tomorrow", time: "20:30", repeat: "daily" },
      { title: "Workout", time: "18:00", repeat: "days", days: [1, 3, 5] },
      { title: "Tidy up my desk", time: null, repeat: "once", date: today }
    ].forEach(s => store.set(newId(), { days: [], date: null, lastDone: null, createdAt: Date.now(), ...s }));
  }

  // ---------- form ----------
  let formDays = [];
  function renderDays() {
    const wrap = $("fDays"); wrap.replaceChildren();
    [1,2,3,4,5,6,0].forEach(d => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = DAYS[d].slice(0, 2);
      b.setAttribute("aria-label", DAYS[d]); b.setAttribute("aria-pressed", formDays.includes(d));
      b.onclick = () => { formDays = formDays.includes(d) ? formDays.filter(x => x !== d) : [...formDays, d]; renderDays(); };
      wrap.append(b);
    });
  }
  function syncRepeat() {
    const r = $("fRepeat").value;
    $("daysWrap").hidden = r !== "days";
    $("dateWrap").hidden = r !== "once";
  }
  function openForm(t) {
    editingId = t?.id || null;
    $("formTitle").textContent = t ? "Edit task" : "New task";
    $("saveBtn").textContent = t ? "Save" : "Add task";
    $("fTitle").value = t?.title || "";
    $("fTime").value = t?.time || "";
    $("fRepeat").value = t?.repeat || "daily";
    $("fDate").value = t?.date || ymd(new Date());
    formDays = t?.days?.slice() || [new Date().getDay()];
    renderDays(); syncRepeat();
    $("scrim").hidden = false;
    setTimeout(() => $("fTitle").focus(), 30);
  }
  function closeForm() { $("scrim").hidden = true; editingId = null; }

  $("fRepeat").onchange = syncRepeat;
  $("cancelBtn").onclick = closeForm;
  $("scrim").addEventListener("click", e => { if (e.target === $("scrim")) closeForm(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("scrim").hidden) closeForm(); });
  $("newBtn").onclick = () => openForm();
  $("form").addEventListener("submit", e => {
    e.preventDefault();
    const title = $("fTitle").value.trim(); if (!title) return;
    const repeat = $("fRepeat").value;
    if (repeat === "days" && !formDays.length) { $("daysLabel").textContent = "Pick at least one day"; return; }
    $("daysLabel").textContent = "On these days";
    const data = {
      title, time: $("fTime").value || null, repeat,
      days: repeat === "days" ? formDays.slice().sort() : [],
      date: repeat === "once" ? ($("fDate").value || ymd(new Date())) : null
    };
    if (editingId) {
      const { id, ...prev } = tasks.find(t => t.id === editingId) || {};
      store.set(editingId, { ...prev, ...data, lastDone: prev.lastDone ?? null, createdAt: prev.createdAt ?? Date.now() });
    } else {
      store.set(newId(), { ...data, lastDone: null, createdAt: Date.now() });
    }
    closeForm();
  });

  // ---------- tabs & sound ----------
  function setView(v) {
    view = v; pendingDelete = null;
    $("tabToday").setAttribute("aria-selected", v === "today");
    $("tabAll").setAttribute("aria-selected", v === "all");
    render();
  }
  $("tabToday").onclick = () => setView("today");
  $("tabAll").onclick = () => setView("all");
  const paintSound = () => $("soundBtn").textContent = "Sound: " + (soundOn ? "on" : "off");
  $("soundBtn").onclick = () => { soundOn = !soundOn; ls.set("dl.sound", soundOn); paintSound(); if (soundOn) chime(); };
  paintSound();

  let audio = null;
  document.addEventListener("pointerdown", () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch {} }, { once: false, passive: true });
  function chime() {
    if (!soundOn || !audio || audio.state !== "running") return;
    const t0 = audio.currentTime;
    [880, 1318.5].forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * .18);
      g.gain.linearRampToValueAtTime(.18, t0 + i * .18 + .02);
      g.gain.exponentialRampToValueAtTime(.001, t0 + i * .18 + .6);
      o.connect(g).connect(audio.destination); o.start(t0 + i * .18); o.stop(t0 + i * .18 + .65);
    });
  }

  // ---------- reminders ----------
  // Fired/snoozed state is per device, keyed by date, so each device reminds on its own.
  let toastTask = null;
  function remState() {
    const today = ymd(new Date());
    const s = ls.get("dl.rem", null);
    return s && s.date === today ? s : { date: today, fired: [], snooze: {} };
  }
  function checkReminders() {
    if (!loaded || toastTask) return;
    const now = new Date(), today = ymd(now), dow = now.getDay(), nowHM = hm(now);
    const s = remState();
    const due = tasks.filter(t => t.time && scheduledOn(t, today, dow) && !isDone(t, today) && t.time <= nowHM)
      .sort(byTime)
      .find(t => {
        const sn = s.snooze[t.id];
        if (sn) return Date.now() >= sn;
        return !s.fired.includes(t.id);
      });
    if (!due) return;
    // Don't ring for things that were already overdue by more than 2 hours when the page opened.
    const [h, m] = due.time.split(":").map(Number);
    const mins = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
    if (mins > 120 && !s.snooze[due.id]) { s.fired.push(due.id); ls.set("dl.rem", s); return checkReminders(); }
    s.fired.includes(due.id) || s.fired.push(due.id);
    delete s.snooze[due.id];
    ls.set("dl.rem", s);
    showToast(due);
  }
  function showToast(t) {
    toastTask = t;
    $("tEyebrow").textContent = "Reminder · " + t.time;
    $("tTitle").textContent = t.title;
    $("toast").hidden = false;
    chime();
    if (document.hidden) systemNotify(t);
    try { navigator.vibrate?.([120, 80, 120]); } catch {}
  }
  function hideToast() { $("toast").hidden = true; toastTask = null; setTimeout(checkReminders, 400); }
  $("tDone").onclick = () => { const t = toastTask; hideToast(); if (t && !isDone(t, ymd(new Date()))) toggle(t); };
  $("tSnooze").onclick = () => { const s = remState(); s.snooze[toastTask.id] = Date.now() + 10 * 60 * 1000; ls.set("dl.rem", s); hideToast(); };
  $("tDismiss").onclick = hideToast;

  // Re-render each minute (handles midnight rollover and "due now") and look for reminders.
  let lastMinute = "";
  setInterval(() => {
    const m = hm(new Date());
    if (m !== lastMinute) { lastMinute = m; render(); }
    checkReminders();
  }, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); checkReminders(); } });

  render();
  connect().then(() => setTimeout(checkReminders, 1500));
})();
