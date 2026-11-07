'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Store } = require('../core/store');
const { SecretStore } = require('../core/secrets');
const { XClient } = require('../core/xapi');
const { RelaySet, validateRelayUrl, DEFAULT_RELAYS } = require('../core/relays');
const { parseSecretKey, parsePublicKey } = require('../core/nostrkeys');
const { validateSchedule, nextRun } = require('../core/schedule');
const { runJob, runDueJobs, secretNames, backoffUntil } = require('../core/runner');
const { parseResponsesText, DEFAULT_POLICY } = require('../core/mirror');
const { importLegacyState } = require('../core/legacy');
const L = require('../core/launchd');
const { stateStats } = require('../core/mirror');
const { backupBeforeUpgrade } = require('../core/upgrade');
const About = require('../core/about');
const { clipboard } = require('electron');

app.setName('X to Nostr Mirror');
const RUN_DUE = process.argv.includes('--run-due');
if (process.env.XNM_USER_DATA) app.setPath('userData', path.resolve(process.env.XNM_USER_DATA)); // tests / portable use
const SMOKE = process.env.XNM_SMOKE === '1';
let store, secrets, win;
let quitting = false;
const previewCache = new Map(); // jobId -> responses previewed (kept in main memory only)

function deps() {
  return {
    store,
    getSecret: (n) => secrets.get(n),
    makeXClient: (bearer) => new XClient({ bearer }),
    makeRelays: (urls) => new RelaySet(urls.map((u) => validateRelayUrl(u))),
  };
}
function init() {
  const dir = app.getPath('userData');
  backupBeforeUpgrade(dir, app.getVersion());
  store = new Store(dir);
  secrets = new SecretStore(path.join(dir, 'secrets.enc.json'), safeStorage);
  store.markInterruptedRuns();
}

// ---------- active runs (main process owns them; renderer only observes) ----------
const active = new Map(); // jobId -> { run, cancel }
function broadcast(msg) { if (win && !win.isDestroyed()) win.webContents.send('app:event', msg); }
function startRun(jobId, opts) {
  if (active.has(jobId)) throw new Error('This profile is already fetching or publishing. Wait for it to finish.');
  const entry = { run: { jobId, status: 'running', stage: 'starting', mode: opts.mode, counts: {} }, cancel: false };
  active.set(jobId, entry);
  const d = { ...deps(), onProgress: (r) => { entry.run = r; broadcast({ type: 'progress', run: r }); }, shouldStop: () => entry.cancel };
  const p = runJob(jobId, opts, d).finally(() => { active.delete(jobId); broadcast({ type: 'run-finished', jobId }); });
  return { promise: p, entry };
}

// ---------- headless scheduled run (launchd) ----------
if (RUN_DUE) {
  app.dock && app.dock.hide && app.dock.hide();
  app.whenReady().then(async () => {
    init();
    try { const r = await runDueJobs(deps()); console.log(new Date().toISOString(), 'run-due', JSON.stringify(r.map((x) => ({ id: x.id, ok: x.ok, error: x.error, published: x.stats?.published })))); }
    catch (e) { console.error('run-due failed:', e.message); }
    app.quit();
  });
} else {
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { init(); hardenSession(); registerIpc(); createWindow(); startInAppScheduler(); });
  app.on('before-quit', (e) => {
    if (quitting || !active.size) return;
    const n = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Keep running', 'Quit anyway'], defaultId: 0, cancelId: 0,
      message: 'Publishing is still in progress', detail: 'Quitting now stops it. Nothing is lost or duplicated: posts already confirmed are recorded, and signed-but-unconfirmed notes are re-sent with the same ID next time.' });
    if (n === 0) e.preventDefault(); else quitting = true;
  });
  app.on('window-all-closed', () => app.quit());
}

