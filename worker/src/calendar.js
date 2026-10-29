// School calendar: turn a Google Calendar link into an iCal feed, then expand its events
// (including weekly repeats, exceptions and moved lessons) for a range of days in the user's time zone.

// ---------- links ----------

// Accepts the iCal address itself, a webcal:// link, or Google's embed / "add calendar" links.
export function toIcsUrl(input) {
  let s = String(input || "").trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:/i, "https:");
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "calendar.google.com" && !/\/ical\//.test(u.pathname)) {
    let id = u.searchParams.get("src");
    const cid = u.searchParams.get("cid");
    if (!id && cid) { try { id = atob(cid.replace(/-/g, "+").replace(/_/g, "/")); } catch { id = cid; } }
    if (!id) return null;
    return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
  }
  return u.toString();
}

// ---------- dates as day numbers (days since 1970-01-01) ----------

function dayNum(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
function civil(n) {
  n += 719468;
  const era = Math.floor(n / 146097), doe = n - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
const dowOf = n => ((n % 7) + 11) % 7; // 0 = Sunday
const pad = n => String(n).padStart(2, "0");
const isoDay = n => { const c = civil(n); return `${c.y}-${pad(c.m)}-${pad(c.d)}`; };
const daysInMonth = (y, m) => civil(dayNum(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1).d;

// ---------- time zones ----------

const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
    }));
  }
  return fmts.get(tz);
}
export function validTz(tz) {
  try { fmt(tz); return true; } catch { return false; }
}
function wallClock(ms, tz) {
  const p = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = Number(x.value);
  return p;
}
function zonedToUtc(y, m, d, hh, mi, ss, tz) {
  const want = Date.UTC(y, m - 1, d, hh, mi, ss);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = wallClock(t, tz);
    t += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return t;
}

// ---------- parsing ----------

function parseLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ":" && !q) break;
  }
  const head = line.slice(0, i).split(";");
  const params = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}

const unescape = s => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// A DTSTART-style value: all-day date, UTC time, or wall time in a zone.
function parseWhen(value, params, fallbackTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(value || "");
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (!m[4] || params.VALUE === "DATE") return { allDay: true, day: dayNum(y, mo, d) };
  const tz = m[7] ? "UTC" : (params.TZID && validTz(params.TZID) ? params.TZID : fallbackTz);
  return { allDay: false, day: dayNum(y, mo, d), hh: +m[4], mi: +m[5], ss: +(m[6] || 0), tz };
}
const epochOn = (w, day) => { const c = civil(day); return zonedToUtc(c.y, c.m, c.d, w.hh, w.mi, w.ss, w.tz); };
// Identifies one occurrence for EXDATE / RECURRENCE-ID matching.
const occKey = (w, day) => w.allDay ? "d" + day : "t" + epochOn(w, day);

function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s || "");
  if (!m) return null;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function parseEvents(text, fallbackTz) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = { exdates: [] }; continue; }
    if (line === "END:VEVENT") { if (ev?.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const { name, params, value } = parseLine(line);
    if (name === "UID") ev.uid = value;
    else if (name === "SUMMARY") ev.title = unescape(value);
    else if (name === "LOCATION") ev.location = unescape(value);
    else if (name === "STATUS") ev.status = value.toUpperCase();
    else if (name === "DTSTART") ev.start = parseWhen(value, params, fallbackTz);
    else if (name === "DTEND") ev.end = parseWhen(value, params, fallbackTz);
    else if (name === "DURATION") ev.duration = parseDuration(value);
    else if (name === "RRULE") ev.rrule = Object.fromEntries(value.split(";").map(p => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
    else if (name === "EXDATE") for (const v of value.split(",")) { const w = parseWhen(v, params, fallbackTz); if (w) ev.exdates.push(w); }
    else if (name === "RECURRENCE-ID") ev.recurrenceId = parseWhen(value, params, fallbackTz);
  }
  return events;
}

// ---------- repeats ----------

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Does the rule produce an occurrence on day n? (Day-level rules only: no BYHOUR / BYSETPOS.)
function ruleMatcher(r, d0) {
  const interval = Math.max(1, parseInt(r.INTERVAL || "1", 10) || 1);
  const c0 = civil(d0);
  const byday = (r.BYDAY || "").split(",").filter(Boolean).map(s => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.toUpperCase());
    return m && { nth: m[1] ? parseInt(m[1], 10) : 0, dow: DOW[m[2]] };
  }).filter(Boolean);
  const bymonthday = (r.BYMONTHDAY || "").split(",").filter(Boolean).map(Number);
  const bymonth = (r.BYMONTH || "").split(",").filter(Boolean).map(Number);
  const weekStart = n => n - ((dowOf(n) + 6) % 7);

  const onMonthDay = (c, n) => {
    if (bymonthday.length) {
      const len = daysInMonth(c.y, c.m);
      return bymonthday.some(x => (x > 0 ? x : len + 1 + x) === c.d);
    }
    if (byday.length) {
      const dow = dowOf(n), len = daysInMonth(c.y, c.m);
      return byday.some(b => b.dow === dow && (!b.nth || (b.nth > 0 ? Math.ceil(c.d / 7) === b.nth : -Math.ceil((len - c.d + 1) / 7) === b.nth)));
    }
    return c.d === c0.d;
  };

  switch ((r.FREQ || "").toUpperCase()) {
    case "DAILY":
      return n => (n - d0) % interval === 0 && (!byday.length || byday.some(b => b.dow === dowOf(n))) && (!bymonth.length || bymonth.includes(civil(n).m));
    case "WEEKLY": {
      const days = byday.length ? byday.map(b => b.dow) : [dowOf(d0)];
      return n => days.includes(dowOf(n)) && ((weekStart(n) - weekStart(d0)) / 7) % interval === 0;
    }
    case "MONTHLY":
      return n => {
        const c = civil(n);
        return ((c.y - c0.y) * 12 + c.m - c0.m) % interval === 0 && onMonthDay(c, n);
      };
    case "YEARLY":
      return n => {
        const c = civil(n);
        if ((c.y - c0.y) % interval !== 0) return false;
        if (bymonth.length ? !bymonth.includes(c.m) : c.m !== c0.m) return false;
        return bymonth.length && (byday.length || bymonthday.length) ? onMonthDay(c, n) : c.d === c0.d;
      };
    default:
      return null;
  }
}

