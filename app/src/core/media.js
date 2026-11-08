'use strict';
// Optional local export of selected posts (JSON) and their picture/video files to a folder the user picks.
// This never uploads anything and never changes what is published to Nostr (notes keep linking to X's CDN).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const MEDIA_HOSTS = ['pbs.twimg.com', 'video.twimg.com'];
const MAX_REDIRECTS = 3;

function validateMediaUrl(u, hosts = MEDIA_HOSTS) {
  let x; try { x = new URL(u); } catch (_) { throw new Error('Invalid media URL'); }
  const loopTest = hosts !== MEDIA_HOSTS && x.protocol === 'http:' && x.hostname === '127.0.0.1'; // tests inject their own host list
  if (x.protocol !== 'https:' && !loopTest) throw new Error('Media URL must be https');
  if (x.username || x.password) throw new Error('Media URL must not contain credentials');
  if (net.isIP(x.hostname) && !loopTest) throw new Error('IP-address media URLs are not allowed');
  if (!hosts.includes(x.hostname) && !(loopTest && hosts.includes(x.host))) throw new Error('Media host not allowed: ' + x.hostname);
  if (x.port && !loopTest) throw new Error('Custom ports are not allowed');
  return x.href;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4' };
function extFromUrl(u, fallback) {
  const p = new URL(u).pathname.toLowerCase(); const m = p.match(/\.(jpe?g|png|gif|webp|mp4)$/);
  const fmt = new URL(u).searchParams.get('format');
  return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : fmt && /^(jpg|png|webp|gif)$/.test(fmt) ? fmt : fallback;
}

/**
 * List media for the selected posts. quality: 'highest' | 'lowest' MP4 bitrate.
 * Item status: 'ok' | 'hls_only' (stream-only video, not downloadable as one file) | 'missing'.
 */
function collectMedia(batch, xids, { quality = 'highest' } = {}) {
  const items = []; const seen = new Set();
  for (const xid of xids) {
    const t = batch.posts[xid]; if (!t) continue;
    (t.attachments?.media_keys || []).forEach((k, i) => {
      const m = batch.media[k];
      const base = { xid, mediaKey: k, index: i + 1 };
      if (!m) { items.push({ ...base, status: 'missing', type: 'unknown', note: 'Media details not returned by the API' }); return; }
      let url, contentType, variant = null;
      if (m.type === 'photo') {
        url = m.url; if (url) { const e = extFromUrl(url, 'jpg'); contentType = 'image/' + (e === 'jpg' ? 'jpeg' : e); }
      } else {
        const mp4 = (m.variants || []).filter((v) => v.content_type === 'video/mp4' && v.url).sort((a, b) => (a.bit_rate || 0) - (b.bit_rate || 0));
        if (!mp4.length) {
          const hls = (m.variants || []).some((v) => /mpegurl/i.test(v.content_type || ''));
          items.push({ ...base, status: hls ? 'hls_only' : 'missing', type: m.type, note: hls ? 'Only a streaming (HLS) version is available; not downloadable as a single file' : 'No downloadable file' });
          return;
        }
        variant = quality === 'lowest' ? mp4[0] : mp4[mp4.length - 1];
        url = variant.url; contentType = 'video/mp4';
      }
      if (!url) { items.push({ ...base, status: 'missing', type: m.type, note: 'No URL' }); return; }
      try { url = validateMediaUrl(url); } catch (e) { items.push({ ...base, status: 'missing', type: m.type, note: e.message }); return; }
      if (seen.has(url)) return; seen.add(url);
      const ext = m.type === 'photo' ? extFromUrl(url, 'jpg') : 'mp4';
      items.push({ ...base, status: 'ok', type: m.type, url, contentType, bitrate: variant?.bit_rate || null,
        filename: `${xid}_${i + 1}${m.type === 'animated_gif' ? '_gif' : ''}.${ext}`, size: null, sizeSource: null });
    });
  }
  return items;
}

// Fetch with manual redirects, every hop validated; never sends auth headers or cookies.
async function safeFetch(url, init, { fetchImpl = globalThis.fetch, hosts = MEDIA_HOSTS } = {}) {
  let u = validateMediaUrl(url, hosts);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetchImpl(u, { ...init, redirect: 'manual', credentials: 'omit', headers: { 'User-Agent': 'x-nostr-mirror', ...(init.headers || {}) } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try { res.body && res.body.cancel && await res.body.cancel(); } catch (_) {}
      u = validateMediaUrl(new URL(res.headers.get('location'), u).href, hosts); continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

/** Estimate size: HEAD Content-Length, else a 1-byte Range request (Content-Range total). Body is never read. */
async function probeSize(url, opts = {}) {
  const timeout = opts.timeoutMs || 10000;
  try {
    const h = await safeFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeout) }, opts);
    const len = Number(h.headers.get('content-length'));
    if (h.ok && Number.isFinite(len) && len > 0) return { size: len, source: 'HEAD Content-Length' };
  } catch (_) {}
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await safeFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ac.signal }, opts);
    const cr = r.headers.get('content-range'); const m = cr && cr.match(/^bytes\s+0-0\/(\d+)$/i);
    ac.abort(); // never download the body (also if the server ignored Range and sent 200)
    if (r.status === 206 && m) return { size: Number(m[1]), source: 'Range Content-Range' };
    return { size: null, source: r.ok ? 'server did not report size' : 'HTTP ' + r.status };
  } catch (e) { return { size: null, source: 'unreachable: ' + (e.name === 'AbortError' ? 'timeout' : e.message) }; }
  finally { clearTimeout(timer); }
}

