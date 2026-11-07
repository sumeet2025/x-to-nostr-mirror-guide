'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { generateSecretKey, getPublicKey, nip19, finalizeEvent } = require('nostr-tools');
const M = require('../src/core/mirror');
const D = require('../src/core/dates');
const R = require('../src/core/runner');
const { Store } = require('../src/core/store');
const { XClient } = require('../src/core/xapi');
const { importLegacyState } = require('../src/core/legacy');
const { backupBeforeUpgrade } = require('../src/core/upgrade');
const About = require('../src/core/about');
const F = require('./fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xnm2-'));
const ok2 = () => [{ url: 'a', ok: true }, { url: 'b', ok: true }];

test('stats: counts from ledger, imported history labelled separately, source date vs publish date', async () => {
  const T = F.fakeTimeline(); const ev = 'b'.repeat(64);
  const st = importLegacyState({ mirrored: { '5': ev, '6': ev }, newest_seen_id: '6' }).state;
  const sk = generateSecretKey();
  await M.processBatch(M.loadBatch([T.page]), st, F.JOB, { sign: (t) => finalizeEvent(t, sk), publish: async () => ok2(), saveState: () => {}, now: () => Date.parse('2026-11-07T12:00:00Z'), advanceCheckpoint: false });
  const s = M.stateStats(st);
  assert.equal(s.totalMirrored, 8); assert.equal(s.importedHistorical, 2); assert.equal(s.publishedByApp, 6);
  assert.equal(s.lastSourcePostAt, '2024-01-05T10:00:30.000Z', 'newest ORIGINAL X date');
  assert.equal(s.lastPublishAt, '2026-11-07T12:00:00.000Z', 'when the app published');
});

test('migration: v1 state file loads as v2 with every map preserved', () => {
  const store = new Store(tmp()); const job = store.upsertJob({ name: 'old' });
  const v1 = { version: 1, mirrored: { '10': 'a'.repeat(64) }, roots: { '10': 'a'.repeat(64) }, skipped: { '9': 'repost' }, failed: { '11': 'x' }, newest_seen_id: '10', backfill_done: true };
  fs.writeFileSync(path.join(store.jobDir(job.id), 'state.json'), JSON.stringify(v1));
  const st = store.loadState(job.id);
  assert.equal(st.version, 2); assert.deepEqual(st.mirrored, v1.mirrored); assert.deepEqual(st.skipped, v1.skipped); assert.deepEqual(st.failed, v1.failed);
  assert.equal(st.newest_seen_id, '10'); assert.equal(st.backfill_done, true); assert.deepEqual(st.pending, {}); assert.deepEqual(st.imported, {});
  assert.equal(M.stateStats(st).totalMirrored, 1);
});

test('upgrade: backup of configs + checkpoints before first v0.2 start; app identity unchanged', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'jobs.json'), '[{"id":"job-aaaaaa"}]'); fs.writeFileSync(path.join(dir, 'secrets.enc.json'), '{"x":"enc"}');
  fs.mkdirSync(path.join(dir, 'jobs', 'job-aaaaaa'), { recursive: true }); fs.writeFileSync(path.join(dir, 'jobs', 'job-aaaaaa', 'state.json'), '{"mirrored":{}}');
  const r = backupBeforeUpgrade(dir, '0.2.0');
  assert.equal(r.previous, '0.1.x'); assert.ok(fs.existsSync(path.join(r.backupDir, 'jobs.json'))); assert.ok(fs.existsSync(path.join(r.backupDir, 'jobs', 'job-aaaaaa', 'state.json')));
  assert.ok(fs.existsSync(path.join(dir, 'jobs.json')), 'originals untouched');
  assert.equal(backupBeforeUpgrade(dir, '0.2.0').backupDir, null, 'no repeat backup');
  assert.equal(backupBeforeUpgrade(tmp(), '0.2.0').backupDir, null, 'fresh install: nothing to back up');
  const pkg = require('../package.json');
  assert.equal(pkg.productName, 'X to Nostr Mirror'); assert.equal(pkg.build.appId, 'org.example.xnostrmirror'); // same userData + Keychain item as v0.1
});

