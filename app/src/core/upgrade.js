'use strict';
// Before a new app version first touches user data, back up configs + checkpoints (not caches).
// The app keeps the same name/appId so the data folder (and Keychain entry) is unchanged across versions.
const fs = require('fs');
const path = require('path');
function backupBeforeUpgrade(dataDir, version, now = Date.now()) {
  const metaFile = path.join(dataDir, 'app-meta.json');
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
  const prev = meta.lastVersion || (fs.existsSync(path.join(dataDir, 'jobs.json')) ? '0.1.x' : null);
  let backupDir = null;
  if (prev && prev !== version) {
    backupDir = path.join(dataDir, 'backups', `${new Date(now).toISOString().replace(/[:.]/g, '-')}-from-${prev}`);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const f of ['jobs.json', 'secrets.enc.json']) if (fs.existsSync(path.join(dataDir, f))) fs.copyFileSync(path.join(dataDir, f), path.join(backupDir, f));
    const jobsDir = path.join(dataDir, 'jobs');
    if (fs.existsSync(jobsDir)) for (const id of fs.readdirSync(jobsDir)) {
      const src = path.join(jobsDir, id, 'state.json');
      if (fs.existsSync(src)) { fs.mkdirSync(path.join(backupDir, 'jobs', id), { recursive: true }); fs.copyFileSync(src, path.join(backupDir, 'jobs', id, 'state.json')); }
    }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, lastVersion: version, previousVersion: prev && prev !== version ? prev : meta.previousVersion || null }));
  return { previous: prev, backupDir };
}
module.exports = { backupBeforeUpgrade };
