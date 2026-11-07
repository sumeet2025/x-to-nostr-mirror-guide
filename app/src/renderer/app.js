'use strict';
/* global api, onAppEvent */
const $ = (id) => document.getElementById(id);
let status = null, jobs = [], cur = null, draftSource = null, previewItems = [];
const previews = {}; // jobId -> { items, selected:Set, note } kept while navigating
const runs = {};     // jobId -> live run progress from the main process
const POLICY_LABELS = { original: 'Original posts', quote: 'Quote posts', selfThread: 'Own thread replies', orphanSelfThread: 'Threads whose first post was deleted', repost: 'Reposts (as a link)', replyToOthers: 'Replies to other accounts' };

async function call(fn, ...args) {
  const r = await api[fn](...args);
  if (!r.ok) { banner(r.error, true); throw new Error(r.error); }
  return r.data;
}
function banner(msg, err) { const b = $('banner'); b.textContent = msg; b.className = 'banner' + (err ? ' err' : ''); clearTimeout(banner.t); banner.t = setTimeout(() => b.classList.add('hidden'), 8000); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const STAGE = { starting: 'Starting', fetching: 'Fetching from X', publishing: 'Publishing to Nostr', done: 'Finished' };
function runLine(r) {
  const c = r.counts || {}; const sel = c.selected || 0; const done = (c.completed || 0) + (c.failed || 0) + (c.deferred || 0);
  if (r.dryRun || r.stage !== 'publishing') return `${STAGE[r.stage] || r.stage}…`;
  return `${STAGE.publishing}: ${c.completed || 0} posted, ${c.failed || 0} failed, ${c.deferred || 0} waiting, ${Math.max(0, sel - done)} still to go (of ${sel} selected)`;
}
function stat(label, value, sub) { const d = el('div', 'stat'); d.append(el('b', '', String(value)), document.createTextNode(label)); if (sub) d.append(el('small', '', sub)); return d; }

async function refresh() {
  status = await call('appStatus');
  jobs = await call('jobsList');
  const ul = $('jobList'); ul.replaceChildren();
  for (const j of jobs) {
    const li = el('li', cur && cur.id === j.id ? 'active' : '');
    const left = el('span', 'nm', j.name);
    left.append(el('span', 'sub', runs[j.id] ? '⟳ ' + (STAGE[runs[j.id].stage] || 'running') : `${j.stats.totalMirrored} posted · last post ${fmtDate(j.stats.lastSourcePostAt)}`));
    li.append(left);
    li.append(el('span', 'dot' + (runs[j.id] ? ' on' : j.lastResult && !j.lastResult.ok ? ' err' : j.schedule?.enabled && j.publishEnabled ? ' on' : '')));
    li.onclick = () => openJob(j.id); ul.append(li);
  }
  $('tokenStatus').textContent = status.hasXToken ? '✓ A verified Bearer token is saved.' : 'No token saved.';
  $('storeStatus').textContent = (status.secureStorage.ok ? '✓ OS keychain encryption available.' : '✗ ' + status.secureStorage.reason) + '  Data folder: ' + status.dataDir;
  $('ldStatus').textContent = status.platform !== 'darwin' ? 'Only available on macOS.' : status.launchdInstalled ? '✓ Background agent installed.' : 'Not installed.';
  if (cur && cur.id) { cur = jobs.find((j) => j.id === cur.id) || cur; renderStrip(); }
  renderProgress();
  if (!status.secureStorage.ok) banner('Secure key storage unavailable: ' + status.secureStorage.reason + '. Keys and tokens cannot be saved.', true);
}
function show(id) { for (const s of ['settings', 'empty', 'editor', 'about', 'guide']) $(s).classList.toggle('hidden', s !== id); }
function tab(name) { document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name)); document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name)); if (name === 'activity') loadActivity(); }
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => tab(t.dataset.tab)));

