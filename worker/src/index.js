// MyReminder API: accounts, sessions and task sync on Cloudflare D1, plus reminder pushes from a cron.
// Anyone can create an account; the first account is the owner and can read everyone's feedback.

import { b64url, sendPush } from "./push.js";
import { toIcsUrl, eventsBetween, validTz } from "./calendar.js";

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 180;
const CATCH_UP_MINUTES = 10;

const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async s => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return b64url(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

async function createSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, Date.now()).run();
  return token;
}

async function authUser(req, env) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const row = await env.DB.prepare("SELECT user_id, created_at FROM sessions WHERE token_hash = ?").bind(await sha256(m[1])).first();
  if (!row || Date.now() - row.created_at > SESSION_DAYS * 864e5) return null;
  return row.user_id;
}

// Fixed-window counter; true once `key` has been used more than `max` times in the window.
async function limited(env, key, max, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO attempts (key, count, window_start) VALUES (?1, 1, ?2) ON CONFLICT (key) DO UPDATE SET " +
    "count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END RETURNING count"
  ).bind(key, now, now - windowMs).first();
  return row.count > max;
}
const clientIp = req => req.headers.get("CF-Connecting-IP") || "local";
const TOO_MANY = "Too many tries. Wait a few minutes and try again.";

async function ownerId(env) {
  return env.DB.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").first("id");
}

function validCreds(body) {
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return { error: "Username must be 3–32 letters, numbers, dots, dashes or underscores." };
  if (password.length < 8 || password.length > 200) return { error: "Password must be at least 8 characters." };
  return { username, password };
}

