'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const Md = require('../src/core/media');
const M = require('../src/core/mirror');
const F = require('./fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xnm-media-'));

function batchWithMedia() {
  const T = F.fakeTimeline();
  const v = { ...T.a, id: F.idAt('2024-02-01T00:00:00Z'), attachments: { media_keys: ['7_1', '3_1', '7_2', '16_1', '9_9'] } };
  const dup = { ...T.a, id: F.idAt('2024-02-02T00:00:00Z'), attachments: { media_keys: ['3_1'] } };
  const media = [
    { media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/fake.png' },
    { media_key: '7_1', type: 'video', variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' }, { content_type: 'video/mp4', bit_rate: 256000, url: 'https://video.twimg.com/low.mp4' }, { content_type: 'video/mp4', bit_rate: 2176000, url: 'https://video.twimg.com/high.mp4' }] },
    { media_key: '7_2', type: 'video', variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/only.m3u8' }] },
    { media_key: '16_1', type: 'animated_gif', variants: [{ content_type: 'video/mp4', bit_rate: 0, url: 'https://video.twimg.com/tweet_video/g.mp4' }] },
  ];
  return { batch: M.loadBatch([{ data: [v, dup, T.b], includes: { media } }]), v, dup, T };
}

test('media: variant selection (highest/lowest MP4), HLS-only, GIF as mp4, missing, dedupe, filenames, selected posts only', () => {
  const { batch, v, dup, T } = batchWithMedia();
  const hi = Md.collectMedia(batch, [v.id, dup.id]);
  const by = (k) => hi.find((i) => i.mediaKey === k);
  assert.equal(by('7_1').url, 'https://video.twimg.com/high.mp4'); assert.equal(by('7_1').filename, `${v.id}_1.mp4`);
  assert.equal(by('3_1').contentType, 'image/png'); assert.equal(by('3_1').filename, `${v.id}_2.png`);
  assert.equal(by('7_2').status, 'hls_only'); assert.equal(by('16_1').filename, `${v.id}_4_gif.mp4`); assert.equal(by('9_9').status, 'missing');
  assert.equal(hi.filter((i) => i.url === 'https://pbs.twimg.com/media/fake.png').length, 1, 'same URL only once');
  assert.equal(Md.collectMedia(batch, [v.id], { quality: 'lowest' }).find((i) => i.mediaKey === '7_1').url, 'https://video.twimg.com/low.mp4');
  assert.equal(Md.collectMedia(batch, [T.b.id]).length, 0, 'unselected posts ignored');
  const s = Md.summarize(hi); assert.deepEqual([s.files, s.hlsOnly, s.missing, s.unknownCount], [3, 1, 1, 3]);
});

test('media: URL allowlist (https, X media hosts only, no IPs/ports/credentials)', () => {
  assert.equal(Md.validateMediaUrl('https://pbs.twimg.com/media/a.jpg'), 'https://pbs.twimg.com/media/a.jpg');
  for (const u of ['http://pbs.twimg.com/a.jpg', 'https://evil.example/a.jpg', 'https://pbs.twimg.com.evil.example/a', 'https://127.0.0.1/a', 'https://u:p@pbs.twimg.com/a', 'https://pbs.twimg.com:8443/a', 'file:///etc/passwd'])
    assert.throws(() => Md.validateMediaUrl(u), undefined, u);
  assert.throws(() => Md.validateMediaUrl('http://127.0.0.1:9/a'), /https/, 'loopback only allowed when a test injects its host list');
});

function server(routes) {
  return new Promise((res) => {
    const log = [];
    const s = http.createServer((req, r) => { log.push({ method: req.method, url: req.url, range: req.headers.range, auth: req.headers.authorization }); (routes[req.url] || ((q, w) => { w.writeHead(404); w.end(); }))(req, r); });
    s.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, host: `127.0.0.1:${s.address().port}`, log, close: () => new Promise((c) => { s.closeAllConnections(); s.close(c); }) }));
  });
}
const big = Buffer.alloc(300000, 7);

test('probe: HEAD length, Range fallback, range ignored (aborted, unknown), HEAD failure, redirect host validation, no auth header', async () => {
  let ignoredSent = 0;
  const S = await server({
    '/head.jpg': (q, w) => { w.writeHead(200, { 'content-length': '12345', 'content-type': 'image/jpeg' }); w.end(q.method === 'HEAD' ? undefined : 'x'); },
    '/range.mp4': (q, w) => { if (q.method === 'HEAD') { w.writeHead(405); return w.end(); } w.writeHead(206, { 'content-range': 'bytes 0-0/987654', 'content-type': 'video/mp4' }); w.end('x'); },
    '/ignore.mp4': (q, w) => { if (q.method === 'HEAD') { w.writeHead(200, { 'content-type': 'video/mp4' }); return w.end(); } w.writeHead(200, { 'content-type': 'video/mp4' }); const iv = setInterval(() => { if (!w.write(big)) {} ignoredSent += big.length; if (ignoredSent > 50e6) { clearInterval(iv); w.end(); } }, 1); w.on('close', () => clearInterval(iv)); },
    '/redir': (q, w) => { w.writeHead(302, { location: 'https://evil.example/x.jpg' }); w.end(); },
    '/redir-ok': (q, w) => { w.writeHead(302, { location: '/head.jpg' }); w.end(); },
  });
  const o = { hosts: [S.host] };
  try {
    assert.deepEqual(await Md.probeSize(S.base + '/head.jpg', o), { size: 12345, source: 'HEAD Content-Length' });
    assert.deepEqual(await Md.probeSize(S.base + '/range.mp4', o), { size: 987654, source: 'Range Content-Range' });
    const ig = await Md.probeSize(S.base + '/ignore.mp4', o); assert.equal(ig.size, null);
    await new Promise((r) => setTimeout(r, 200)); assert.ok(ignoredSent < 20e6, 'body not consumed when server ignores Range: ' + ignoredSent);
    assert.equal((await Md.probeSize(S.base + '/redir', o)).size, null, 'redirect to non-allowed host refused');
    assert.equal((await Md.probeSize(S.base + '/redir-ok', o)).size, 12345);
    assert.equal((await Md.probeSize(S.base + '/nothing', o)).size, null);
    assert.ok(S.log.every((l) => !l.auth));
    assert.equal(S.log.find((l) => l.url === '/range.mp4' && l.method === 'GET').range, 'bytes=0-0');
  } finally { await S.close(); }
});