async function estimate(items, opts = {}) {
  const ok = items.filter((i) => i.status === 'ok');
  let idx = 0;
  const worker = async () => { while (idx < ok.length) { const it = ok[idx++]; const r = await probeSize(it.url, opts); it.size = r.size; it.sizeSource = r.source; } };
  await Promise.all(Array.from({ length: Math.min(4, ok.length) }, worker));
  return summarize(items);
}
function summarize(items) {
  const ok = items.filter((i) => i.status === 'ok');
  return { files: ok.length, knownBytes: ok.reduce((s, i) => s + (i.size || 0), 0), knownCount: ok.filter((i) => i.size).length,
    unknownCount: ok.filter((i) => !i.size).length, hlsOnly: items.filter((i) => i.status === 'hls_only').length, missing: items.filter((i) => i.status === 'missing').length };
}

// ---------- folder + files ----------
const slug = (s) => String(s || 'profile').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'profile';
function insideDir(dir, name) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name.startsWith('.')) throw new Error('Unsafe file name');
  const p = path.resolve(dir, name);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error('Path escapes the export folder');
  return p;
}
function exportDir(root, job) {
  if (!path.isAbsolute(root)) throw new Error('Choose a folder first');
  const d = path.join(root, `${slug(job.sourceUsername || job.name)}-${job.id}`);
  fs.mkdirSync(path.join(d, 'media'), { recursive: true });
  return d;
}
function readManifest(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return { format: 'x-nostr-mirror-export', version: 1, files: {} }; } }
function writeManifest(dir, m) { const f = path.join(dir, 'manifest.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1)); fs.renameSync(f + '.tmp', f); }
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return null; } }

