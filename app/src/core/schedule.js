'use strict';
// schedule: { enabled, startAt (ISO), intervalMinutes, timezone (IANA, optional), activeHours: {from:0-23,to:0-23} optional }
function hourIn(date, tz) {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || undefined }).format(date);
  return Number(h) % 24;
}
function inWindow(date, s) {
  if (!s.activeHours) return true;
  const { from, to } = s.activeHours; const h = hourIn(date, s.timezone);
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
}
function validateSchedule(s) {
  if (!s || typeof s !== 'object') throw new Error('schedule missing');
  const iv = Number(s.intervalMinutes);
  if (!Number.isFinite(iv) || iv < 15 || iv > 7 * 24 * 60) throw new Error('Interval must be between 15 minutes and 7 days');
  if (!s.startAt || Number.isNaN(Date.parse(s.startAt))) throw new Error('Start date/time is invalid');
  if (s.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); } catch (_) { throw new Error('Unknown timezone'); } }
  if (s.activeHours) { const { from, to } = s.activeHours; if (![from, to].every((x) => Number.isInteger(x) && x >= 0 && x <= 23)) throw new Error('Active hours must be 0-23'); }
  return true;
}
// Next run time strictly after `after` (ms) on the grid startAt + k*interval, inside active hours.
function nextRun(s, after = Date.now()) {
  if (!s || !s.enabled) return null;
  validateSchedule(s);
  const start = Date.parse(s.startAt); const step = s.intervalMinutes * 60000;
  let t = after < start ? start : start + (Math.floor((after - start) / step) + 1) * step;
  for (let i = 0; i < 5000; i++, t += step) if (inWindow(new Date(t), s)) return t;
  return null;
}
// Is a run due? (missed slot since lastRunAt -> catch up once, e.g. after sleep)
function isDue(s, lastRunAt, now = Date.now()) {
  if (!s || !s.enabled) return false;
  const start = Date.parse(s.startAt); if (now < start) return false;
  const from = lastRunAt ? Math.max(lastRunAt, start - 1) : start - 1;
  const n = nextRun(s, from);
  return n !== null && n <= now;
}
module.exports = { nextRun, isDue, validateSchedule, inWindow };