function cleanTask(d) {
  if (!d || typeof d !== "object" || typeof d.title !== "string" || !d.title.trim()) return null;
  const str = (v, max) => typeof v === "string" ? v.slice(0, max) : null;
  return {
    title: d.title.trim().slice(0, 140),
    note: str(d.note, 2000) || "",
    time: /^\d{2}:\d{2}$/.test(d.time || "") ? d.time : null,
    repeat: ["once", "daily", "weekdays", "days"].includes(d.repeat) ? d.repeat : "once",
    days: Array.isArray(d.days) ? d.days.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [],
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? d.date : null,
    lastDone: /^\d{4}-\d{2}-\d{2}$/.test(d.lastDone || "") ? d.lastDone : null,
    doing: /^\d{4}-\d{2}-\d{2}$/.test(d.doing || "") ? d.doing : null,
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : Date.now(),
    by: str(d.by, 32)
  };
}

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const h = cors(req, env);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

  if (path === "/api/status" && req.method === "GET") {
    return json({ signupOpen: true }, 200, h);
  }

  if (path === "/api/register" && req.method === "POST") {
    const c = validCreds(await readJson(req));
    if (c.error) return json({ error: c.error }, 400, h);
    if (await limited(env, "reg:" + clientIp(req), 5, 3600e3)) return json({ error: TOO_MANY }, 429, h);
    const taken = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(c.username).first();
    if (taken) return json({ error: "That username is taken. Pick another one." }, 409, h);
    const id = crypto.randomUUID(), salt = randomToken(16);
    await env.DB.prepare("INSERT INTO users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, c.username, await hashPassword(c.password, salt), salt, Date.now()).run();
    return json({ token: await createSession(env, id), username: c.username, admin: (await ownerId(env)) === id }, 200, h);
  }

  if (path === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    if (await limited(env, "login:" + clientIp(req), 20, 900e3)) return json({ error: TOO_MANY }, 429, h);
    const user = await env.DB.prepare("SELECT id, username, pass_hash, salt FROM users WHERE username = ?")
      .bind(String(body?.username || "").trim()).first();
    // Hash even when the user is missing so response time doesn't reveal it.
    const hash = await hashPassword(String(body?.password || ""), user?.salt || "x");
    if (!user || !timingSafeEqual(hash, user.pass_hash)) return json({ error: "Wrong username or password." }, 401, h);
    return json({ token: await createSession(env, user.id), username: user.username, admin: (await ownerId(env)) === user.id }, 200, h);
  }

  const userId = await authUser(req, env);
  if (!userId) return json({ error: "Please sign in again." }, 401, h);

  if (path === "/api/logout" && req.method === "POST") {
    const token = (req.headers.get("Authorization") || "").slice(7);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, h);
  }

  if (path === "/api/me" && req.method === "GET") {
    const username = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(userId).first("username");
    return json({ username, admin: (await ownerId(env)) === userId }, 200, h);
  }

  // Feedback: anyone signed in can send it; only the owner can read or delete it.
  if (path === "/api/feedback" && req.method === "POST") {
    const message = String((await readJson(req))?.message || "").trim().slice(0, 2000);
    if (!message) return json({ error: "Write something first." }, 400, h);
    if (await limited(env, "fb:" + userId, 10, 3600e3)) return json({ error: TOO_MANY }, 429, h);
    const username = await env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(userId).first("username");
    await env.DB.prepare("INSERT INTO feedback (user_id, username, message, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, username, message, Date.now()).run();
    const owner = await ownerId(env);
    if (owner && owner !== userId) {
      try { await pushToUser(env, owner, { title: `Feedback from ${username}`, body: message.slice(0, 140), tag: "feedback" }); } catch {}
    }
    return json({ ok: true }, 200, h);
  }
  const fb = /^\/api\/feedback(?:\/(\d+))?$/.exec(path);
  if (fb && (req.method === "GET" || req.method === "DELETE")) {
    if ((await ownerId(env)) !== userId) return json({ error: "Not found" }, 404, h);
    if (req.method === "GET" && !fb[1]) {
      const { results } = await env.DB.prepare("SELECT id, username, message, created_at FROM feedback ORDER BY created_at DESC LIMIT 200").all();
      return json({ feedback: results }, 200, h);
    }
    if (req.method === "DELETE" && fb[1]) {
      await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(Number(fb[1])).run();
      return json({ ok: true }, 200, h);
    }
  }

  if (path.startsWith("/api/groups")) return groups(req, env, h, userId, path);

  if (path === "/api/tasks" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, data FROM tasks WHERE user_id = ?").bind(userId).all();
    return json({ tasks: results.map(r => ({ id: r.id, ...JSON.parse(r.data) })) }, 200, h);
  }

  const m = /^\/api\/tasks\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (m && req.method === "PUT") {
    const data = cleanTask(await readJson(req));
    if (!data) return json({ error: "A task needs a topic." }, 400, h);
    await env.DB.prepare(
      "INSERT INTO tasks (id, user_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).bind(m[1], userId, JSON.stringify(data), Date.now()).run();
    return json({ ok: true }, 200, h);
  }
  if (m && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?").bind(userId, m[1]).run();
    return json({ ok: true }, 200, h);
  }

  if (path === "/api/push" && req.method === "POST") {
    const b = await readJson(req);
    const endpoint = String(b?.endpoint || "");
    if (!/^https:\/\//.test(endpoint) || typeof b?.keys?.p256dh !== "string" || typeof b?.keys?.auth !== "string") return json({ error: "Invalid subscription." }, 400, h);
    let tz = String(b?.tz || "UTC");
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "UTC"; }
    await env.DB.prepare(
      "INSERT INTO push_subs (endpoint, user_id, p256dh, auth, tz, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz, updated_at = excluded.updated_at"
    ).bind(endpoint, userId, b.keys.p256dh, b.keys.auth, tz, Date.now()).run();
    return json({ ok: true }, 200, h);
  }
  if (path === "/api/push" && req.method === "DELETE") {
    const b = await readJson(req);
    await env.DB.prepare("DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?").bind(userId, String(b?.endpoint || "")).run();
    return json({ ok: true }, 200, h);
  }
  if (path === "/api/push/test" && req.method === "POST") {
    const sent = await pushToUser(env, userId, { title: "MyReminder", body: "Notifications are working.", tag: "test" });
    return json({ sent }, 200, h);
  }

  // School calendar: the iCal address is stored server-side; the app only ever gets the events.
  if (path === "/api/calendar" && req.method === "GET") {
    const calUrl = await env.DB.prepare("SELECT cal_url FROM settings WHERE user_id = ?").bind(userId).first("cal_url");
    if (!calUrl) return json({ connected: false, events: [] }, 200, h);
    const r = await calendarEvents(calUrl, url.searchParams);
    return json({ connected: true, ...r }, r.error ? 502 : 200, h);
  }
  if (path === "/api/calendar" && req.method === "PUT") {
    const calUrl = toIcsUrl((await readJson(req))?.url);
    if (!calUrl) return json({ error: "That doesn't look like a calendar link. Paste the iCal address (it ends in .ics)." }, 400, h);
    const r = await calendarEvents(calUrl, url.searchParams);
    if (r.error) return json({ error: r.error }, 400, h);
    await env.DB.prepare(
      "INSERT INTO settings (user_id, cal_url, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET cal_url = excluded.cal_url, updated_at = excluded.updated_at"
    ).bind(userId, calUrl, Date.now()).run();
    return json({ connected: true, ...r }, 200, h);
  }
  if (path === "/api/calendar" && req.method === "DELETE") {
    await env.DB.prepare("UPDATE settings SET cal_url = NULL, updated_at = ? WHERE user_id = ?").bind(Date.now(), userId).run();
    return json({ connected: false, events: [] }, 200, h);
  }

  return json({ error: "Not found" }, 404, h);
}

// ---------- groups ----------
// A group has its own shared board. Members join with an invite code, and every member can
// change its tasks; the owner can rename it, reset the code, remove people or delete it.

const MAX_GROUPS = 20, MAX_MEMBERS = 50;
const inviteCode = () => randomToken(9);
const groupName = v => typeof v === "string" ? v.trim().slice(0, 60) : "";

async function groupSummary(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT g.id, g.name, g.invite_code AS invite, m.role, (SELECT COUNT(*) FROM team_members x WHERE x.team_id = g.id) AS members " +
    "FROM teams g JOIN team_members m ON m.team_id = g.id WHERE m.user_id = ? ORDER BY g.created_at"
  ).bind(userId).all();
  return results;
}