/** Write the selected posts' API data (no credentials) as posts-<timestamp>.json. */
function exportPosts(dir, batch, xids, job, now = Date.now()) {
  const data = xids.map((id) => batch.posts[id]).filter(Boolean);
  const keys = new Set(data.flatMap((t) => t.attachments?.media_keys || []));
  const out = { format: 'x-nostr-mirror-posts', exportedAt: new Date(now).toISOString(), source: { username: job.sourceUsername, userId: job.sourceUserId },
    data, includes: { media: Object.values(batch.media).filter((m) => keys.has(m.media_key)) } };
  const name = `posts-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
  const p = insideDir(dir, name);
  fs.writeFileSync(p, JSON.stringify(out, null, 1), { flag: 'wx' });
  return { file: name, posts: data.length };
}

/**
 * Stream files into <dir>/media. Skips files already completed (manifest), never overwrites a different
 * existing file (adds -2, -3...), writes to .part and renames on success, deletes .part on failure/cancel.
 * Limits: maxTotalBytes, maxFileBytes, concurrency, per-file timeout.
 */
async function downloadAll(items, dir, opts = {}) {
  const { maxTotalBytes = 5 * 1024 ** 3, maxFileBytes = 2 * 1024 ** 3, concurrency = 2, timeoutMs = 10 * 60e3, onProgress, shouldStop } = opts;
  const mdir = path.join(dir, 'media'); fs.mkdirSync(mdir, { recursive: true });
  const manifest = readManifest(dir);
  const ok = items.filter((i) => i.status === 'ok');
  const st = { total: ok.length, completed: 0, skipped: 0, failed: 0, cancelled: 0, bytes: 0, results: [] };
  const known = ok.reduce((s, i) => s + (i.size || 0), 0);
  const free = freeBytes(mdir);
  if (free !== null && known > free - 200 * 1024 ** 2) throw new Error('Not enough free disk space for the known sizes');
  const emit = () => onProgress && onProgress({ ...st, results: undefined, remaining: st.total - st.completed - st.skipped - st.failed - st.cancelled });
  let idx = 0;
  const one = async (it) => {
    const prev = manifest.files[it.url];
    if (prev && prev.status === 'done' && fs.existsSync(path.join(mdir, prev.file)) && fs.statSync(path.join(mdir, prev.file)).size === prev.bytes) { st.skipped++; st.results.push({ url: it.url, status: 'already' }); return; }
    if (shouldStop && shouldStop()) { st.cancelled++; return; }
    let name = it.filename; let n = 2;
    while (fs.existsSync(insideDir(mdir, name)) || fs.existsSync(insideDir(mdir, name + '.part'))) name = it.filename.replace(/(\.\w+)$/, `-${n++}$1`);
    const final = insideDir(mdir, name); const part = final + '.part';
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
    let fh; let bytes = 0; const hash = crypto.createHash('sha256');
    try {
      const res = await safeFetch(it.url, { method: 'GET', signal: ac.signal }, opts);
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const ct = (res.headers.get('content-type') || '').split(';')[0];
      if (ct && !/^(image|video)\//.test(ct) && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') throw new Error('Unexpected content type ' + ct);
      fh = fs.openSync(part, 'wx');
      for await (const chunk of res.body) {
        if (shouldStop && shouldStop()) throw Object.assign(new Error('cancelled'), { cancelled: true });
        bytes += chunk.length; st.bytes += chunk.length;
        if (bytes > maxFileBytes) throw new Error('File larger than the per-file limit');
        if (st.bytes > maxTotalBytes) throw new Error('Total download limit reached');
        hash.update(chunk); fs.writeSync(fh, chunk); emit();
      }
      fs.closeSync(fh); fh = null;
      fs.linkSync(part, final); fs.unlinkSync(part); // link fails if final appeared meanwhile: no silent overwrite
      manifest.files[it.url] = { file: name, xid: it.xid, mediaKey: it.mediaKey, type: it.type, bytes, sha256: hash.digest('hex'), status: 'done', at: new Date().toISOString() };
      st.completed++; st.results.push({ url: it.url, status: 'done', file: name, bytes });
    } catch (e) {
      if (fh) try { fs.closeSync(fh); } catch (_) {}
      try { fs.unlinkSync(part); } catch (_) {}
      st.bytes -= bytes;
      if (e.cancelled || (shouldStop && shouldStop())) st.cancelled++;
      else { st.failed++; manifest.files[it.url] = { file: null, xid: it.xid, status: 'failed', error: String(e.message).slice(0, 200), at: new Date().toISOString() }; st.results.push({ url: it.url, status: 'failed', error: e.message }); }
    } finally { clearTimeout(timer); writeManifest(dir, manifest); emit(); }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ok.length) }, async () => { while (idx < ok.length) await one(ok[idx++]); }));
  emit();
  return st;
}
module.exports = { MEDIA_HOSTS, validateMediaUrl, collectMedia, probeSize, estimate, summarize, exportDir, exportPosts, downloadAll, insideDir, readManifest, slug };
