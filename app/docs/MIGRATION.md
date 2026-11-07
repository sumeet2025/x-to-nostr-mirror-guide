# Migrating from the earlier script-based mirror

The old setup keeps running until you decide to switch. Do it in this order so nothing is posted twice:

1. Install the app, save the X Bearer token, create a profile for the same X account and npub, save the nsec.
   Leave the schedule **disabled**.
2. Stop the old mirror (e.g. pause the old scheduled job/routine). Wait until it is not mid-run.
3. Copy the old `state.json` to your Mac (it contains only post ids and Nostr event ids, no keys).
4. In the profile, click **Import old mirror checkpoint…** and choose that file. The app merges:
   `mirrored` (X id → event id), `roots` (thread roots, so new replies attach to old threads), `skipped`,
   `csv_posted` (recorded as skipped so they are not reposted) and `newest_seen_id` (the checkpoint).
   Malformed entries are ignored; nothing else is copied.
5. Posts tab → **Fetch new posts**: the preview should show only posts newer than the old checkpoint.
6. Enable the schedule and *Allow scheduled runs to publish*. Optionally install the background agent.

Never run the old mirror and the app against the same account at the same time: each keeps its own
checkpoint and they would both post new items.
