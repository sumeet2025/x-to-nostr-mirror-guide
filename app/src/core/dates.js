'use strict';
// Convert inclusive local calendar dates (YYYY-MM-DD) in an IANA time zone to X API start_time/end_time (UTC ISO).
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - utcMs;
}
// UTC ms of local midnight starting `dateStr` in tz (handles DST by iterating).
function zonedMidnightUtc(dateStr, tz) {
  if (!DATE.test(dateStr)) throw new Error('Dates must be YYYY-MM-DD');
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d);
  if (new Date(naive).getUTCDate() !== d) throw new Error('Invalid date ' + dateStr);
  let t = naive - tzOffsetMs(naive, tz);
  t = naive - tzOffsetMs(t, tz);
  return t;
}
const nextDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
/** Returns { startTime, endTime } ISO strings (no milliseconds) for the X API, or throws a user-facing error. */
function rangeToUtc({ from, to, timezone }, now = Date.now()) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (_) { throw new Error('Unknown time zone ' + tz); }
  if (!from && !to) throw new Error('Choose a start or end date');
  const start = from ? zonedMidnightUtc(from, tz) : null;
  let end = to ? zonedMidnightUtc(nextDay(to), tz) - 1000 : null; // inclusive end of day
  if (start !== null && end !== null && start > end) throw new Error('Start date must be on or before end date');
  if (start !== null && start > now) throw new Error('Start date is in the future');
  const latest = now - 15000; // X requires end_time at least ~10 s in the past
  if (end !== null && end > latest) end = latest;
  const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  return { startTime: start !== null ? iso(start) : undefined, endTime: end !== null ? iso(end) : undefined, timezone: tz };
}
module.exports = { rangeToUtc, zonedMidnightUtc, tzOffsetMs };
