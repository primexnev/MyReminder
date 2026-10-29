// MyReminder API: accounts, sessions and task sync on Cloudflare D1, plus reminder pushes from a cron.
// Only one account can ever be created; after that, sign-up is closed.

import { b64url, sendPush } from "./push.js";

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
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : Date.now()
  };
}

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const h = cors(req, env);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

  if (path === "/api/status" && req.method === "GET") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n");
    return json({ signupOpen: n === 0 }, 200, h);
  }

  if (path === "/api/register" && req.method === "POST") {
    const c = validCreds(await readJson(req));
    if (c.error) return json({ error: c.error }, 400, h);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first("n");
    if (n > 0) return json({ error: "Sign-up is closed. Sign in with your existing account." }, 403, h);
    const id = crypto.randomUUID(), salt = randomToken(16);
    await env.DB.prepare("INSERT INTO users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, c.username, await hashPassword(c.password, salt), salt, Date.now()).run();
    return json({ token: await createSession(env, id), username: c.username }, 200, h);
  }

  if (path === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const user = await env.DB.prepare("SELECT id, username, pass_hash, salt FROM users WHERE username = ?")
      .bind(String(body?.username || "").trim()).first();
    // Hash even when the user is missing so response time doesn't reveal it.
    const hash = await hashPassword(String(body?.password || ""), user?.salt || "x");
    if (!user || !timingSafeEqual(hash, user.pass_hash)) return json({ error: "Wrong username or password." }, 401, h);
    return json({ token: await createSession(env, user.id), username: user.username }, 200, h);
  }

  const userId = await authUser(req, env);
  if (!userId) return json({ error: "Please sign in again." }, 401, h);

  if (path === "/api/logout" && req.method === "POST") {
    const token = (req.headers.get("Authorization") || "").slice(7);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, h);
  }

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

  return json({ error: "Not found" }, 404, h);
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
    const { results: rows } = await env.DB.prepare("SELECT id, data FROM tasks WHERE user_id = ?").bind(userId).all();
    for (const row of rows) {
      const t = JSON.parse(row.data);
      if (!t.time || !dueToday(t, now.date, now.dow)) continue;
      const [hh, mm] = t.time.split(":").map(Number);
      const late = now.minutes - (hh * 60 + mm);
      if (late < 0 || late > CATCH_UP_MINUTES) continue;
      // Claim the slot first so overlapping cron runs can't send twice.
      const claim = await env.DB.prepare("INSERT OR IGNORE INTO sent (user_id, task_id, slot, sent_at) VALUES (?, ?, ?, ?)")
        .bind(userId, row.id, `${now.date} ${t.time}`, Date.now()).run();
      if (!claim.meta.changes) continue;
      await pushToUser(env, userId, { title: t.title, body: t.note || `Due at ${t.time}`, tag: row.id });
    }
  }
  await env.DB.prepare("DELETE FROM sent WHERE sent_at < ?").bind(Date.now() - 3 * 864e5).run();
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