test('download: streams to folder, manifest idempotent, no overwrite, caps, failures clean .part, cancel', async () => {
  const S = await server({
    '/a.jpg': (q, w) => { w.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '5' }); w.end('hello'); },
    '/b.mp4': (q, w) => { w.writeHead(200, { 'content-type': 'video/mp4' }); w.end(big); },
    '/html': (q, w) => { w.writeHead(200, { 'content-type': 'text/html' }); w.end('<html>'); },
    '/broken.mp4': (q, w) => { w.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '999999' }); w.write(big.subarray(0, 1000)); setTimeout(() => w.destroy(), 20); },
  });
  const o = { hosts: [S.host] };
  const it = (p, fn) => ({ xid: '1', mediaKey: 'k' + p, type: 'photo', status: 'ok', url: S.base + p, filename: fn });
  try {
    const root = tmp(); const job = { id: 'job-abc123', sourceUsername: 'Fake User!' }; const dir = Md.exportDir(root, job);
    assert.equal(path.basename(dir), 'fake-user-job-abc123');
    fs.writeFileSync(path.join(dir, 'media', '1_1.jpg'), 'existing user file');
    const r1 = await Md.downloadAll([it('/a.jpg', '1_1.jpg'), it('/b.mp4', '1_2.mp4'), it('/html', '1_3.jpg'), it('/broken.mp4', '1_4.mp4')], dir, o);
    assert.equal(r1.completed, 2); assert.equal(r1.failed, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'media', '1_1.jpg'), 'utf8'), 'existing user file', 'not overwritten');
    assert.equal(fs.readFileSync(path.join(dir, 'media', '1_1-2.jpg'), 'utf8'), 'hello');
    assert.equal(fs.statSync(path.join(dir, 'media', '1_2.mp4')).size, big.length);
    assert.ok(!fs.readdirSync(path.join(dir, 'media')).some((f) => f.endsWith('.part')), 'no .part left');
    const man = Md.readManifest(dir); assert.equal(man.files[S.base + '/a.jpg'].bytes, 5); assert.equal(man.files[S.base + '/html'].status, 'failed');
    const r2 = await Md.downloadAll([it('/a.jpg', '1_1.jpg'), it('/b.mp4', '1_2.mp4')], dir, o);
    assert.equal(r2.skipped, 2); assert.equal(r2.completed, 0, 'idempotent');
    const capped = await Md.downloadAll([it('/b.mp4', 'cap.mp4')], tmp(), { ...o, maxTotalBytes: 1000 });
    assert.equal(capped.failed, 1);
    const d3 = tmp(); let stop = false;
    const c = await Md.downloadAll([it('/b.mp4', 'c1.mp4'), it('/a.jpg', 'c2.jpg')], d3, { ...o, concurrency: 1, shouldStop: () => stop, onProgress: (p) => { if (p.bytes > 0) stop = true; } });
    assert.ok(c.cancelled >= 1); assert.ok(!fs.readdirSync(path.join(d3, 'media')).some((f) => f.endsWith('.part')));
    assert.throws(() => Md.insideDir(dir, '../x.jpg'), /Unsafe/); assert.throws(() => Md.insideDir(dir, '.hidden'), /Unsafe/);
    assert.throws(() => Md.exportDir('relative/path', job), /folder/);
  } finally { await S.close(); }
});

test('export posts JSON: selected posts only, no secrets, never overwrites', () => {
  const { batch, v, T } = batchWithMedia(); const dir = tmp();
  const job = { id: 'job-abc123', sourceUsername: 'fake', sourceUserId: F.SRC, npub: 'npub1x', downloadFolder: dir };
  const r = Md.exportPosts(dir, batch, [v.id], job, Date.parse('2026-01-01T00:00:00Z'));
  const j = JSON.parse(fs.readFileSync(path.join(dir, r.file), 'utf8'));
  assert.deepEqual(j.data.map((p) => p.id), [v.id]); assert.equal(j.includes.media.length, 4);
  assert.ok(!/nsec|bearer|token|npub/i.test(JSON.stringify(j))); assert.ok(!JSON.stringify(j).includes(T.b.text));
  assert.throws(() => Md.exportPosts(dir, batch, [v.id], job, Date.parse('2026-01-01T00:00:00Z')), /EEXIST/);
});

test('publishing unchanged: notes still link CDN media with imeta (no re-hosting)', () => {
  const { batch, v } = batchWithMedia(); const st = M.emptyState();
  const t = M.buildEventTemplate(v, { kind: 'original' }, batch, st, { username: 'fake' });
  assert.ok(t.content.includes('https://video.twimg.com/high.mp4')); assert.ok(t.tags.some((x) => x[0] === 'imeta' && x[1] === 'url https://pbs.twimg.com/media/fake.png'));
});
