'use strict';
// Classification + Nostr note building + idempotent processing. Adapted from the author's own
// local x->nostr mirror scripts (same author, relicensed MIT here).
const big = (s) => BigInt(s);
const maxId = (a, b) => (!a ? b : !b ? a : big(a) > big(b) ? a : b);
const cmpId = (a, b) => (big(a) < big(b) ? -1 : big(a) > big(b) ? 1 : 0);

const DEFAULT_POLICY = { original: true, quote: true, selfThread: true, orphanSelfThread: true, repost: false, replyToOthers: false };

const STATE_VERSION = 2;
function emptyState() {
  return { version: STATE_VERSION, mirrored: {}, roots: {}, skipped: {}, failed: {}, imported: {}, pending: {}, newest_seen_id: null, newest_mirrored_id: null,
    backfill_done: false, last_source_post_at: null, last_publish_at: null };
}
// Upgrade older state files in place (never drops data). v1 -> v2 adds imported/pending/timestamps.
function migrateState(st) {
  const out = { ...emptyState(), ...st };
  for (const k of ['mirrored', 'roots', 'skipped', 'failed', 'imported', 'pending']) out[k] = { ...(st[k] || {}) };
  out.version = STATE_VERSION;
  return out;
}
// Counts derived from the dedupe ledger (unique X ids with a confirmed Nostr event).
function stateStats(st) {
  const mirrored = Object.keys(st.mirrored || {});
  const imported = mirrored.filter((k) => st.imported && st.imported[k]).length;
  return { totalMirrored: mirrored.length, publishedByApp: mirrored.length - imported, importedHistorical: imported,
    skipped: Object.keys(st.skipped || {}).length, failed: Object.keys(st.failed || {}).length, pendingSigned: Object.keys(st.pending || {}).length,
    lastSourcePostAt: st.last_source_post_at || null, lastPublishAt: st.last_publish_at || null, checkpoint: st.newest_seen_id || null, backfillDone: Boolean(st.backfill_done) };
}

function loadBatch(responses) {
  const posts = {}, media = {}, incTweets = {}, users = {};
  for (const r of responses) {
    if (!r || typeof r !== 'object') continue;
    for (const t of r.data || []) posts[t.id] = t;
    for (const m of r.includes?.media || []) media[m.media_key] = m;
    for (const t of r.includes?.tweets || []) incTweets[t.id] = t;
    for (const u of r.includes?.users || []) users[u.id] = u;
  }
  return { posts, media, incTweets, users };
}
// Accept a raw API response, array of them, or text with a JSON object on its own line.
function parseResponsesText(txt) {
  try { const j = JSON.parse(txt); return Array.isArray(j) ? j : [j]; } catch (_) {}
  const line = txt.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('No JSON object found');
  return [JSON.parse(line)];
}

const msOf = (id) => Number(BigInt(id) >> 22n) + 1288834974657;
const otherThread = (r) => r === 'reply_to_other_account' || r === 'self_reply_in_other_thread';

function classifyAll(batch, state, sourceUserId, policy = DEFAULT_POLICY) {
  const { posts, incTweets } = batch;
  const memo = {};
  const cls = (t) => {
    if (memo[t.id]) return memo[t.id];
    memo[t.id] = { mirror: false, reason: 'cycle' };
    const refs = t.referenced_tweets || [];
    let res;
    const rp = refs.find((r) => r.type === 'replied_to');
    const quoted = refs.find((r) => r.type === 'quoted');
    if (t.author_id && t.author_id !== sourceUserId) res = { mirror: false, reason: 'not_own_post' };
    else if (refs.some((r) => r.type === 'retweeted')) res = policy.repost ? { mirror: true, kind: 'repost' } : { mirror: false, reason: 'repost' };
    else if (!rp) res = quoted ? (policy.quote ? { mirror: true, kind: 'quote' } : { mirror: false, reason: 'quote_disabled' })
      : (policy.original ? { mirror: true, kind: 'original' } : { mirror: false, reason: 'original_disabled' });
    else {
      let base;
      if (posts[rp.id]) {
        const pc = cls(posts[rp.id]);
        base = pc.mirror ? { mirror: true, kind: 'thread_reply', parentXid: rp.id }
          : { mirror: false, reason: otherThread(pc.reason) ? 'self_reply_in_other_thread' : 'thread_root_unavailable' };
      } else if (state.mirrored[rp.id]) base = { mirror: true, kind: 'thread_reply', parentXid: rp.id };
      else if (state.skipped[rp.id]) base = { mirror: false, reason: otherThread(state.skipped[rp.id]) ? 'self_reply_in_other_thread' : 'thread_root_unavailable' };
      else if (incTweets[rp.id]) base = incTweets[rp.id].author_id === sourceUserId ? { mirror: false, reason: 'thread_root_unavailable' } : { mirror: false, reason: 'reply_to_other_account' };
      else {
        const d = msOf(t.id) - msOf(rp.id);
        base = d >= 0 && d < 120000 && policy.orphanSelfThread ? { mirror: true, kind: 'orphan_self_thread' } : { mirror: false, reason: 'reply_parent_unavailable' };
      }
      if (base.mirror && base.kind === 'thread_reply' && !policy.selfThread) base = { mirror: false, reason: 'self_thread_disabled' };
      if (!base.mirror && policy.replyToOthers && (base.reason === 'reply_to_other_account' || base.reason === 'reply_parent_unavailable' || base.reason === 'self_reply_in_other_thread')) base = { mirror: true, kind: 'reply_to_other' };
      res = base;
    }
    memo[t.id] = res;
    return res;
  };
  for (const t of Object.values(posts)) cls(t);
  return memo;
}

const decodeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const isMediaLink = (u) => /\/status\/\d+\/(photo|video)\/\d+/.test(u);
function mimeOf(url) {
  if (/\.mp4(\?|$)/.test(url)) return 'video/mp4';
  if (/\.png(\?|$)/.test(url)) return 'image/png';
  if (/\.gif(\?|$)/.test(url)) return 'image/gif';
  if (/\.webp(\?|$)/.test(url)) return 'image/webp';
  return 'image/jpeg';
}
function mediaUrl(m) {
  if (m.type === 'photo') return m.url || m.preview_image_url;
  const mp4 = (m.variants || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  return mp4[0]?.url || m.preview_image_url || null;
}
const postUrl = (t, username) => `https://x.com/${username || 'i'}/status/${t.id}`;
function refUrl(id, batch) {
  const rt = batch.incTweets[id]; const u = rt && batch.users[rt.author_id]?.username;
  return u ? `https://x.com/${u}/status/${id}` : `https://x.com/i/status/${id}`;
}

function buildContent(t, c, batch, username) {
  if (c.kind === 'repost') {
    const r = t.referenced_tweets.find((x) => x.type === 'retweeted');
    return { content: `Reposted on X: ${refUrl(r.id, batch)}\n\nOriginally on X: ${postUrl(t, username)}`, mediaItems: [] };
  }
  const nt = t.note_tweet;
  let text = nt?.text || t.text || '';
  const ents = nt?.entities?.urls || t.entities?.urls || [];
  const quoted = (t.referenced_tweets || []).find((r) => r.type === 'quoted');
  const replied = (t.referenced_tweets || []).find((r) => r.type === 'replied_to');
  const quotedUrl = quoted ? refUrl(quoted.id, batch) : null;
  if (replied && c.kind !== 'reply_to_other') text = text.replace(/^(\s*@\w+)+\s*/, '');
  text = text.replace(/https:\/\/t\.co\/\w+/g, (u) => {
    const e = ents.find((x) => x.url === u);
    if (!e) return u; // no network resolution: keep the t.co link
    const real = e.unwound_url || e.expanded_url || u;
    if (e.media_key || isMediaLink(real)) return '';
    if (quoted && new RegExp(`/status/${quoted.id}(\\D|$)`).test(real)) return '';
    return real;
  });
  text = decodeHtml(text).replace(/[ \t]+$/gm, '').trim();
  const mediaItems = [];
  for (const k of t.attachments?.media_keys || []) {
    const m = batch.media[k]; if (!m) continue;
    const u = mediaUrl(m); if (u) mediaItems.push({ url: u, mime: mimeOf(u) });
  }
  const parts = [];
  if (c.kind === 'reply_to_other' && replied) parts.push(`Replying to ${refUrl(replied.id, batch)}`);
  if (text) parts.push(text);
  if (mediaItems.length) parts.push(mediaItems.map((m) => m.url).join('\n'));
  if (quotedUrl) parts.push(quotedUrl);
  return { content: parts.join('\n\n') + '\n\nOriginally on X: ' + postUrl(t, username), mediaItems };
}

// timestampMode: 'original' (backdate to X time) | 'current'
function buildEventTemplate(t, c, batch, state, { username, timestampMode = 'original', now = Date.now() } = {}) {
  const { content, mediaItems } = buildContent(t, c, batch, username);
  const tags = [['r', postUrl(t, username)]];
  for (const m of mediaItems) tags.push(['imeta', 'url ' + m.url, 'm ' + m.mime]);
  if (c.kind === 'thread_reply' && state.mirrored[c.parentXid]) {
    const parentEv = state.mirrored[c.parentXid];
    const rootEv = state.roots[c.parentXid] || parentEv;
    tags.push(['e', rootEv, '', 'root']);
    if (rootEv !== parentEv) tags.push(['e', parentEv, '', 'reply']);
  }
  const ts = timestampMode === 'current' ? now : Date.parse(t.created_at);
  return { kind: 1, created_at: Math.floor(ts / 1000), tags, content };
}

// Plan what a run would do (no side effects). Used for preview and by processBatch.
function plan(batch, state, job) {
  const cls = classifyAll(batch, state, job.sourceUserId, { ...DEFAULT_POLICY, ...(job.policy || {}) });
  const ids = Object.keys(batch.posts).sort(cmpId);
  return ids.map((xid) => {
    const t = batch.posts[xid];
    if (state.mirrored[xid]) return { xid, t, status: 'already', eventId: state.mirrored[xid] };
    const c = cls[xid];
    if (!c.mirror) return { xid, t, status: 'skip', reason: c.reason };
    return { xid, t, status: 'publish', kind: c.kind, c };
  });
}

/**
 * Publish posts oldest-first. Checkpoint (newest_seen_id) only advances over a contiguous run of
 * fully handled posts (published / skipped / already). State is saved after every outcome.
 * deps: { sign(tmpl)->event, publish(event)->[{url,ok,msg}], saveState(state), log(), sleep(), shouldStop() }
 */
async function processBatch(batch, state, job, deps) {
  const items = plan(batch, state, job);
  const minOk = job.minRelayOk || 2;
  const limit = job.limit || Infinity;
  const only = deps.onlyIds ? new Set(deps.onlyIds) : null;
  const advanceCheckpoint = deps.advanceCheckpoint !== false;
  const stats = { input: items.length, eligible: 0, selected: 0, attempted: 0, already: 0, published: 0, failed: 0, deferred: 0, skipped: 0, notSelected: 0, reused: 0, stopped: false, events: [] };
  for (const it of items) if (it.status === 'publish') { stats.eligible++; if (!only || only.has(it.xid)) stats.selected++; }
  if (stats.selected > limit) stats.selected = limit;
  const progress = () => deps.onProgress && deps.onProgress({ selected: stats.selected, attempted: stats.attempted, completed: stats.published, failed: stats.failed, deferred: stats.deferred, skipped: stats.skipped, already: stats.already });
  progress();
  let blocked = false; let done = 0;
  const advance = (xid) => { if (advanceCheckpoint && !blocked) state.newest_seen_id = maxId(state.newest_seen_id, xid); };
  for (const it of items) {
    if (deps.shouldStop && deps.shouldStop()) { blocked = true; stats.stopped = true; break; }
    if (it.status === 'already') { stats.already++; advance(it.xid); continue; }
    if (it.status === 'skip') { stats.skipped++; state.skipped[it.xid] = it.reason; advance(it.xid); continue; }
    if ((only && !only.has(it.xid)) || done >= limit) { stats.notSelected++; blocked = true; continue; }
    const c = it.c;
    if (c.kind === 'thread_reply' && !state.mirrored[c.parentXid]) { stats.deferred++; blocked = true; state.failed[it.xid] = 'parent_not_mirrored_yet'; progress(); continue; }
    // Reuse an event signed in an earlier interrupted/partial attempt: same id, so relays dedupe it.
    let ev = state.pending[it.xid];
    if (ev) stats.reused++;
    else {
      const tmpl = buildEventTemplate(it.t, c, batch, state, { username: job.sourceUsername, timestampMode: job.timestampMode });
      ev = deps.sign(tmpl);
      state.pending[it.xid] = ev;
      await deps.saveState(state); // durable before any relay sees it
    }
    stats.attempted++;
    let res;
    try { res = await deps.publish(ev); } catch (e) { res = [{ url: '*', ok: false, msg: e.message }]; }
    const oks = res.filter((r) => r.ok);
    if (deps.recordEvent) deps.recordEvent({ xid: it.xid, ok: oks.map((r) => r.url), event: ev });
    if (oks.length >= minOk) {
      state.mirrored[it.xid] = ev.id;
      state.roots[it.xid] = c.kind === 'thread_reply' ? (state.roots[c.parentXid] || state.mirrored[c.parentXid]) : ev.id;
      delete state.failed[it.xid]; delete state.skipped[it.xid]; delete state.pending[it.xid]; delete state.imported[it.xid];
      state.newest_mirrored_id = maxId(state.newest_mirrored_id, it.xid);
      if (it.t.created_at && (!state.last_source_post_at || Date.parse(it.t.created_at) > Date.parse(state.last_source_post_at))) state.last_source_post_at = it.t.created_at;
      state.last_publish_at = new Date(deps.now ? deps.now() : Date.now()).toISOString();
      advance(it.xid);
      stats.published++; stats.events.push({ xid: it.xid, id: ev.id, relays: oks.length });
      if (deps.log) deps.log(`published ${it.xid} -> ${ev.id} (${oks.length}/${res.length} relays)`);
    } else {
      state.failed[it.xid] = res.map((r) => `${r.url}:${r.ok ? 'ok' : r.msg}`).join(' | ').slice(0, 500);
      stats.failed++; blocked = true;
      if (deps.log) deps.log(`FAILED ${it.xid}: only ${oks.length}/${res.length} relays accepted (need ${minOk}); will retry with the same signed event`);
    }
    await deps.saveState(state);
    progress();
    done++;
    if (deps.sleep && job.delayMs) await deps.sleep(job.delayMs);
  }
  await deps.saveState(state);
  progress();
  return stats;
}

module.exports = { STATE_VERSION, migrateState, stateStats, DEFAULT_POLICY, emptyState, loadBatch, parseResponsesText, classifyAll, buildContent, buildEventTemplate, plan, processBatch, maxId, cmpId };
