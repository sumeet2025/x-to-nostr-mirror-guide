'use strict';
// macOS LaunchAgent generation. Registration only happens on explicit user action in the UI.
// The agent launches this same app binary with --run-due, which runs due jobs then exits.
const path = require('path');
const LABEL = 'org.example.xnostrmirror.scheduler';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistXml({ programArgs, intervalSeconds = 900, logDir }) {
  if (!Array.isArray(programArgs) || !programArgs.length) throw new Error('programArgs required');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 300) throw new Error('interval too small');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}
// Resolve program args dynamically from the running app (no hard-coded node/homebrew paths).
function programArgsFor({ execPath, appPath, isPackaged }) {
  return isPackaged ? [execPath, '--run-due'] : [execPath, appPath, '--run-due'];
}
function plistPath(home) { return path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist'); }
module.exports = { LABEL, plistXml, programArgsFor, plistPath };