test('interruption: signed event is persisted before sending and reused (same id) on retry', async () => {
  const T = F.fakeTimeline(); const page = { ...T.page, data: [T.a] }; const sk = generateSecretKey();
  let signs = 0; const snapshots = [];
  const sign = (t) => { signs++; return finalizeEvent(t, sk); };
  let st = M.emptyState();
  // attempt 1: process "crashes" during publish
  await assert.rejects(M.processBatch(M.loadBatch([page]), st, F.JOB, { sign, publish: async () => { throw Object.assign(new Error('crash'), { fatal: true }); }, saveState: (s) => snapshots.push(JSON.parse(JSON.stringify(s))) }).then((r) => { if (r.failed) throw new Error('failed as expected'); }));
  const persisted = snapshots[0]; assert.ok(persisted.pending[T.a.id], 'pending saved before publish');
  const firstId = persisted.pending[T.a.id].id;
  // attempt 2: only one relay acks (partial) -> still failed, same event
  st = M.migrateState(snapshots.at(-1)); const seen = [];
  const r2 = await M.processBatch(M.loadBatch([page]), st, F.JOB, { sign, publish: async (ev) => { seen.push(ev.id); return [{ url: 'a', ok: true }, { url: 'b', ok: false, msg: 'x' }]; }, saveState: () => {} });
  assert.equal(r2.failed, 1); assert.equal(r2.reused, 1); assert.equal(seen[0], firstId); assert.equal(st.mirrored[T.a.id], undefined);
  // attempt 3: success, same id, pending cleared, signed exactly once overall
  const r3 = await M.processBatch(M.loadBatch([page]), st, F.JOB, { sign, publish: async (ev) => { seen.push(ev.id); return ok2(); }, saveState: () => {} });
  assert.equal(r3.published, 1); assert.equal(seen[1], firstId); assert.equal(st.mirrored[T.a.id], firstId); assert.deepEqual(st.pending, {}); assert.equal(signs, 1);
});

test('dates: inclusive local days -> UTC, DST, validation, end clamped to the past', () => {
  const now = Date.parse('2026-11-07T15:00:00Z');
  assert.deepEqual(D.rangeToUtc({ from: '2026-01-10', to: '2026-01-10', timezone: 'Asia/Jerusalem' }, now), { startTime: '2026-01-09T22:00:00Z', endTime: '2026-01-10T21:59:59Z', timezone: 'Asia/Jerusalem' });
  assert.equal(D.rangeToUtc({ from: '2026-07-01', to: '2026-07-01', timezone: 'Asia/Jerusalem' }, now).startTime, '2026-06-30T21:00:00Z', 'summer time +3');
  assert.equal(D.rangeToUtc({ from: '2026-03-08', to: '2026-03-08', timezone: 'America/New_York' }, now).endTime, '2026-03-09T03:59:59Z', 'DST day is 23h');
  assert.equal(D.rangeToUtc({ from: '2026-05-01', timezone: 'UTC' }, now).endTime, undefined);
  assert.equal(D.rangeToUtc({ from: '2026-11-01', to: '2026-11-30', timezone: 'UTC' }, now).endTime, '2026-11-07T14:59:45Z', 'end clamped before now');
  assert.throws(() => D.rangeToUtc({ from: '2026-02-02', to: '2026-02-01', timezone: 'UTC' }, now), /on or before/);
  assert.throws(() => D.rangeToUtc({ from: '2026-12-01', timezone: 'UTC' }, now), /future/);
  assert.throws(() => D.rangeToUtc({ from: '2026-02-30', timezone: 'UTC' }, now), /Invalid date/);
  assert.throws(() => D.rangeToUtc({ from: '2026-01-01', timezone: 'Nowhere/X' }, now), /time zone/);
  assert.throws(() => D.rangeToUtc({}, now), /Choose/);
});

test('xapi: date range sends start_time/end_time and never since_id', async () => {
  const urls = [];
  const x = new XClient({ bearer: 'B'.repeat(30), fetchImpl: async (u) => { urls.push(new URL(u)); return { status: 200, headers: { get: () => null }, json: async () => ({ data: [], meta: {} }) }; } });
  await x.fetchAllSince('42', null, { startTime: '2026-01-09T22:00:00Z', endTime: '2026-01-10T21:59:59Z' });
  assert.equal(urls[0].searchParams.get('start_time'), '2026-01-09T22:00:00Z'); assert.equal(urls[0].searchParams.get('end_time'), '2026-01-10T21:59:59Z'); assert.equal(urls[0].searchParams.get('since_id'), null);
  assert.throws(() => x.userPostsPage('42', { sinceId: '5', startTime: '2026-01-01T00:00:00Z' }), /cannot be combined/);
});

function setup({ relayResult = ok2, xPages } = {}) {
  const store = new Store(tmp()); const sk = generateSecretKey();
  const job = store.upsertJob({ ...F.JOB, id: undefined, npub: nip19.npubEncode(getPublicKey(sk)), delayMs: 0 });
  const progress = []; const xcalls = [];
  const deps = { store, getSecret: (n) => (n.endsWith(':nsec') ? nip19.nsecEncode(sk) : 'B'.repeat(30)), sleepFn: async () => {},
    makeRelays: () => ({ publish: async (ev) => relayResult(ev), close() {} }), onProgress: (r) => progress.push(r),
    makeXClient: () => ({ calls: 1, userPostsPage: async () => ({ meta: {} }), fetchAllSince: async (id, since, o) => { xcalls.push({ since, ...o }); return { pages: xPages || [F.fakeTimeline().page], complete: true }; } }) };
  return { store, job, deps, progress, xcalls };
}