function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file://') && !d.url.startsWith('devtools://') }));
}
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 600, title: 'X to Nostr Mirror', backgroundColor: '#0f1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!active.size) return;
    const n = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Keep window open', 'Close and stop'], defaultId: 0, cancelId: 0,
      message: 'Publishing is still in progress', detail: 'Closing the window quits the app and stops the run. It can be resumed later without duplicates.' });
    if (n === 0) e.preventDefault(); else { quitting = true; for (const a of active.values()) a.cancel = true; }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // external links only via app:openLink allowlist
  win.loadFile(INDEX);
  if (SMOKE) win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const probe = await win.webContents.executeJavaScript(`JSON.stringify({ title: document.title, api: typeof window.api, apiKeys: Object.keys(window.api || {}).length, require: typeof require, process: typeof process, banner: document.getElementById('banner').textContent, empty: !document.getElementById('empty').classList.contains('hidden') })`);
    let nav = 'not-attempted';
    try { await win.webContents.executeJavaScript(`location.href='https://example.com'`); await new Promise((r) => setTimeout(r, 500)); nav = win.webContents.getURL().startsWith('file://') ? 'blocked' : 'NAVIGATED'; } catch (e) { nav = 'blocked'; }
    if (process.env.XNM_SMOKE_SHOT) {
      fs.writeFileSync(process.env.XNM_SMOKE_SHOT + '-profile.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('aboutBtn').click()`); await new Promise((r) => setTimeout(r, 1200));
      fs.writeFileSync(process.env.XNM_SMOKE_SHOT + '-about.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('guideBtn').click()`); await new Promise((r) => setTimeout(r, 800));
      const g = await win.webContents.executeJavaScript(`document.getElementById('guideText').textContent.length`); console.log('SMOKE guideChars=' + g);
    }
    console.log('SMOKE ' + probe + ' nav=' + nav + ' storage=' + JSON.stringify(secrets.available()));
    app.quit();
  });
}

let schedulerBusy = false;
function startInAppScheduler() {
  setInterval(async () => {
    if (schedulerBusy) return; schedulerBusy = true;
    try {
      const r = await runDueJobs(deps(), Date.now(), { skip: (id) => active.has(id), wrap: (id) => startRun(id, { mode: 'incremental', trigger: 'schedule' }).promise });
      if (r.length) broadcast({ type: 'scheduled-run', results: r.map((x) => ({ id: x.id, ok: x.ok, error: x.error || null, published: x.stats?.published || 0 })) });
    }
    catch (_) {} finally { schedulerBusy = false; }
  }, 60 * 1000);
}

// ---------- IPC ----------
const str = (v, max = 500) => { if (typeof v !== 'string' || v.length > max) throw new Error('invalid input'); return v; };
const confirm = async (message, detail) => (await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, message, detail })).response === 1;
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...args) => {
    const url = e.senderFrame && e.senderFrame.url;
    if (!url || !url.startsWith('file://') || decodeURIComponent(new URL(url).pathname) !== INDEX.split(path.sep).join('/').replace(/^([A-Za-z]:)/, '/$1')) throw new Error('blocked');
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
  });
}
function sanitizeJob(input, existing = {}) {
  const j = { ...existing };
  j.name = str(input.name || 'Profile', 80);
  if (input.sourceUserId !== undefined) { if (!/^\d{1,25}$/.test(input.sourceUserId)) throw new Error('Resolve the X handle first'); j.sourceUserId = input.sourceUserId; j.sourceUsername = str(input.sourceUsername, 20); }
  if (input.npub) j.npub = parsePublicKey(str(input.npub, 100)).npub;
  j.relays = (input.relays || DEFAULT_RELAYS).slice(0, 20).map((u) => validateRelayUrl(str(u, 300)));
  if (!j.relays.length) throw new Error('Add at least one relay');
  j.minRelayOk = Math.max(1, Math.min(j.relays.length, Number(input.minRelayOk) || 2));
  j.timestampMode = input.timestampMode === 'current' ? 'current' : 'original';
  j.firstRun = input.firstRun === 'new_only' ? 'new_only' : 'backfill';
  j.delayMs = Math.max(500, Math.min(60000, Number(input.delayMs) || 2000));
  j.policy = Object.fromEntries(Object.keys(DEFAULT_POLICY).map((k) => [k, Boolean((input.policy || DEFAULT_POLICY)[k])]));
  if (input.schedule) {
    const s = { enabled: Boolean(input.schedule.enabled), startAt: str(input.schedule.startAt, 40), intervalMinutes: Number(input.schedule.intervalMinutes), timezone: input.schedule.timezone ? str(input.schedule.timezone, 60) : undefined };
    if (input.schedule.activeHours) s.activeHours = { from: Number(input.schedule.activeHours.from), to: Number(input.schedule.activeHours.to) };
    validateSchedule(s); j.schedule = s;
  }
  j.publishEnabled = Boolean(input.publishEnabled);
  return j;
}
function publicJob(j) {
  return { ...j, stats: stateStats(store.loadState(j.id)), lastRun: active.get(j.id)?.run || store.loadRun(j.id), running: active.has(j.id), hasKey: secrets.has(secretNames(j).nsec), nextRunAt: j.schedule?.enabled && j.publishEnabled ? Math.max(nextRun(j.schedule, j.lastRunAt || Date.now() - 1) || 0, backoffUntil(j)) || null : null };
}
async function launchctl(args) { return new Promise((res) => execFile('/bin/launchctl', args, (err, so, se) => res({ ok: !err, out: (so + se).slice(0, 500) }))); }

