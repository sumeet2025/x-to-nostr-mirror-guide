'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSecretKey, getPublicKey, nip19, verifyEvent, finalizeEvent } = require('nostr-tools');
const { bytesToHex } = require('@noble/hashes/utils');
const K = require('../src/core/nostrkeys');
const M = require('../src/core/mirror');
const F = require('./fixtures');

test('keys: nsec/hex derive npub; npub rejected as secret; mismatch detected', () => {
  const sk = generateSecretKey(); const pk = getPublicKey(sk);
  const nsec = nip19.nsecEncode(sk); const npub = nip19.npubEncode(pk);
  assert.equal(K.parseSecretKey(nsec).npub, npub);
  assert.equal(K.parseSecretKey(bytesToHex(sk)).pk, pk);
  assert.throws(() => K.parseSecretKey(npub), /public key/);
  assert.throws(() => K.parsePublicKey(nsec), /SECRET/);
  assert.throws(() => K.parseSecretKey('nsec1garbage'), /valid nsec/);
  assert.equal(K.verifyKeyPair(nsec, npub).npub, npub);
  assert.throws(() => K.verifyKeyPair(nsec, nip19.npubEncode(getPublicKey(generateSecretKey()))), /does not match/);
});

test('classify: default policy matches legacy mirror', () => {
  const T = F.fakeTimeline(); const cls = M.classifyAll(M.loadBatch([T.page]), M.emptyState(), F.SRC);
  assert.equal(cls[T.a.id].kind, 'original');
  assert.equal(cls[T.b.id].kind, 'thread_reply'); assert.equal(cls[T.c.id].parentXid, T.b.id);
  assert.equal(cls[T.rt.id].reason, 'repost');
  assert.equal(cls[T.rep.id].reason, 'reply_to_other_account');
  assert.equal(cls[T.q.id].kind, 'quote');
  assert.equal(cls[T.orphan.id].kind, 'orphan_self_thread');
});
test('classify: optional reposts / replies-to-others / disabled thread', () => {
  const T = F.fakeTimeline();
  const cls = M.classifyAll(M.loadBatch([T.page]), M.emptyState(), F.SRC, { ...M.DEFAULT_POLICY, repost: true, replyToOthers: true, selfThread: false });
  assert.equal(cls[T.rt.id].kind, 'repost'); assert.equal(cls[T.rep.id].kind, 'reply_to_other'); assert.equal(cls[T.b.id].reason, 'self_thread_disabled');
});

test('content: t.co expanded, media to imeta, quote url, backdating', () => {
  const T = F.fakeTimeline(); const batch = M.loadBatch([T.page]); const st = M.emptyState();
  const cls = M.classifyAll(batch, st, F.SRC);
  const a = M.buildEventTemplate(T.a, cls[T.a.id], batch, st, { username: 'fake' });
  assert.match(a.content, /Hello world https:\/\/example.org\/page/);
  assert.match(a.content, new RegExp(`Originally on X: https://x.com/fake/status/${T.a.id}$`));
  assert.equal(a.created_at, Date.parse('2024-01-01T10:00:00Z') / 1000);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(M.buildEventTemplate(T.a, cls[T.a.id], batch, st, { username: 'fake', timestampMode: 'current', now }).created_at, now / 1000);
  const m = M.buildEventTemplate(T.m, cls[T.m.id], batch, st, { username: 'fake' });
  assert.ok(m.content.includes('https://pbs.twimg.com/media/fake.jpg')); assert.ok(!m.content.includes('t.co'));
  assert.deepEqual(m.tags.find((t) => t[0] === 'imeta'), ['imeta', 'url https://pbs.twimg.com/media/fake.jpg', 'm image/jpeg']);
  const q = M.buildEventTemplate(T.q, cls[T.q.id], batch, st, { username: 'fake' });
  assert.ok(q.content.includes(`https://x.com/other/status/${T.otherTweet.id}`)); assert.ok(!q.content.includes('t.co'));
  const b = M.buildEventTemplate(T.b, cls[T.b.id], batch, st, { username: 'fake' });
  assert.ok(b.content.startsWith('second in thread'));
});

