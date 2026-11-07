'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { WebSocketServer } = require('ws');
const { generateSecretKey, getPublicKey, nip19, verifyEvent } = require('nostr-tools');
const { XClient } = require('../src/core/xapi');
const S = require('../src/core/schedule');
const { Store } = require('../src/core/store');
const { SecretStore } = require('../src/core/secrets');
const L = require('../src/core/launchd');
const { importLegacyState } = require('../src/core/legacy');
const { RelaySet, validateRelayUrl } = require('../src/core/relays');
const R = require('../src/core/runner');
const F = require('./fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xnm-'));

function fakeFetch(routes, log = []) {
  return async (url, init) => {
    log.push({ url, auth: init.headers.Authorization });
    const r = routes.shift(); if (!r) throw new Error('unexpected call ' + url);
    const h = new Map(Object.entries(r.headers || {}));
    return { status: r.status || 200, headers: { get: (k) => h.get(k) ?? null }, json: async () => r.body, text: async () => JSON.stringify(r.body || '') };
  };
}

test('xapi: refuses non-X base URL; validates handle', () => {
  assert.throws(() => new XClient({ bearer: 't'.repeat(30), baseUrl: 'https://evil.example' }), /Refusing/);
  assert.throws(() => new XClient({ bearer: '' }), /missing/);
  const x = new XClient({ bearer: 't'.repeat(30), fetchImpl: fakeFetch([]) });
  return assert.rejects(x.lookupUser('bad handle!'), /Invalid X handle/);
});
test('xapi: lookup by handle/url, since_id pagination, 429 waits for reset then retries, 401 message', async () => {
  const log = []; const slept = [];
  const reset = Math.floor(Date.now() / 1000) + 30;
  const x = new XClient({ bearer: 'B'.repeat(30), sleepFn: async (ms) => slept.push(ms), fetchImpl: fakeFetch([
    { body: { data: { id: '42', username: 'fake' } } },
    { status: 429, headers: { 'x-rate-limit-reset': String(reset) } },
    { body: { data: [{ id: '5' }], meta: { next_token: 'N1' } } },
    { body: { data: [{ id: '4' }], meta: {} } },
    { status: 401, body: {} },
  ], log) });
  assert.equal((await x.lookupUser('https://x.com/fake')).id, '42');
  assert.ok(log[0].url.endsWith('/2/users/by/username/fake?user.fields=name%2Cusername%2Cprofile_image_url%2Cdescription'));
  const r = await x.fetchAllSince('42', '3');
  assert.equal(r.pages.length, 2); assert.equal(r.complete, true);
  assert.ok(slept[0] > 1000 && slept[0] <= 31000);
  const u = new URL(log[2].url); assert.equal(u.searchParams.get('since_id'), '3'); assert.ok(u.searchParams.get('expansions').includes('referenced_tweets.id'));
  assert.equal(new URL(log[3].url).searchParams.get('pagination_token'), 'N1');
  assert.equal(log[0].auth, 'Bearer ' + 'B'.repeat(30));
  await assert.rejects(x.userPostsPage('42'), /401/);
});

test('schedule: start time, interval, active hours in timezone, catch-up after sleep', () => {
  const s = { enabled: true, startAt: '2026-01-01T06:00:00Z', intervalMinutes: 180, timezone: 'Asia/Jerusalem', activeHours: { from: 8, to: 23 } };
  assert.equal(S.nextRun(s, Date.parse('2025-12-01T00:00:00Z')), Date.parse('2026-01-01T06:00:00Z')); // 08:00 Jerusalem
  assert.equal(S.nextRun(s, Date.parse('2026-01-01T06:00:00Z')), Date.parse('2026-01-01T09:00:00Z'));
  // 21:00Z = 23:00 local ok; 00:00Z = 02:00 local skipped -> next 06:00Z
  assert.equal(S.nextRun(s, Date.parse('2026-01-01T21:00:00Z')), Date.parse('2026-01-02T06:00:00Z'));
  assert.equal(S.isDue(s, Date.parse('2026-01-01T06:01:00Z'), Date.parse('2026-01-01T08:59:00Z')), false);
  assert.equal(S.isDue(s, Date.parse('2026-01-01T06:01:00Z'), Date.parse('2026-01-03T12:00:00Z')), true, 'missed slots -> run once');
  assert.equal(S.isDue({ ...s, enabled: false }, 0, Date.parse('2026-02-01T00:00:00Z')), false);
  assert.equal(S.isDue(s, null, Date.parse('2025-12-31T00:00:00Z')), false, 'never before start');
  assert.throws(() => S.validateSchedule({ ...s, intervalMinutes: 5 }), /Interval/);
  assert.throws(() => S.validateSchedule({ ...s, timezone: 'Mars/Base' }), /timezone/);
});