test('runner progress: stages + counts, durable run record, relay failure is reported as failed (no false success)', async () => {
  const { store, job, deps, progress } = setup({ relayResult: (ev) => (ev.content.startsWith('Photo') ? [{ url: 'a', ok: false, msg: 'down' }] : ok2()) });
  const r = await R.runJob(job.id, { mode: 'incremental' }, deps);
  assert.equal(r.ok, false); assert.equal(r.stats.published, 5); assert.equal(r.stats.failed, 1);
  assert.deepEqual([...new Set(progress.map((p) => p.stage))], ['fetching', 'publishing', 'done']);
  const last = progress.at(-1); assert.equal(last.status, 'failed'); assert.equal(last.counts.completed, 5); assert.equal(last.counts.failed, 1); assert.equal(last.counts.selected, 6);
  const att = progress.filter((p) => p.stage === 'publishing').map((p) => p.counts.attempted); assert.deepEqual(att, [...att].sort((a, b) => a - b), 'monotonic');
  assert.equal(store.loadRun(job.id).status, 'failed'); assert.match(store.loadRun(job.id).message, /5 of 6/);
  assert.equal(M.stateStats(store.loadState(job.id)).failed, 1);
});

test('restart: run left "running" by a dead process becomes "interrupted"; live run untouched', () => {
  const { store, job } = setup();
  store.saveRun(job.id, { runId: 'r1', status: 'running', stage: 'publishing', counts: {} });
  fs.writeFileSync(path.join(store.jobDir(job.id), 'run.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.deepEqual(store.markInterruptedRuns(), [job.id]); assert.equal(store.loadRun(job.id).status, 'interrupted');
  const j2 = store.upsertJob({ name: 'live' }); store.saveRun(j2.id, { status: 'running' });
  fs.writeFileSync(path.join(store.jobDir(j2.id), 'run.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  store.markInterruptedRuns(); assert.equal(store.loadRun(j2.id).status, 'running', 'another live process still owns it');
});

test('cancel: stops cleanly, reports cancelled, checkpoint not advanced past unprocessed posts, resume publishes rest', async () => {
  const { store, job, deps } = setup(); let n = 0;
  const r = await R.runJob(job.id, { mode: 'incremental' }, { ...deps, shouldStop: () => n++ > 2 });
  assert.equal(r.stats.stopped, true); assert.equal(store.loadRun(job.id).status, 'cancelled');
  const st = store.loadState(job.id); const done = Object.keys(st.mirrored).length; assert.ok(done >= 1 && done < 6);
  const r2 = await R.runJob(job.id, { mode: 'incremental' }, deps);
  assert.equal(Object.keys(store.loadState(job.id).mirrored).length, 6); assert.equal(r2.stats.already, done);
});

test('range mode: uses start/end time, ignores and never moves the checkpoint', async () => {
  const { store, job, deps, xcalls } = setup();
  const st = store.loadState(job.id); st.newest_seen_id = '5'; store.saveState(job.id, st);
  const r = await R.runJob(job.id, { mode: 'range', range: { from: '2024-01-01', to: '2024-01-05', timezone: 'UTC' } }, deps);
  assert.equal(r.ok, true); assert.equal(xcalls[0].since, null); assert.equal(xcalls[0].startTime, '2024-01-01T00:00:00Z'); assert.equal(xcalls[0].endTime, '2024-01-05T23:59:59Z');
  assert.equal(store.loadState(job.id).newest_seen_id, '5', 'checkpoint unchanged');
  const bad = await R.runJob(job.id, { mode: 'range', range: { from: '2024-02-01', to: '2024-01-01', timezone: 'UTC' } }, deps);
  assert.match(bad.error, /on or before/);
});

test('about: author npub valid, QR decodes to nostr:npub, external links allowlisted only', async () => {
  const jsQR = require('jsqr'); const { PNG } = require('pngjs');
  const a = await About.aboutInfo();
  assert.equal(a.npub, 'npub19dfd7w8zxfdfywqmqxpt92wq6tx4p0mvfqv6yuyg0cv9d7duj4uskuccks');
  const png = PNG.sync.read(Buffer.from(a.qr.split(',')[1], 'base64'));
  assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height).data, 'nostr:' + a.npub);
  assert.equal(About.externalUrl('authorProfile'), 'https://njump.me/' + a.npub);
  assert.throws(() => About.externalUrl('https://evil.example'), /not allowed/);
  assert.throws(() => About.externalUrl('__proto__'), /not allowed/);
  if (About.GUIDE_URL) assert.match(About.externalUrl('guide'), /^https:\/\/github\.com\//); else assert.throws(() => About.externalUrl('guide'), /Not available/);
});