function fakeDeps(okRelays) {
  const sk = generateSecretKey(); const saved = []; const events = [];
  return { sk, saved, events, deps: { sign: (t) => finalizeEvent(t, sk), publish: async (ev) => { events.push(ev); return okRelays(ev); }, saveState: (s) => saved.push(JSON.parse(JSON.stringify(s))) } };
}
const allOk = () => [{ url: 'a', ok: true }, { url: 'b', ok: true }];

test('process: publishes oldest-first with NIP-10 thread tags, signatures valid, idempotent on rerun', async () => {
  const T = F.fakeTimeline(); const batch = M.loadBatch([T.page]); const st = M.emptyState(); const f = fakeDeps(allOk);
  const s = await M.processBatch(batch, st, F.JOB, f.deps);
  assert.equal(s.published, 6); assert.equal(s.skipped, 2); assert.equal(s.failed, 0);
  assert.ok(f.events.every(verifyEvent));
  const order = f.events.map((e) => e.created_at); assert.deepEqual(order, [...order].sort((x, y) => x - y));
  const evC = f.events.find((e) => e.content.startsWith('third'));
  assert.deepEqual(evC.tags.filter((t) => t[0] === 'e'), [['e', st.mirrored[T.a.id], '', 'root'], ['e', st.mirrored[T.b.id], '', 'reply']]);
  assert.equal(st.newest_seen_id, T.m.id > T.orphan.id ? T.m.id : T.orphan.id);
  const again = await M.processBatch(batch, st, F.JOB, f.deps);
  assert.equal(again.published, 0); assert.equal(again.already, 6); assert.equal(f.events.length, 6);
});

test('process: checkpoint stops before a failed post; replay later publishes it and dependent reply', async () => {
  const T = F.fakeTimeline(); const batch = M.loadBatch([T.page]); const st = M.emptyState();
  let fail = true;
  const f = fakeDeps((ev) => (fail && ev.content.startsWith('Hello') ? [{ url: 'a', ok: true }, { url: 'b', ok: false, msg: 'rate-limited' }] : allOk()));
  const s1 = await M.processBatch(batch, st, F.JOB, f.deps);
  assert.equal(s1.failed, 1); assert.equal(s1.deferred, 2); assert.equal(st.mirrored[T.a.id], undefined);
  assert.ok(st.newest_seen_id === null || BigInt(st.newest_seen_id) < BigInt(T.a.id), 'checkpoint must not pass the failed post');
  assert.ok(st.failed[T.a.id]); assert.equal(st.failed[T.b.id], 'parent_not_mirrored_yet');
  fail = false;
  const s2 = await M.processBatch(batch, st, F.JOB, f.deps);
  assert.equal(s2.published, 3); assert.deepEqual(st.failed, {});
  assert.ok(f.saved.length > 3, 'state saved after each outcome');
});

test('process: minRelayOk respected, onlyIds selection blocks checkpoint', async () => {
  const T = F.fakeTimeline(); const batch = M.loadBatch([T.page]); const st = M.emptyState();
  const f = fakeDeps(allOk);
  const s = await M.processBatch(batch, st, { ...F.JOB, minRelayOk: 3 }, f.deps);
  assert.equal(s.published, 0); assert.equal(s.failed, 4); assert.equal(st.newest_seen_id, null);
  const st2 = M.emptyState(); const s2 = await M.processBatch(batch, st2, F.JOB, { ...f.deps, onlyIds: [T.a.id] });
  assert.equal(s2.published, 1); assert.equal(st2.newest_seen_id, T.a.id);
});

test('parseResponsesText accepts object, array, and tool-output style text', () => {
  const T = F.fakeTimeline(); const j = JSON.stringify(T.page);
  assert.equal(M.parseResponsesText(j).length, 1); assert.equal(M.parseResponsesText('[' + j + ',' + j + ']').length, 2);
  assert.equal(M.parseResponsesText('header\n' + j + '\nfooter').length, 1);
});