function toLocalInput(ms) { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function fillForm(j) {
  $('jobTitle').textContent = j.name || 'New profile';
  $('fName').value = j.name || ''; $('fHandle').value = j.sourceUsername ? '@' + j.sourceUsername : '';
  $('srcInfo').textContent = j.sourceUserId ? `@${j.sourceUsername} (id ${j.sourceUserId})` : 'Not resolved yet.';
  $('fNpub').value = j.npub || ''; $('fNsec').value = '';
  $('keyStatus').textContent = j.hasKey ? '✓ Secret key saved and verified for ' + j.npub : 'No secret key saved — publishing disabled.';
  $('fRelays').value = (j.relays || status.defaults.relays).join('\n'); $('fMinOk').value = j.minRelayOk || 2;
  const pol = j.policy || status.defaults.policy; const box = $('policy'); box.replaceChildren();
  for (const [k, label] of Object.entries(POLICY_LABELS)) { const l = el('label', 'inline'); const c = el('input'); c.type = 'checkbox'; c.dataset.k = k; c.checked = Boolean(pol[k]); l.append(c, document.createTextNode(label)); box.append(l); }
  $('fTs').value = j.timestampMode || 'original'; $('fFirst').value = j.firstRun || 'backfill'; $('fDelay').value = j.delayMs || 2000;
  const s = j.schedule || { enabled: false, startAt: new Date(Date.now() + 3600e3).toISOString(), intervalMinutes: 180, timezone: status.timezone };
  $('sEnabled').checked = s.enabled; $('sStart').value = toLocalInput(Date.parse(s.startAt));
  const unit = s.intervalMinutes % 1440 === 0 ? 1440 : s.intervalMinutes % 60 === 0 ? 60 : 1; $('sUnit').value = String(unit); $('sEvery').value = s.intervalMinutes / unit;
  $('sHoursOn').checked = Boolean(s.activeHours); $('sFrom').value = s.activeHours?.from ?? 8; $('sTo').value = s.activeHours?.to ?? 23; $('sTz').value = s.timezone || status.timezone;
  $('sPublish').checked = Boolean(j.publishEnabled);
  $('schedStatus').textContent = j.nextRunAt ? 'Next run: ' + fmt(j.nextRunAt) + (j.lastRunAt ? ' · Last run: ' + fmt(j.lastRunAt) + (j.lastResult?.ok ? ' ✓' : ' ✗ ' + (j.lastResult?.error || 'failed')) : '') : 'Scheduled publishing is off.';
  const f = j.fetchFilter || {}; $('rFrom').value = f.from || ''; $('rTo').value = f.to || ''; $('rTz').value = f.timezone || status.timezone;
  renderPosts(); renderStrip(); renderProgress();
  $('deleteJob').classList.toggle('hidden', !j.id);
}
function formJob() {
  const policy = {}; document.querySelectorAll('#policy input').forEach((c) => (policy[c.dataset.k] = c.checked));
  const base = { ...(cur || {}), name: $('fName').value.trim() || 'Profile', npub: $('fNpub').value.trim() || undefined,
    relays: $('fRelays').value.split(/\s+/).filter(Boolean), minRelayOk: Number($('fMinOk').value), timestampMode: $('fTs').value, firstRun: $('fFirst').value, delayMs: Number($('fDelay').value), policy };
  if (draftSource) { base.sourceUserId = draftSource.id; base.sourceUsername = draftSource.username; }
  const every = Number($('sEvery').value) * Number($('sUnit').value);
  base.schedule = { enabled: $('sEnabled').checked, startAt: new Date($('sStart').value).toISOString(), intervalMinutes: every, timezone: $('sTz').value.trim() || undefined };
  if ($('sHoursOn').checked) base.schedule.activeHours = { from: Number($('sFrom').value), to: Number($('sTo').value) };
  base.publishEnabled = $('sPublish').checked;
  for (const k of ['hasKey', 'nextRunAt', 'lastRunAt', 'lastResult', 'consecutiveFailures']) delete base[k];
  return base;
}
async function saveJob() { const j = await call('jobsSave', formJob()); cur = j; draftSource = null; await refresh(); fillForm(cur); banner('Saved.'); return j; }
function openJob(id) { cur = jobs.find((j) => j.id === id); draftSource = null; show('editor'); tab('setup'); fillForm(cur); refresh(); }

$('newJob').onclick = () => { cur = null; draftSource = null; show('editor'); tab('setup'); fillForm({}); };
$('settingsBtn').onclick = () => { show('settings'); refresh(); };
$('saveJob').onclick = saveJob;
$('resolveBtn').onclick = async () => { const u = await call('xResolve', $('fHandle').value); draftSource = u; $('srcInfo').textContent = `✓ ${u.name} (@${u.username}, id ${u.id}) — ${u.description || ''}`; if (!$('fName').value) $('fName').value = '@' + u.username + ' mirror'; };
$('verifyKey').onclick = async () => {
  const secret = $('fNsec').value.trim(); if (!secret) return banner('Enter the nsec to verify.', true);
  if (!cur || !cur.id) await saveJob();
  const r = await call('nostrSaveKey', cur.id, secret, $('fNpub').value.trim() || undefined); $('fNsec').value = '';
  $('fNpub').value = r.npub; await refresh(); cur = jobs.find((j) => j.id === cur.id); fillForm(cur); banner('Key verified and saved for ' + r.npub);
};
$('fNsec').addEventListener('input', async () => { const v = $('fNsec').value.trim(); if (!/^nsec1\w{50,}$|^[0-9a-f]{64}$/i.test(v)) return; const r = await api.nostrDerive(v); $('keyStatus').textContent = r.ok ? 'Derives ' + r.data.npub + ($('fNpub').value && $('fNpub').value.trim() !== r.data.npub ? ' — ✗ does NOT match the npub above' : '') : r.error; });
$('testRelays').onclick = async () => { $('relayStatus').textContent = 'Testing…'; const r = await call('nostrTestRelays', $('fRelays').value.split(/\s+/).filter(Boolean)); $('relayStatus').textContent = r.map((x) => (x.ok ? '✓ ' : '✗ ') + x.url + (x.ok ? '' : ' (' + x.msg + ')')).join('   '); };
$('deleteJob').onclick = async () => { if (await call('jobsDelete', cur.id)) { cur = null; show('empty'); refresh(); } };
$('importLegacy').onclick = async () => { if (!cur?.id) return banner('Save the profile first.', true); const r = await call('jobImportLegacy', cur.id); if (r) banner(`Imported ${r.imported} mirrored posts; checkpoint ${r.newest_seen_id}.`); };

function renderPosts() {
  const pv = (cur && cur.id && previews[cur.id]) || { items: [], selected: new Set() };
  previewItems = pv.items; const box = $('posts'); box.replaceChildren();
  const c = { publish: 0, skip: 0, already: 0 }; previewItems.forEach((i) => c[i.status]++);
  $('pvSummary').textContent = previewItems.length ? `${pv.note || ''}${previewItems.length} posts: ${c.publish} can be published, ${c.already} already mirrored, ${c.skip} skipped by your rules.` : (pv.note || 'Fetch posts to preview them here. Nothing is posted until you confirm.');
  for (const it of [...previewItems].reverse()) {
    const d = el('div', 'post'); const cb = el('input'); cb.type = 'checkbox'; cb.dataset.xid = it.xid; cb.checked = pv.selected.has(it.xid); cb.disabled = it.status !== 'publish';
    cb.onchange = () => { if (cb.checked) pv.selected.add(it.xid); else pv.selected.delete(it.xid); updateSel(); };
    const body = el('div', 'body'); const meta = el('div', 'meta');
    meta.append(el('span', 'badge ' + it.status, it.status === 'skip' ? 'skip: ' + it.reason : it.status === 'publish' ? it.kind : 'already posted'), document.createTextNode('X post date ' + new Date(it.created_at).toLocaleString() + ' · ' + it.xid));
    body.append(meta, document.createTextNode(it.preview ? it.preview.content : '(not published)'));
    d.append(cb, body); box.append(d);
  }
  updateSel();
}
function updateSel() {
  const pv = cur && previews[cur.id]; const n = pv ? pv.selected.size : 0; const elig = pv ? pv.items.filter((i) => i.status === 'publish').length : 0;
  $('selCount').textContent = elig ? `${n} of ${elig} selected` : ''; $('selAll').checked = elig > 0 && n === elig;
  const busy = Boolean(cur && runs[cur.id]);
  $('publishSel').disabled = busy || !n; for (const b of ['pvNew', 'pvAll', 'pvFile', 'pvRange', 'runNow', 'deleteJob']) $(b).disabled = busy;
}
$('selAll').onchange = () => { const pv = cur && previews[cur.id]; if (!pv) return; pv.selected = new Set($('selAll').checked ? pv.items.filter((i) => i.status === 'publish').map((i) => i.xid) : []); renderPosts(); };
function renderStrip() {
  const strip = $('statusStrip'); strip.replaceChildren(); if (!cur || !cur.stats) return;
  const s = cur.stats; const r = runs[cur.id] || cur.lastRun;
  strip.append(stat('Posts mirrored', s.totalMirrored, s.importedHistorical ? `${s.publishedByApp} by this app + ${s.importedHistorical} imported` : 'unique, confirmed by relays'));
  strip.append(stat('Latest X post mirrored', fmtDate(s.lastSourcePostAt), 'original X date'));
  strip.append(stat('Last published', s.lastPublishAt ? fmt(Date.parse(s.lastPublishAt)) : '—', 'when this app sent it'));
  strip.append(stat('Waiting / failed', s.failed + s.pendingSigned, 'retried next run, same note id'));
  if (r) { const d = stat('Last run', '', `${r.mode}${r.trigger === 'schedule' ? ' (scheduled)' : ''} · ${fmt(r.endedAt || r.startedAt)}`); d.firstChild.append(el('span', 'runstate ' + r.status, r.status)); strip.append(d); }
}
function renderProgress() {
  const live = Object.values(runs); const g = $('globalProgress');
  g.classList.toggle('hidden', !live.length); g.replaceChildren();
  for (const r of live) {
    const j = jobs.find((x) => x.id === r.jobId); const c = r.counts || {}; const sel = c.selected || 0; const done = (c.completed || 0) + (c.failed || 0) + (c.deferred || 0);
    const row = el('div', '', `${j ? j.name : r.jobId}: ${runLine(r)}`);
    if (!r.dryRun) { const bar = el('div', 'bar'); const i = el('i'); i.style.width = (sel ? Math.round((100 * done) / sel) : 5) + '%'; bar.append(i); row.append(bar); }
    g.append(row);
  }
  if (live.length) g.append(el('div', 'muted', 'You can switch tabs, profiles or menus — publishing keeps running in the background. Closing the app will ask first.'));
  const rc = $('runCard'); const r = cur && (runs[cur.id] || (cur.lastRun && cur.lastRun.status !== 'running' && !cur.lastRun.dryRun ? cur.lastRun : null));
  rc.classList.toggle('hidden', !r); rc.replaceChildren();
  if (r) {
    rc.append(el('h2', '', runs[cur.id] ? 'Run in progress' : 'Last run'), el('div', 'runstate ' + r.status, r.status + (r.message ? ' — ' + r.message : '')));
    if (runs[cur.id]) { rc.append(el('div', 'muted', runLine(r))); if (!r.dryRun) { const b = el('button', '', 'Stop after current note'); b.onclick = () => call('jobCancel', cur.id); rc.append(b); } }
  }
  updateSel();
}
async function preview(fn, ...a) {
  if (!cur?.id) return banner('Save the profile first.', true);
  const id = cur.id; $('pvSummary').textContent = 'Fetching… (preview only, nothing is posted)';
  const r = await call(fn, id, ...a).catch(() => null);
  if (!r) { renderPosts(); return; }
  const note = (r.range ? `Range ${r.range.startTime || '…'} → ${r.range.endTime || '…'} UTC. ` : '') + (r.fetchComplete ? '' : 'Stopped at the page limit; fetch again for more. ') + (r.fetched === 0 ? 'X returned no posts for this request (dates outside the ~3,200 most recent posts cannot be fetched). ' : '');
  previews[id] = { items: r.items, selected: new Set(r.items.filter((i) => i.status === 'publish').map((i) => i.xid)), note };
  if (cur && cur.id === id) renderPosts();
}
$('pvNew').onclick = () => preview('jobPreview', 'incremental');
$('pvAll').onclick = () => preview('jobPreview', 'backfill');
$('pvRange').onclick = () => preview('jobPreview', 'range', { from: $('rFrom').value || undefined, to: $('rTo').value || undefined, timezone: $('rTz').value.trim() || undefined });
$('pvFile').onclick = () => preview('jobImportJson');
$('publishSel').onclick = async () => {
  const pv = previews[cur.id]; const ids = pv ? [...pv.selected] : [];
  if (!ids.length) return banner('Nothing selected.', true);
  const r = await call('jobPublish', cur.id, ids); if (r.cancelled) return;
  banner('Publishing started — progress is shown at the top. You can keep using the app.');
};
$('saveSched').onclick = saveJob;
$('runNow').onclick = async () => { const r = await call('jobRunNow', cur.id); if (!r.cancelled) banner('Run started — progress is shown at the top.'); };
async function loadActivity() {
  if (!cur?.id) return; const s = await call('jobSummary', cur.id); const st = $('stats'); st.replaceChildren();
  st.append(stat('By this app', s.publishedByApp), stat('Imported history', s.importedHistorical), stat('Skipped by rules', s.skipped), stat('Failed / waiting', s.failed + s.pendingSigned), stat('Checkpoint', s.checkpoint || '—'), stat('Full history done', s.backfillDone ? 'yes' : 'no'));
  $('log').textContent = (await call('jobLog', cur.id)) || 'No activity yet.';
}
$('saveToken').onclick = async () => { const t = $('xToken').value; $('xToken').value = ''; $('tokenStatus').textContent = 'Verifying…'; await call('xSaveToken', t).catch(() => {}); refresh(); };
$('clearToken').onclick = async () => { await call('xClearToken'); refresh(); };
$('ldInstall').onclick = async () => { const r = await call('launchdInstall'); if (!r.cancelled) banner(r.ok ? 'Background agent installed.' : 'launchctl: ' + r.out, !r.ok); refresh(); };
$('ldRemove').onclick = async () => { await call('launchdUninstall'); refresh(); };
$('cfgExport').onclick = async () => { if (await call('configExport')) banner('Exported (no keys or history included).'); };
$('cfgImport').onclick = async () => { const n = await call('configImport'); if (n) { banner(`Imported ${n} profiles (disabled until you add keys).`); refresh(); } };
onAppEvent((m) => {
  if (m.type === 'progress') { runs[m.run.jobId] = m.run; renderProgress(); if (cur && cur.id === m.run.jobId) renderStrip(); return; }
  if (m.type === 'run-finished') {
    const r = runs[m.jobId]; delete runs[m.jobId];
    if (r && !r.dryRun) { delete previews[m.jobId]; banner(`${(jobs.find((j) => j.id === m.jobId) || {}).name || 'Profile'}: ${r.status}${r.message ? ' — ' + r.message : ''}`, r.status !== 'done'); }
    refresh().then(() => { if (cur && cur.id === m.jobId) renderPosts(); }); return;
  } if (m.type === 'scheduled-run') { banner('Scheduled run: ' + m.results.map((r) => (r.ok ? '✓ ' : '✗ ') + r.published + ' published' + (r.error ? ' (' + r.error + ')' : '')).join(', '), m.results.some((r) => !r.ok)); refresh(); } });
async function syncProgress() { const r = await api.jobProgress(); if (!r.ok) return; for (const k of Object.keys(runs)) if (!r.data.find((x) => x.jobId === k)) delete runs[k]; for (const x of r.data) runs[x.jobId] = x; renderProgress(); }
setInterval(syncProgress, 3000);
$('aboutBtn').onclick = async () => {
  show('about'); const a = await call('aboutInfo'); $('aboutNpub').textContent = a.npub; $('aboutQr').src = a.qr; $('aboutVersion').textContent = status.version;
  $('aboutGuideOnline').disabled = !a.guideUrl; $('guideOnlineStatus').textContent = a.guideUrl ? a.guideUrl : 'Online guide not published yet — the built-in guide has the same content.';
};
$('copyNpub').onclick = async () => { await call('aboutCopyNpub'); banner('npub copied.'); };
$('openProfile').onclick = () => call('appOpenLink', 'authorProfile');
$('aboutGuideOnline').onclick = () => call('appOpenLink', 'guide');
async function openGuide() { show('guide'); $('guideText').textContent = await call('appGuide'); }
$('guideBtn').onclick = openGuide; $('aboutGuideLocal').onclick = openGuide;
refresh().then(syncProgress).then(() => (jobs.length ? openJob(jobs[0].id) : show('empty')));