test('store: per-job state isolation, atomic save, lock non-overlap and stale lock recovery', () => {
  const st = new Store(tmp());
  const a = st.upsertJob({ name: 'a' }); const b = st.upsertJob({ name: 'b' });
  const sa = st.loadState(a.id); sa.mirrored['1'] = 'x'; st.saveState(a.id, sa);
  assert.deepEqual(st.loadState(b.id).mirrored, {});
  const rel = st.acquireLock(a.id); assert.ok(rel); assert.equal(st.acquireLock(a.id), null); assert.ok(st.acquireLock(b.id));
  rel(); const rel2 = st.acquireLock(a.id); assert.ok(rel2); rel2();
  fs.writeFileSync(path.join(st.jobDir(a.id), 'run.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.ok(st.acquireLock(a.id), 'dead-pid lock reclaimed');
  assert.throws(() => st.jobDir('../etc'), /bad job id/);
});

function fakeSafe({ avail = true, backend = 'gnome_libsecret' } = {}) {
  return { isEncryptionAvailable: () => avail, getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString() };
}
test('secrets: encrypted at rest, fail closed without keyring or with basic_text', () => {
  const d = tmp(); const f = path.join(d, 's.json');
  const ss = new SecretStore(f, fakeSafe(), 'linux'); ss.set('job:x:nsec', 'nsec1secretvalue');
  assert.ok(!fs.readFileSync(f, 'utf8').includes('nsec1secretvalue')); assert.equal(ss.get('job:x:nsec'), 'nsec1secretvalue');
  assert.throws(() => new SecretStore(f, fakeSafe({ backend: 'basic_text' }), 'linux').set('a', 'b'), /plaintext/);
  assert.throws(() => new SecretStore(f, fakeSafe({ avail: false }), 'darwin').get('a'), /unavailable/);
  assert.equal(new SecretStore(f, fakeSafe({ backend: 'basic_text' }), 'darwin').available().ok, true, 'macOS uses Keychain');
});

test('launchd: plist uses dynamic exec path, escapes, no RunAtLoad', () => {
  const args = L.programArgsFor({ execPath: '/Applications/X to Nostr Mirror.app/Contents/MacOS/X to Nostr Mirror', appPath: '/x', isPackaged: true });
  const xml = L.plistXml({ programArgs: [...args, 'a&b'], intervalSeconds: 900, logDir: '/tmp/l' });
  assert.ok(xml.includes('<string>/Applications/X to Nostr Mirror.app/Contents/MacOS/X to Nostr Mirror</string>'));
  assert.ok(xml.includes('a&amp;b')); assert.ok(xml.includes('<key>RunAtLoad</key><false/>')); assert.ok(xml.includes('--run-due'));
  assert.deepEqual(L.programArgsFor({ execPath: '/e', appPath: '/src', isPackaged: false }), ['/e', '/src', '--run-due']);
  assert.throws(() => L.plistXml({ programArgs: ['/e'], intervalSeconds: 10, logDir: '/t' }));
});

test('legacy import: copies maps + watermark, drops malformed entries, never keys', () => {
  const ev = 'a'.repeat(64);
  const r = importLegacyState({ mirrored: { '10': ev, '11': 'notanid', bad: ev }, roots: { '10': ev }, skipped: { '9': 'repost' }, csv_posted: { '12': ev }, failed: { '13': 'x' }, newest_seen_id: '12', nsec: 'nsec1shouldnotcopy' });
  assert.deepEqual(r.state.mirrored, { '10': ev }); assert.equal(r.state.skipped['12'], 'posted_by_csv'); assert.equal(r.state.newest_seen_id, '12');
  assert.equal(r.imported, 1); assert.equal(r.pendingFailed, 1); assert.ok(!JSON.stringify(r.state).includes('nsec1'));
  assert.throws(() => importLegacyState({}), /mirrored/);
});

test('relay URL validation', () => {
  assert.equal(validateRelayUrl('wss://nos.lol/'), 'wss://nos.lol');
  assert.throws(() => validateRelayUrl('ws://relay.example')); assert.throws(() => validateRelayUrl('https://x')); assert.throws(() => validateRelayUrl('wss://u:p@h'));
  assert.throws(() => validateRelayUrl('ws://127.0.0.1:7777'));
  assert.equal(validateRelayUrl('ws://127.0.0.1:7777', { allowLoopbackWs: true }), 'ws://127.0.0.1:7777');
});

// Minimal NIP-01 relay on loopback for end-to-end tests (accepts or rejects EVENTs).
function startRelay(accept = true) {
  return new Promise((res) => {
    const got = []; const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => res({ url: `ws://127.0.0.1:${wss.address().port}`, got, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) }));
    wss.on('connection', (ws) => ws.on('message', (m) => { const msg = JSON.parse(m); if (msg[0] === 'EVENT') { got.push(msg[1]); ws.send(JSON.stringify(['OK', msg[1].id, accept && verifyEvent(msg[1]), accept ? '' : 'blocked: test'])); } }));
  });
}