function registerIpc() {
  handle('app:status', () => ({ platform: process.platform, version: app.getVersion(), secureStorage: secrets.available(), hasXToken: secrets.has(secretNames({}).bearer),
    launchdInstalled: process.platform === 'darwin' && fs.existsSync(L.plistPath(os.homedir())), dataDir: app.getPath('userData'), defaults: { relays: DEFAULT_RELAYS, policy: DEFAULT_POLICY }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  handle('jobs:list', () => store.listJobs().map(publicJob));
  handle('jobs:save', (input) => {
    const ex = input.id ? store.getJob(str(input.id, 60)) : null;
    if (input.id && !ex) throw new Error('Unknown profile');
    const j = sanitizeJob(input, ex || {});
    if (j.publishEnabled && (!j.npub || !secrets.has(secretNames(j).nsec))) throw new Error('Save and verify a Nostr secret key before enabling publishing');
    return publicJob(store.upsertJob(j));
  });
  handle('jobs:delete', async (id) => { const j = store.getJob(str(id, 60)); if (!j) return false; if (active.has(j.id)) throw new Error('Wait for the current run to finish.'); if (!(await confirm(`Delete profile "${j.name}"?`, 'Its checkpoint (dedupe history) and saved Nostr key are removed. Notes already on Nostr are not affected.'))) return false; secrets.delete(secretNames(j).nsec); store.deleteJob(j.id); return true; });
  handle('x:saveToken', async (token) => {
    const t = str(token, 400).trim(); if (t.length < 20) throw new Error('That does not look like an X API Bearer token');
    const u = await new XClient({ bearer: t }).lookupUser('XDevelopers'); // verifies token works before saving
    secrets.set(secretNames({}).bearer, t); return { verified: Boolean(u.id) };
  });
  handle('x:clearToken', () => { secrets.delete(secretNames({}).bearer); return true; });
  handle('x:resolve', async (handle) => { const b = secrets.get(secretNames({}).bearer); if (!b) throw new Error('Save an X API Bearer token first'); const u = await new XClient({ bearer: b }).lookupUser(str(handle, 100)); return { id: u.id, username: u.username, name: u.name, description: u.description, profile_image_url: u.profile_image_url }; });
  handle('nostr:derive', (secret) => ({ npub: parseSecretKey(str(secret, 200)).npub })); // returns public key only
  handle('nostr:saveKey', (jobId, secret, expectedNpub) => {
    const j = store.getJob(str(jobId, 60)); if (!j) throw new Error('Save the profile first');
    const k = parseSecretKey(str(secret, 200));
    if (expectedNpub && parsePublicKey(expectedNpub).pk !== k.pk) throw new Error('This secret key does not match the npub you entered');
    secrets.set(secretNames(j).nsec, secret.trim()); j.npub = k.npub; store.upsertJob(j); return { npub: k.npub };
  });
  handle('nostr:testRelays', async (urls) => { const rs = new RelaySet((urls || []).slice(0, 20).map((u) => validateRelayUrl(str(u, 300)))); try { return await rs.test(); } finally { rs.close(); } });
  handle('job:preview', async (jobId, mode, range) => {
    const id = str(jobId, 60); const m = ['backfill', 'range'].includes(mode) ? mode : 'incremental';
    if (active.has(id)) throw new Error('This profile is busy; wait for the current run to finish.');
    let rg;
    if (m === 'range') {
      rg = { from: range?.from ? str(range.from, 10) : undefined, to: range?.to ? str(range.to, 10) : undefined, timezone: range?.timezone ? str(range.timezone, 60) : undefined };
      const j = store.getJob(id); if (j) { j.fetchFilter = rg; store.upsertJob(j); }
    }
    const { promise } = startRun(id, { mode: m, range: rg, dryRun: true, maxPages: m === 'incremental' ? 10 : 40 });
    const r = await promise;
    if (r.error) throw new Error(r.error);
    previewCache.set(id, { mode: m === 'range' ? 'import' : m, responses: r.responses, at: Date.now() });
    return { items: r.items, range: r.range || null, fetchComplete: r.fetchComplete !== false, fetched: r.fetchedCount };
  });
  handle('job:importJson', async (jobId) => {
    const id = str(jobId, 60); if (!store.getJob(id)) throw new Error('Unknown profile');
    const p = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'X API JSON', extensions: ['json', 'txt'] }] });
    if (p.canceled) return null;
    const responses = p.filePaths.flatMap((f) => parseResponsesText(fs.readFileSync(f, 'utf8')));
    if (active.has(id)) throw new Error('This profile is busy.');
    const r = await runJob(id, { mode: 'import', responses, dryRun: true }, deps());
    if (r.error) throw new Error(r.error);
    previewCache.set(id, { mode: 'import', responses, at: Date.now() }); return { items: r.items, fetchComplete: true, fetched: r.fetchedCount };
  });
  handle('job:publish', async (jobId, onlyIds) => {
    const id = str(jobId, 60); const j = store.getJob(id); const c = previewCache.get(id);
    if (!j || !c) throw new Error('Preview posts first');
    if (active.has(id)) throw new Error('This profile is already publishing.');
    const ids = Array.isArray(onlyIds) ? onlyIds.filter((x) => /^\d+$/.test(x)).slice(0, 5000) : null;
    if (!(await confirm(`Publish ${ids ? ids.length : 'all eligible'} post(s) to Nostr as ${j.npub.slice(0, 16)}…?`, `Relays: ${j.relays.join(', ')}\nTimestamps: ${j.timestampMode === 'original' ? 'original X time (backdated)' : 'current time'}\nNostr notes cannot be reliably deleted once published.`))) return { cancelled: true };
    const { promise } = startRun(id, { mode: c.mode, responses: c.responses, onlyIds: ids });
    promise.then(() => previewCache.delete(id));
    return { started: true }; // progress arrives via app:event / job:progress
  });
  handle('job:runNow', async (jobId) => {
    const id = str(jobId, 60); const j = store.getJob(id); if (!j) throw new Error('Unknown profile');
    if (active.has(id)) throw new Error('This profile is already running.');
    if (!(await confirm(`Fetch new posts for @${j.sourceUsername} and publish them now?`, 'Publishes every new eligible post since the last checkpoint without per-post preview.'))) return { cancelled: true };
    startRun(id, { mode: 'incremental' }); return { started: true };
  });
  handle('job:progress', () => [...active.values()].map((a) => a.run));
  handle('job:cancel', async (jobId) => { const a = active.get(str(jobId, 60)); if (!a) return false; if (!(await confirm('Stop this run after the current note?', 'Confirmed notes stay recorded; the rest are picked up next time without duplicates.'))) return false; a.cancel = true; return true; });
  handle('about:info', () => About.aboutInfo());
  handle('app:openLink', (key) => { shell.openExternal(About.externalUrl(str(key, 30))); return true; });
  handle('about:copyNpub', () => { clipboard.writeText(About.validNpub(About.AUTHOR_NPUB)); return true; });
  handle('app:guide', () => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8'));
  handle('job:importLegacy', async (jobId) => {
    const id = str(jobId, 60); if (!store.getJob(id)) throw new Error('Unknown profile');
    const p = await dialog.showOpenDialog(win, { title: 'Select the old mirror state.json', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (p.canceled) return null;
    const r = importLegacyState(JSON.parse(fs.readFileSync(p.filePaths[0], 'utf8')), store.loadState(id));
    if (!(await confirm(`Import ${r.imported} already-mirrored posts into this profile's checkpoint?`, 'Prevents re-posting them. Stop the old mirror before enabling this profile\'s schedule.'))) return null;
    store.saveState(id, r.state); return { imported: r.imported, pendingFailed: r.pendingFailed, newest_seen_id: r.state.newest_seen_id };
  });
  handle('job:summary', (jobId) => { const id = str(jobId, 60); return { ...stateStats(store.loadState(id)), lastRun: active.get(id)?.run || store.loadRun(id) }; });
  handle('job:log', (jobId) => store.readLog(str(jobId, 60)));
  handle('launchd:install', async () => {
    if (process.platform !== 'darwin') throw new Error('Background scheduling via launchd is only available on macOS');
    if (!(await confirm('Run scheduled profiles in the background, even when this app is closed?', 'Installs a per-user LaunchAgent that starts this app headless every 15 minutes to run due profiles. It cannot run while the Mac is asleep, off, or offline; missed runs catch up afterwards. You can remove it here at any time.'))) return { cancelled: true };
    const logDir = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const plist = L.plistPath(os.homedir()); fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, L.plistXml({ programArgs: L.programArgsFor({ execPath: process.execPath, appPath: app.getAppPath(), isPackaged: app.isPackaged }), intervalSeconds: 900, logDir }));
    const uid = String(process.getuid()); await launchctl(['bootout', `gui/${uid}`, plist]);
    return launchctl(['bootstrap', `gui/${uid}`, plist]);
  });
  handle('launchd:uninstall', async () => {
    if (process.platform !== 'darwin') throw new Error('macOS only');
    const plist = L.plistPath(os.homedir()); const r = await launchctl(['bootout', `gui/${process.getuid()}`, plist]);
    fs.rmSync(plist, { force: true }); return r;
  });
  handle('config:export', async () => {
    const p = await dialog.showSaveDialog(win, { defaultPath: 'x-nostr-mirror-profiles.json' }); if (p.canceled) return false;
    const jobs = store.listJobs().map(({ id, lastRunAt, lastResult, consecutiveFailures, ...rest }) => ({ ...rest, publishEnabled: false, schedule: rest.schedule ? { ...rest.schedule, enabled: false } : undefined }));
    fs.writeFileSync(p.filePath, JSON.stringify({ format: 'x-nostr-mirror-config', version: 1, jobs }, null, 1)); return true; // no secrets, no state
  });
  handle('config:import', async () => {
    const p = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }); if (p.canceled) return 0;
    const j = JSON.parse(fs.readFileSync(p.filePaths[0], 'utf8')); if (j.format !== 'x-nostr-mirror-config') throw new Error('Not an exported profile file');
    let n = 0; for (const x of j.jobs || []) { store.upsertJob(sanitizeJob({ ...x, publishEnabled: false, schedule: x.schedule ? { ...x.schedule, enabled: false } : undefined })); n++; }
    return n;
  });
}