async function groups(req, env, h, userId, path) {
  const tooMany = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?").bind(userId).first("n")) >= MAX_GROUPS;

  if (path === "/api/groups" && req.method === "GET") return json({ groups: await groupSummary(env, userId) }, 200, h);

  if (path === "/api/groups" && req.method === "POST") {
    const name = groupName((await readJson(req))?.name);
    if (!name) return json({ error: "Give the group a name." }, 400, h);
    if (await tooMany()) return json({ error: `You can be in at most ${MAX_GROUPS} groups.` }, 400, h);
    const id = crypto.randomUUID(), now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, userId, inviteCode(), now),
      env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(id, userId, now)
    ]);
    return json({ id, groups: await groupSummary(env, userId) }, 200, h);
  }

  if (path === "/api/groups/join" && req.method === "POST") {
    // Accept the bare code or a whole invite link.
    const raw = String((await readJson(req))?.code || "").trim();
    const code = (/[?&]join=([A-Za-z0-9_-]+)/.exec(raw) || [, raw])[1];
    if (await limited(env, "join:" + userId, 20, 3600e3)) return json({ error: TOO_MANY }, 429, h);
    const g = /^[A-Za-z0-9_-]{6,32}$/.test(code) && await env.DB.prepare("SELECT id FROM teams WHERE invite_code = ?").bind(code).first();
    if (!g) return json({ error: "That invite code doesn't work. Ask for a new link." }, 404, h);
    const already = await env.DB.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?").bind(g.id, userId).first();
    if (!already) {
      if (await tooMany()) return json({ error: `You can be in at most ${MAX_GROUPS} groups.` }, 400, h);
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?").bind(g.id).first("n");
      if (n >= MAX_MEMBERS) return json({ error: "This group is full." }, 400, h);
      await env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(g.id, userId, Date.now()).run();
    }
    return json({ id: g.id, groups: await groupSummary(env, userId) }, 200, h);
  }

  const m = /^\/api\/groups\/([0-9a-f-]{36})(\/.*)?$/.exec(path);
  if (!m) return json({ error: "Not found" }, 404, h);
  const gid = m[1], rest = m[2] || "";
  const role = await env.DB.prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?").bind(gid, userId).first("role");
  if (!role) return json({ error: "You're not in this group anymore." }, 404, h);
  const owner = role === "owner";

  if (rest === "" && req.method === "GET") {
    const g = await env.DB.prepare("SELECT id, name, invite_code AS invite FROM teams WHERE id = ?").bind(gid).first();
    const { results: members } = await env.DB.prepare(
      "SELECT u.username, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.role = 'owner' DESC, m.joined_at"
    ).bind(gid).all();
    return json({ ...g, role, members }, 200, h);
  }
  if (rest === "" && req.method === "PATCH") {
    if (!owner) return json({ error: "Only the group's owner can rename it." }, 403, h);
    const name = groupName((await readJson(req))?.name);
    if (!name) return json({ error: "Give the group a name." }, 400, h);
    await env.DB.prepare("UPDATE teams SET name = ? WHERE id = ?").bind(name, gid).run();
    return json({ ok: true }, 200, h);
  }
  if (rest === "" && req.method === "DELETE") {
    if (!owner) return json({ error: "Only the group's owner can delete it." }, 403, h);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM team_tasks WHERE team_id = ?").bind(gid),
      env.DB.prepare("DELETE FROM team_members WHERE team_id = ?").bind(gid),
      env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(gid)
    ]);
    return json({ groups: await groupSummary(env, userId) }, 200, h);
  }
  if (rest === "/invite" && req.method === "POST") {
    if (!owner) return json({ error: "Only the group's owner can reset the link." }, 403, h);
    const code = inviteCode();
    await env.DB.prepare("UPDATE teams SET invite_code = ? WHERE id = ?").bind(code, gid).run();
    return json({ invite: code }, 200, h);
  }
  const mm = /^\/members\/([A-Za-z0-9_.-]{3,32})$/.exec(rest);
  if (mm && req.method === "DELETE") {
    const target = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(mm[1]).first("id");
    if (!target) return json({ error: "Not found" }, 404, h);
    if (target !== userId && !owner) return json({ error: "Only the group's owner can remove people." }, 403, h);
    if (target === userId && owner) return json({ error: "You own this group. Delete it instead of leaving." }, 400, h);
    await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(gid, target).run();
    return json({ groups: await groupSummary(env, userId) }, 200, h);
  }

  if (rest === "/tasks" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, data FROM team_tasks WHERE team_id = ?").bind(gid).all();
    return json({ tasks: results.map(r => ({ id: r.id, ...JSON.parse(r.data) })) }, 200, h);
  }
  const tm = /^\/tasks\/([A-Za-z0-9_-]{1,64})$/.exec(rest);
  if (tm && req.method === "PUT") {
    const data = cleanTask(await readJson(req));
    if (!data) return json({ error: "A task needs a topic." }, 400, h);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE team_id = ?").bind(gid).first("n");
    if (n >= 1000) return json({ error: "This group has too many tasks. Delete some first." }, 400, h);
    await env.DB.prepare(
      "INSERT INTO team_tasks (team_id, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (team_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).bind(gid, tm[1], JSON.stringify(data), Date.now()).run();
    return json({ ok: true }, 200, h);
  }
  if (tm && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM team_tasks WHERE team_id = ? AND id = ?").bind(gid, tm[1]).run();
    return json({ ok: true }, 200, h);
  }
  return json({ error: "Not found" }, 404, h);
}