test('end-to-end runner: fake X API + 3 loopback relays (one rejecting), lock, checkpoint, incremental rerun, scheduler gating', async () => {
  const relays = [await startRelay(), await startRelay(), await startRelay(false)];
  const store = new Store(tmp()); const sk = generateSecretKey(); const nsec = nip19.nsecEncode(sk); const npub = nip19.npubEncode(getPublicKey(sk));
  const job = store.upsertJob({ ...F.JOB, id: undefined, npub, relays: relays.map((r) => r.url), minRelayOk: 2, delayMs: 0, firstRun: 'backfill' });
  const T = F.fakeTimeline(); const secretsMap = { [`job:${job.id}:nsec`]: nsec, 'x:default:bearer': 'B'.repeat(30) };
  const sinceSeen = [];
  const deps = { store, getSecret: (n) => secretsMap[n] || null, sleepFn: async () => {},
    makeRelays: (urls) => new RelaySet(urls.map((u) => validateRelayUrl(u, { allowLoopbackWs: true })), { connectTimeout: 2000, publishTimeout: 2000 }),
    makeXClient: () => ({ calls: 1, userPostsPage: async () => ({ meta: {} }), fetchAllSince: async (_id, since) => { sinceSeen.push(since); return { pages: since ? [{ meta: { result_count: 0 } }] : [T.page], complete: true }; } }) };
  try {
    const dry = await R.runJob(job.id, { mode: 'backfill', dryRun: true }, deps);
    assert.equal(dry.items.filter((i) => i.status === 'publish').length, 6); assert.equal(relays[0].got.length, 0, 'preview never publishes');
    const release = store.acquireLock(job.id); const locked = await R.runJob(job.id, { mode: 'incremental' }, deps); release();
    assert.equal(locked.locked, true);
    const r1 = await R.runJob(job.id, { mode: 'backfill' }, deps);
    assert.equal(r1.ok, true, r1.error); assert.equal(r1.stats.published, 6);
    assert.equal(relays[0].got.length, 6); assert.ok(relays[0].got.every((e) => e.pubkey === getPublicKey(sk) && verifyEvent(e)));
    assert.equal(relays[0].got[0].created_at, Date.parse('2024-01-01T10:00:00Z') / 1000, 'backdated');
    const st = store.loadState(job.id); assert.equal(st.backfill_done, true); assert.ok(st.newest_seen_id);
    const r2 = await R.runJob(job.id, { mode: 'incremental' }, deps);
    assert.equal(r2.stats.published, 0); assert.equal(sinceSeen.at(-1), st.newest_seen_id);
    assert.equal(fs.readFileSync(path.join(store.jobDir(job.id), 'events.jsonl'), 'utf8').trim().split('\n').length, 6);
    // scheduler: not run unless schedule enabled AND publishEnabled
    store.upsertJob({ ...store.getJob(job.id), schedule: { enabled: true, startAt: '2020-01-01T00:00:00Z', intervalMinutes: 60 }, publishEnabled: false, lastRunAt: 0 });
    assert.equal((await R.runDueJobs(deps)).length, 0);
    store.upsertJob({ ...store.getJob(job.id), publishEnabled: true, lastRunAt: 0 });
    assert.equal((await R.runDueJobs(deps)).length, 1);
    // wrong key fails closed
    secretsMap[`job:${job.id}:nsec`] = nip19.nsecEncode(generateSecretKey());
    const T2 = F.fakeTimeline(); T2.page.data = [{ ...T2.a, id: F.idAt('2025-01-01T00:00:00Z'), created_at: '2025-01-01T00:00:00.000Z' }];
    const bad = await R.runJob(job.id, { mode: 'import', responses: [T2.page], trigger: 'schedule' }, deps);
    assert.match(bad.error, /does not match/); assert.equal(relays[0].got.length, 6);
    assert.ok(store.getJob(job.id).consecutiveFailures >= 1); assert.ok(R.backoffUntil(store.getJob(job.id)) > Date.now());
    assert.ok(!fs.readFileSync(path.join(store.jobDir(job.id), 'log.txt'), 'utf8').includes('nsec1'), 'no secrets in logs');
  } finally { for (const r of relays) await r.close(); }
});

test('first run "new_only" only sets checkpoint', async () => {
  const store = new Store(tmp()); const job = store.upsertJob({ ...F.JOB, id: undefined, npub: nip19.npubEncode(getPublicKey(generateSecretKey())), firstRun: 'new_only' });
  const deps = { store, getSecret: () => 'B'.repeat(30), makeRelays: () => { throw new Error('should not publish'); },
    makeXClient: () => ({ userPostsPage: async () => ({ meta: { newest_id: '777' } }), fetchAllSince: async () => { throw new Error('no'); } }) };
  const r = await R.runJob(job.id, { mode: 'incremental' }, deps);
  assert.equal(r.checkpointOnly, true); assert.equal(store.loadState(job.id).newest_seen_id, '777');
});
