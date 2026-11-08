#!/usr/bin/env node
// Static security checks for the Electron app. Exits non-zero on any failure.
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..'); const r = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const main = r('src/main/main.js'), pre = r('src/main/preload.js'), html = r('src/renderer/index.html'), app = r('src/renderer/app.js');
const core = fs.readdirSync(path.join(root, 'src/core')).map((f) => r('src/core/' + f)).join('\n');
const checks = [
  ['contextIsolation enabled', /contextIsolation:\s*true/.test(main)],
  ['renderer sandbox enabled', /sandbox:\s*true/.test(main)],
  ['nodeIntegration disabled', /nodeIntegration:\s*false/.test(main) && !/nodeIntegration:\s*true/.test(main)],
  ['webSecurity not disabled', !/webSecurity:\s*false/.test(main)],
  ['no remote module / webviews', !/enableRemoteModule|webviewTag:\s*true|<webview/i.test(main + html)],
  ['navigation blocked', /will-navigate[^\n]*preventDefault/.test(main)],
  ['window.open denied', /setWindowOpenHandler[\s\S]{0,300}action:\s*'deny'/.test(main)],
  ['non-file requests from renderer cancelled', /onBeforeRequest/.test(main)],
  ['permissions denied', /setPermissionRequestHandler\([^)]*\)\s*=>\s*cb\(false\)/.test(main)],
  ['IPC sender frame validated', /senderFrame/.test(main)],
  ['preload exposes fixed channel allowlist only', /const CHANNELS = \[/.test(pre) && !/ipcRenderer\.(send|invoke)\(\s*[a-z]+\s*,/i.test(pre.replace(/ipcRenderer\.invoke\(c,/, '')) && !/exposeInMainWorld\('ipcRenderer'/.test(pre)],
  ['strict CSP (no unsafe-inline/eval, connect none)', /default-src 'none'/.test(html) && !/unsafe-(inline|eval)/.test(html) && /connect-src 'none'/.test(html)],
  ['no inline scripts/handlers in HTML', !/<script>(?!<\/script>)|\son\w+=/i.test(html)],
  ['renderer never uses innerHTML/eval', !/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(app)],
  ['renderer makes no network calls', !/fetch\(|XMLHttpRequest|WebSocket/.test(app)],
  ['no secret getter exposed over IPC', !/handle\('[^']*(getSecret|secret:get|nsec:get|token:get)/i.test(main)],
  ['secret store fails closed on basic_text', /basic_text/.test(core) && /isEncryptionAvailable/.test(core)],
  ['no plaintext secret fallback', !/writeFileSync\([^)]*(nsec|bearer)/i.test(main + core)],
  ['no telemetry/analytics', !/analytics|telemetry|sentry|mixpanel|segment\.io/i.test(main + core + app)],
  ['no hard-coded homebrew/node path', !/\/opt\/homebrew|\/usr\/local\/bin\/node/.test(main + core)],
  ['X API base URL locked to api.x.com', /hostname === 'api\.x\.com'/.test(core)],
  ['relays require wss (ws only loopback+opt-in)', /allowLoopbackWs/.test(core)],
  ['external links only via fixed allowlist', !/shell\.openExternal\((?!About\.externalUrl\()/.test(main) && /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/.test(main)],
  ['clipboard only writes the fixed author npub', (main.match(/clipboard\.writeText\(/g) || []).length === 1 && /clipboard\.writeText\(About\.validNpub\(About\.AUTHOR_NPUB\)\)/.test(main)],
  ['no donation/payment addresses', !/lightning:|lnurl|bc1q|lud16/i.test(main + core + app + html)],
  ['media downloads restricted to X media CDN hosts', /MEDIA_HOSTS = \['pbs\.twimg\.com', 'video\.twimg\.com'\]/.test(core) && /redirect: 'manual'/.test(core)],
  ['media requests never send credentials', /credentials: 'omit'/.test(core) && !/Authorization/.test(r('src/core/media.js'))],
  ['shell.openPath only opens the chosen export folder', (main.match(/shell\.openPath\(/g) || []).length === 1 && /shell\.openPath\(j\.downloadFolder\)/.test(main)],
  ['exported profile settings exclude local folder paths', /consecutiveFailures, downloadFolder, \.\.\.rest/.test(main)],
  ['no console logging of secrets', !/console\.(log|error)\([^)]*(nsec|bearer|getSecret|secrets\.get)/i.test(main + core)],
];
let fail = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
// no real data shipped
const shipped = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(f)) walk(p); } else shipped.push(p); } })(root);
const leaks = shipped.filter((p) => !p.endsWith('.png') && /nsec1[02-9ac-hj-np-z]{58}/.test(fs.readFileSync(p, 'utf8')));
const self = leaks.filter((p) => !p.endsWith('security-check.js'));
console.log((self.length ? 'FAIL ' : 'PASS ') + 'no secret keys (nsec) in project files' + (self.length ? ': ' + self.join(', ') : ''));
if (self.length) fail++;
console.log(fail ? `\n${fail} check(s) failed` : '\nAll security checks passed'); process.exit(fail ? 1 : 0);