// ---------- school calendar ----------

const MAX_CAL_BYTES = 5 * 1024 * 1024;

// ?from=YYYY-MM-DD&days=N&tz=Zone → { events } or { error }.
async function calendarEvents(calUrl, q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get("from") || "") ? q.get("from") : new Date().toISOString().slice(0, 10);
  const days = Math.min(31, Math.max(1, parseInt(q.get("days") || "7", 10) || 7));
  const tz = validTz(q.get("tz") || "") ? q.get("tz") : "UTC";
  let res;
  try {
    res = await fetch(calUrl, { headers: { Accept: "text/calendar" }, redirect: "follow" });
  } catch { return { error: "Couldn't reach your calendar. Try again in a minute." }; }
  if (res.status === 404 || res.status === 403 || res.status === 401) {
    return { error: "Google won't share this calendar from that link. Use the “Secret address in iCal format” from the calendar's settings." };
  }
  if (!res.ok) return { error: `Your calendar answered with an error (${res.status}). Try again later.` };
  const text = await res.text();
  if (text.length > MAX_CAL_BYTES) return { error: "That calendar is too large to load." };
  if (!text.includes("BEGIN:VCALENDAR")) return { error: "That link isn't an iCal calendar. Paste the iCal address (it ends in .ics)." };
  return { events: eventsBetween(text, from, days, tz) };
}

