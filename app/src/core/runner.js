'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { finalizeEvent } = require('nostr-tools');
const M = require('./mirror');
const { parseSecretKey, parsePublicKey } = require('./nostrkeys');
const { isDue } = require('./schedule');
const { rangeToUtc } = require('./dates');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secretNames = (job) => ({ nsec: `job:${job.id}:nsec`, bearer: `x:${job.xCredentialId || 'default'}:bearer` });

function loadSigner(job, getSecret) {
  const s = getSecret(secretNames(job).nsec);
  if (!s) throw new Error('No Nostr secret key saved for this profile');
  const k = parseSecretKey(s);
  if (!job.npub || k.pk !== parsePublicKey(job.npub).pk) throw new Error('Saved secret key does not match the profile npub; refusing to publish');
  return (tmpl) => finalizeEvent(tmpl, k.sk);
}

/**
 * opts.mode: 'incremental' (since checkpoint) | 'backfill' (all history the API returns) |
 *            'range' (opts.range {from,to,timezone}; never uses or moves the checkpoint) | 'import' (opts.responses)
 * opts.dryRun: preview only. opts.onlyIds: publish only these X ids. opts.trigger: 'manual'|'schedule'.
 * deps: { store, getSecret, makeXClient, makeRelays, sleepFn, onProgress(run), shouldStop() }
 * A durable run record (jobs/<id>/run.json) tracks stage + counts for publishing runs.
 */
