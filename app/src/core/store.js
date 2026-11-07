'use strict';
// On-disk layout under dataDir (no secrets here):
//   jobs.json                      job configs
//   jobs/<jobId>/state.json        checkpoint + dedupe maps
//   jobs/<jobId>/events.jsonl      signed events + accepting relays (public data)
//   jobs/<jobId>/run.lock          non-overlap lock
//   jobs/<jobId>/log.txt           run log
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { emptyState, migrateState } = require('./mirror');

function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const JOB_ID = /^[a-z0-9-]{6,40}$/;

class Store {
  constructor(dataDir) { this.dir = dataDir; fs.mkdirSync(path.join(dataDir, 'jobs'), { recursive: true, mode: 0o700 }); }
  jobDir(id) { if (!JOB_ID.test(id)) throw new Error('bad job id'); const d = path.join(this.dir, 'jobs', id); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
  listJobs() { const f = path.join(this.dir, 'jobs.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; }
  saveJobs(jobs) { atomicWrite(path.join(this.dir, 'jobs.json'), JSON.stringify(jobs, null, 1)); }
  getJob(id) { return this.listJobs().find((j) => j.id === id) || null; }
  upsertJob(job) {
    const jobs = this.listJobs();
    if (!job.id) job.id = 'job-' + crypto.randomBytes(5).toString('hex');
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) jobs[i] = job; else jobs.push(job);
    this.saveJobs(jobs); this.jobDir(job.id); return job;
  }
  deleteJob(id) { this.saveJobs(this.listJobs().filter((j) => j.id !== id)); fs.rmSync(path.join(this.dir, 'jobs', id), { recursive: true, force: true }); }
  loadState(id) { const f = path.join(this.jobDir(id), 'state.json'); return fs.existsSync(f) ? migrateState(JSON.parse(fs.readFileSync(f, 'utf8'))) : emptyState(); }
  // Durable record of the latest run (survives restarts). status: running|done|failed|interrupted|cancelled
  saveRun(id, run) { atomicWrite(path.join(this.jobDir(id), 'run.json'), JSON.stringify(run)); }
  loadRun(id) { const f = path.join(this.jobDir(id), 'run.json'); try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { return null; } }
  // On startup: a run still marked "running" whose lock owner is gone was interrupted.
  markInterruptedRuns() {
    const out = [];
    for (const j of this.listJobs()) {
      const r = this.loadRun(j.id);
      if (r && r.status === 'running' && !this.lockHeldByLiveProcess(j.id)) { r.status = 'interrupted'; r.endedAt = Date.now(); r.message = 'App closed or crashed during this run. Signed but unconfirmed notes are reused on the next run, so nothing is duplicated.'; this.saveRun(j.id, r); out.push(j.id); }
    }
    return out;
  }
  lockHeldByLiveProcess(id) {
    const f = path.join(this.jobDir(id), 'run.lock'); if (!fs.existsSync(f)) return false;
    let info = {}; try { info = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return false; }
    if (info.pid === process.pid) return false;
    try { process.kill(info.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  saveState(id, st) { atomicWrite(path.join(this.jobDir(id), 'state.json'), JSON.stringify(st)); }
  appendEvent(id, rec) { fs.appendFileSync(path.join(this.jobDir(id), 'events.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 }); }
  log(id, line) {
    const f = path.join(this.jobDir(id), 'log.txt');
    try { if (fs.existsSync(f) && fs.statSync(f).size > 2e6) fs.renameSync(f, f + '.1'); } catch (_) {}
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
  }
  readLog(id, maxBytes = 20000) { const f = path.join(this.jobDir(id), 'log.txt'); if (!fs.existsSync(f)) return ''; const s = fs.readFileSync(f, 'utf8'); return s.slice(-maxBytes); }
  // Non-overlap lock: O_EXCL create; stale if owner pid is gone or older than staleMs.
  acquireLock(id, staleMs = 6 * 3600 * 1000) {
    const f = path.join(this.jobDir(id), 'run.lock');
    for (let i = 0; i < 2; i++) {
      try { const fd = fs.openSync(f, 'wx', 0o600); fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); fs.closeSync(fd); return () => { try { fs.unlinkSync(f); } catch (_) {} }; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let info = {}; try { info = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
        let alive = false; try { process.kill(info.pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
        if (alive && Date.now() - (info.at || 0) < staleMs) return null;
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
    return null;
  }
}
module.exports = { Store, atomicWrite };