// ---------- reminders ----------

async function pushToUser(env, userId, message) {
  const { results: subs } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").bind(userId).all();
  let sent = 0;
  for (const sub of subs) {
    try {
      const status = await sendPush(env, sub, message);
      if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run();
      else if (status < 300) sent++;
      else console.error("push failed", status, new URL(sub.endpoint).host);
    } catch (e) { console.error("push error", e); }
  }
  return sent;
}

function localNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday)
  };
}

// Same rules as the app's scheduledOn / isDone.
function dueToday(t, date, dow) {
  if (t.repeat === "daily") return t.lastDone !== date;
  if (t.repeat === "weekdays") return dow >= 1 && dow <= 5 && t.lastDone !== date;
  if (t.repeat === "days") return (t.days || []).includes(dow) && t.lastDone !== date;
  return t.date === date && !t.lastDone;
}

async function runReminders(env) {
  // Each user's clock comes from their most recently registered device.
  const { results } = await env.DB.prepare("SELECT user_id, tz FROM push_subs ORDER BY updated_at DESC").all();
  const users = new Map();
  for (const r of results) if (!users.has(r.user_id)) users.set(r.user_id, r.tz);

  for (const [userId, tz] of users) {
    const now = localNow(tz);
    // Their own tasks plus the tasks of every group they're in (group ids keep the sent keys apart).
    const { results: own } = await env.DB.prepare("SELECT id, data, NULL AS team FROM tasks WHERE user_id = ?").bind(userId).all();
    const { results: shared } = await env.DB.prepare(
      "SELECT t.id, t.data, g.name AS team, g.id AS team_id FROM team_tasks t JOIN team_members m ON m.team_id = t.team_id JOIN teams g ON g.id = t.team_id WHERE m.user_id = ?"
    ).bind(userId).all();
    for (const row of own.concat(shared)) {
      if (row.team_id) row.id = `g:${row.team_id}:${row.id}`;
      const t = JSON.parse(row.data);
      if (!t.time || !dueToday(t, now.date, now.dow)) continue;
      const [hh, mm] = t.time.split(":").map(Number);
      const late = now.minutes - (hh * 60 + mm);
      if (late < 0 || late > CATCH_UP_MINUTES) continue;
      // Claim the slot first so overlapping cron runs can't send twice.
      const claim = await env.DB.prepare("INSERT OR IGNORE INTO sent (user_id, task_id, slot, sent_at) VALUES (?, ?, ?, ?)")
        .bind(userId, row.id, `${now.date} ${t.time}`, Date.now()).run();
      if (!claim.meta.changes) continue;
      await pushToUser(env, userId, { title: row.team ? `${t.title} · ${row.team}` : t.title, body: t.note || `Due at ${t.time}`, tag: row.id });
    }
  }
  await env.DB.prepare("DELETE FROM sent WHERE sent_at < ?").bind(Date.now() - 3 * 864e5).run();
  await env.DB.prepare("DELETE FROM attempts WHERE window_start < ?").bind(Date.now() - 864e5).run();
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      console.error(e);
      return json({ error: "Server error. Try again." }, 500, cors(req, env));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  }
};