async function runJob(jobId, opts, deps) {
  const { store } = deps;
  const job = store.getJob(jobId);
  if (!job) throw new Error('Unknown job');
  const release = store.acquireLock(job.id);
  if (!release) return { ok: false, locked: true, message: 'Another run of this profile is in progress' };
  const log = (m) => store.log(job.id, m);
  let relays;
  const result = { ok: false, mode: opts.mode, startedAt: Date.now() };
  const run = { runId: crypto.randomBytes(6).toString('hex'), jobId: job.id, mode: opts.mode, trigger: opts.trigger || 'manual', dryRun: Boolean(opts.dryRun), status: 'running', stage: 'starting',
    startedAt: Date.now(), endedAt: null, counts: { selected: 0, attempted: 0, completed: 0, failed: 0, deferred: 0, skipped: 0, already: 0 }, message: '' };
  const emit = (patch) => { Object.assign(run, patch); if (!run.dryRun) store.saveRun(job.id, run); if (deps.onProgress) deps.onProgress({ ...run, counts: { ...run.counts } }); };
  try {
    emit({ stage: 'fetching' });
    const state = store.loadState(job.id);
    let responses = opts.responses;
    const checkpointMode = opts.mode === 'incremental' || opts.mode === 'backfill';
    if (!responses) {
      if (!job.sourceUserId) throw new Error('Resolve the source X handle first');
      const bearer = deps.getSecret(secretNames(job).bearer);
      if (!bearer) throw new Error('No X API Bearer token saved');
      const x = deps.makeXClient(bearer);
      let since = opts.mode === 'incremental' ? state.newest_seen_id : null;
      let range = {};
      if (opts.mode === 'range') { range = rangeToUtc(opts.range || {}); result.range = range; }
      const firstNewOnly = opts.mode === 'incremental' && !since && job.firstRun === 'new_only' && !state.mirrored_any;
      if (firstNewOnly && !opts.dryRun) {
        const p = await x.userPostsPage(job.sourceUserId, { maxResults: 5 });
        state.newest_seen_id = p.meta?.newest_id || null; state.mirrored_any = true;
        store.saveState(job.id, state);
        log(`first run: checkpoint set to ${state.newest_seen_id}; older posts not published`);
        Object.assign(result, { ok: true, stats: { input: 0, published: 0 }, checkpointOnly: true });
        emit({ stage: 'done', status: 'done', endedAt: Date.now(), message: 'Checkpoint set; only posts from now on will be mirrored.' });
        return result;
      }
      const r = await x.fetchAllSince(job.sourceUserId, since, { maxPages: firstNewOnly ? 1 : (opts.maxPages || 40), startTime: range.startTime, endTime: range.endTime });
      responses = r.pages;
      result.fetchComplete = r.complete; result.xCalls = x.calls;
      const rawDir = path.join(store.jobDir(job.id), 'raw'); fs.mkdirSync(rawDir, { recursive: true });
      result.rawFile = path.join(rawDir, `${Date.now()}.json`);
      fs.writeFileSync(result.rawFile, JSON.stringify(responses));
    }
    const batch = M.loadBatch(responses);
    result.fetchedCount = Object.keys(batch.posts).length;
    if (opts.dryRun) {
      const items = M.plan(batch, state, job).map((i) => ({ xid: i.xid, status: i.status, kind: i.kind, reason: i.reason, created_at: i.t.created_at,
        preview: i.status === 'publish' ? M.buildEventTemplate(i.t, i.c, batch, state, { username: job.sourceUsername, timestampMode: job.timestampMode }) : null }));
      Object.assign(result, { ok: true, dryRun: true, items, responses });
      emit({ stage: 'done', status: 'done', endedAt: Date.now() });
      return result;
    }
    emit({ stage: 'publishing' });
    const sign = loadSigner(job, deps.getSecret);
    relays = deps.makeRelays(job.relays);
    const stats = await M.processBatch(batch, state, job, {
      sign, publish: (ev) => relays.publish(ev), saveState: (st) => store.saveState(job.id, st),
      recordEvent: (rec) => store.appendEvent(job.id, rec), log, sleep: deps.sleepFn || sleep, onlyIds: opts.onlyIds,
      advanceCheckpoint: checkpointMode, shouldStop: deps.shouldStop,
      onProgress: (c) => emit({ counts: c }),
    });
    if (stats.published) state.mirrored_any = true;
    if (opts.mode === 'backfill' && result.fetchComplete !== false && !stats.failed && !stats.deferred && !stats.stopped) state.backfill_done = true;
    store.saveState(job.id, state);
    const ok = stats.failed === 0 && !stats.stopped;
    Object.assign(result, { ok, stats });
    const msg = `published ${stats.published} of ${stats.selected} selected; ${stats.failed} failed (will retry), ${stats.deferred} waiting for thread parent, ${stats.already} already mirrored, ${stats.skipped} skipped by rules`;
    log(`run ${opts.mode}${stats.stopped ? ' (cancelled)' : ''}: ${msg}`);
    emit({ stage: 'done', status: stats.stopped ? 'cancelled' : ok ? 'done' : 'failed', endedAt: Date.now(), message: msg });
    return result;
  } catch (e) {
    result.error = e.message; log('ERROR ' + e.message);
    emit({ stage: 'done', status: 'failed', endedAt: Date.now(), message: e.message });
    return result;
  } finally {
    if (relays) relays.close();
    release();
    if (!opts.dryRun) {
      const j = store.getJob(job.id);
      if (j) {
        j.lastRunAt = Date.now(); j.lastResult = { ok: result.ok, error: result.error || null, published: result.stats?.published || 0, failed: result.stats?.failed || 0 };
        if (opts.trigger === 'schedule' || opts.mode === 'incremental') j.consecutiveFailures = result.ok ? 0 : (j.consecutiveFailures || 0) + 1;
        store.upsertJob(j);
      }
    }
  }
}

function backoffUntil(job) {
  const n = job.consecutiveFailures || 0;
  return n ? (job.lastRunAt || 0) + Math.min(12 * 3600e3, 15 * 60e3 * 2 ** (n - 1)) : 0;
}
// Run every job whose schedule is enabled, publishing explicitly enabled, and due.
async function runDueJobs(deps, now = Date.now(), { skip = () => false, wrap = (id, fn) => fn() } = {}) {
  const out = [];
  for (const job of deps.store.listJobs()) {
    if (!job.schedule?.enabled || !job.publishEnabled || skip(job.id)) continue;
    if (!isDue(job.schedule, job.lastRunAt, now) || now < backoffUntil(job)) continue;
    out.push({ id: job.id, ...(await wrap(job.id, (d) => runJob(job.id, { mode: 'incremental', trigger: 'schedule' }, d || deps))) });
  }
  return out;
}
module.exports = { runJob, runDueJobs, backoffUntil, secretNames };