// Start days of an event that fall within [lo, hi].
function occurrenceDays(ev, lo, hi) {
  const d0 = ev.start.day;
  if (!ev.rrule) return d0 >= lo && d0 <= hi ? [d0] : [];
  const match = ruleMatcher(ev.rrule, d0);
  if (!match) return d0 >= lo && d0 <= hi ? [d0] : [];
  const count = parseInt(ev.rrule.COUNT || "0", 10) || 0;
  const until = ev.rrule.UNTIL ? parseWhen(ev.rrule.UNTIL, {}, "UTC") : null;
  const untilMs = until && !until.allDay ? epochOn(until, until.day) : null;
  const last = Math.min(hi, until ? until.day + 1 : Infinity);
  const out = [];
  let seen = 0;
  // With COUNT we must count from the first occurrence; otherwise we can start near the range.
  for (let n = count ? d0 : Math.max(d0, lo); n <= last; n++) {
    if (n !== d0 && !match(n)) continue;
    if (until) {
      if (untilMs != null && !ev.start.allDay ? epochOn(ev.start, n) > untilMs : n > until.day) break;
    }
    if (count && ++seen > count) break;
    if (n >= lo) out.push(n);
  }
  return out;
}

// ---------- public ----------

// Events from `fromDay` (YYYY-MM-DD) for `days` days, with times shown in `tz`.
export function eventsBetween(text, fromDay, days, tz) {
  const [y, m, d] = fromDay.split("-").map(Number);
  const first = dayNum(y, m, d), lastDay = first + days - 1;
  const events = parseEvents(text, tz);

  // Moved or cancelled single lessons replace that occurrence of the series.
  const replaced = new Set(), movedUids = new Set();
  for (const ev of events) {
    if (ev.recurrenceId && ev.uid) { replaced.add(ev.uid + "|" + occKey(ev.recurrenceId, ev.recurrenceId.day)); movedUids.add(ev.uid); }
  }

  const out = [];
  for (const ev of events) {
    if (ev.status === "CANCELLED") continue;
    const s = ev.start;
    const ex = new Set(ev.exdates.map(w => occKey(w, w.day)));
    // Look a day either side: a lesson's zone can put it on a different local date.
    for (const n of occurrenceDays(ev, first - 2, lastDay + 1)) {
      if (ev.rrule && !ev.recurrenceId && (ex.size || movedUids.has(ev.uid))) {
        const key = occKey(s, n);
        if (ex.has(key) || replaced.has(ev.uid + "|" + key)) continue;
      }
      const base = { title: ev.title || "(No title)", location: ev.location || "" };
      if (s.allDay) {
        const span = ev.end?.allDay ? Math.max(1, ev.end.day - s.day) : ev.duration ? Math.max(1, Math.round(ev.duration / 864e5)) : 1;
        for (let k = n; k < n + span; k++) if (k >= first && k <= lastDay) out.push({ ...base, date: isoDay(k), start: null, end: null });
        continue;
      }
      const startMs = epochOn(s, n);
      const endMs = ev.end && !ev.end.allDay ? startMs + (epochOn(ev.end, ev.end.day) - epochOn(s, s.day)) : startMs + (ev.duration ?? 0);
      const a = wallClock(startMs, tz), b = wallClock(endMs, tz);
      const date = `${a.year}-${pad(a.month)}-${pad(a.day)}`;
      const dn = dayNum(a.year, a.month, a.day);
      if (dn < first || dn > lastDay) continue;
      out.push({ ...base, date, start: `${pad(a.hour)}:${pad(a.minute)}`, end: endMs > startMs ? `${pad(b.hour)}:${pad(b.minute)}` : null });
    }
  }
  return out.sort((p, q) => p.date.localeCompare(q.date) || (p.start || "").localeCompare(q.start || "") || p.title.localeCompare(q.title));
}
