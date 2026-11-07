'use strict';
// Import a checkpoint from the earlier script-based mirror (state.json) so nothing is re-posted.
// Copies only public bookkeeping: X id -> Nostr event id maps and the watermark. No keys.
const M = require('./mirror');
function importLegacyState(legacy, current = M.emptyState()) {
  if (!legacy || typeof legacy.mirrored !== 'object') throw new Error('Not a mirror state file (missing "mirrored")');
  const ok = (k, v) => /^\d+$/.test(k) && typeof v === 'string';
  const st = M.migrateState(current);
  let n = 0;
  for (const [k, v] of Object.entries(legacy.mirrored)) if (ok(k, v) && /^[0-9a-f]{64}$/.test(v)) { if (!st.mirrored[k]) { st.mirrored[k] = v; st.imported[k] = 'legacy'; n++; } }
  for (const [k, v] of Object.entries(legacy.roots || {})) if (ok(k, v)) st.roots[k] = v;
  for (const [k, v] of Object.entries(legacy.skipped || {})) if (ok(k, v)) st.skipped[k] = v;
  for (const [k, v] of Object.entries(legacy.csv_posted || {})) if (ok(k, v) && !st.mirrored[k]) st.skipped[k] = 'posted_by_csv';
  if (legacy.newest_seen_id && /^\d+$/.test(legacy.newest_seen_id)) st.newest_seen_id = M.maxId(st.newest_seen_id, legacy.newest_seen_id);
  if (legacy.newest_mirrored_id) st.newest_mirrored_id = M.maxId(st.newest_mirrored_id, legacy.newest_mirrored_id);
  st.mirrored_any = n > 0 || st.mirrored_any; st.backfill_done = true;
  return { state: st, imported: n, pendingFailed: Object.keys(legacy.failed || {}).length };
}
module.exports = { importLegacyState };
