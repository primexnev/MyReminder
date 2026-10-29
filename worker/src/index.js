// MyReminder API: accounts, sessions and task sync on Cloudflare D1.
// Only one account can ever be created; after that, sign-up is closed.

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 180;

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

  return json({ error: "Not found" }, 404, h);
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      console.error(e);
      return json({ error: "Server error. Try again." }, 500, cors(req, env));
    }
  }
};
