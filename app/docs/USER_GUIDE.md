# X to Nostr Mirror: User Guide

X to Nostr Mirror is a desktop app for macOS (it also runs on Linux). It copies posts from X (Twitter)
accounts to Nostr accounts from your own computer. It can preview posts, publish them with their original
dates, skip posts it already copied, and run on a schedule.

There is no cloud service and no tracking. Your keys never leave your computer.

---

## 1. Install

1. Unzip the Apple Silicon (M1/M2/M3/M4) app build you were given.
   If you received it in parts, see *INSTALL-UPGRADE.txt*.
2. Move **X to Nostr Mirror.app** to **Applications**.
3. The app is not signed by Apple. The first time you open it, right-click the app, choose **Open**,
   then click **Open** again. You can also go to *System Settings → Privacy & Security → Open Anyway*.

### Upgrading

Quit the app, then replace the old app in Applications with the new one.

Your profiles, encrypted keys, schedules, history and background agent all stay. They live in
`~/Library/Application Support/X to Nostr Mirror/`, and the app keeps the same identity between versions.

When a new version starts for the first time, it backs up your settings and checkpoints to the
`backups/` folder inside the folder above.

macOS may ask once whether the new app can use its Keychain item ("X to Nostr Mirror Safe Storage").
Choose **Always Allow**.

---

## 2. What you need

### An X API Bearer token

The app reads posts through the official X API. Create a free developer account and an app at
**developer.x.com**, then copy the app's **Bearer token**.

- One token is used for **all** profiles. It belongs to *your developer app*, not to the X accounts you
  mirror. You can mirror any public account without logging in as that account.
- Your X username and password do **not** work.
- X decides which access level, credits or plan can read user timelines, and what it costs.
  Check the developer portal. This guide does not quote prices.
- In the app, open **Settings & X API**, paste the token and click **Verify & save**. The app makes one
  test call to X before saving it.

### A Nostr key pair

- **npub**: the public key of the Nostr account that will publish the notes.
- **nsec**: the secret key that signs the notes. Anyone with it can post as you. Keep it private.

---

## 3. Create a profile

Each profile copies one X account to one Nostr account. You can create as many profiles as you like.

1. Click **+ New profile**.
2. Type the X handle (for example `@news`) and click **Find account**.
3. Paste the destination **npub**, then the **nsec**, and click **Verify & save key**.
   The app checks that the nsec really belongs to that npub. The nsec is then encrypted with your Mac's
   Keychain and never shown again.
4. Relays: one `wss://` address per line. *Minimum relays that must accept* (default 2) decides when a
   post counts as published. Use **Test relays** to check that you can connect.
5. What to mirror:
   - Turned on by default: original posts, quote posts, your own threads, and threads whose first post
     was deleted.
   - Optional: reposts (posted as a link) and replies to other accounts.
6. Note timestamp:
   - **Original X time** backdates the note to when it was posted on X.
   - **Time of publishing** uses the moment the app publishes it.
7. First run:
   - **Include older posts** fetches the history the API allows.
   - **Only posts made from now on** starts with nothing old.
8. Click **Save profile**.

---

## 4. Fetch, preview and publish

Go to the **Posts** tab. Fetching only shows a **preview**. Nothing is posted yet.

- **Fetch new posts**: everything newer than the profile's checkpoint.
- **Fetch history (backfill)**: everything the X API returns for the account.
- **Fetch range**: choose a start date and an end date.
  - Both days are **included**, as whole calendar days in the **time zone** shown next to them
    (your computer's zone by default).
  - The app converts them to the UTC times X expects, and the request shows the exact UTC window.
  - The range is saved per profile.
  - The end date can't be in the future. A start date after the end date is rejected.
  - **X only returns about the latest 3,200 posts of an account**, so older dates can come back empty.
    That is an X limit, not a bug.
- **Load saved X JSON…**: preview posts from saved X API responses.

Each preview card shows the **original X date** and a badge:

- *original / quote / thread_reply*: will be published.
- *already posted*: it's in this profile's history, so it won't be posted again.
- *skip: reason*: not copied because of your rules.

Tick posts (or **Select all eligible**) and click **Publish selected**. A confirmation shows the account,
the relays and the timestamp mode. Publishing starts only after you confirm.

### While publishing

- A progress bar at the top shows: **posted**, **failed**, **waiting** (a thread reply waiting for its
  parent) and **still to go**, out of the number you selected.
- You can switch tabs, profiles, Settings, Guide or About. **Publishing continues** and the progress
  stays visible. Buttons that would clash with the run (fetch, publish, run now, delete) are disabled
  for that profile until it finishes.
- **Stop after current note** ends the run cleanly. Anything not sent is picked up next time.
- Closing the window or quitting asks first. If you quit anyway, the run stops and is marked
  **interrupted** next time you open the app. Nothing is lost.
- A post counts as published only when at least your minimum number of relays accept it.
  Otherwise it is shown as **failed** and retried later.

### Pictures and videos

- **Publishing:** Nostr notes **link** to the pictures and videos on X's own servers (`pbs.twimg.com`,
  `video.twimg.com`), with `imeta` tags so Nostr apps can show them.
  - Videos and GIFs link to the highest-quality MP4.
  - The app does **not upload** media anywhere. Nostr relays store text notes, not video files.
  - If X removes a file, the link in the note stops working.
  - Hosting copies elsewhere (for example a Blossom or nostr.build server) would need a storage service
    you choose. It isn't built in.
- **Saving copies to your computer (optional):** under the post list, open
  **Save selected posts & media to this computer**.
  1. **Choose folder…**: pick any folder, for example `Downloads/X to Nostr Mirror`. The app remembers it
     per profile and saves into a sub-folder named after the profile.
     - Only the exported files go there. Your keys, token, history and settings stay in the app's
       protected data folder and are never exported.
  2. Choose whether to include pictures and videos, and the video quality: highest-quality MP4 or
     smallest MP4.
  3. **Check download size**: the app asks X's media servers for each file's size, using a size-only
     request or a 1-byte request. It doesn't download the files.
     - Files whose size the server doesn't report are listed as *unknown*.
     - Videos only offered as a stream (HLS) can't be saved as one file and are listed separately.
     - Sizes are estimates; actual network use may differ slightly.
     - Fetching posts from the X API is separate. Its data size isn't known in advance, and X's API
       charges are a separate matter.
  4. **Save to folder…** shows the known total, the number of unknown sizes and a stop limit
     (5 GB by default), and asks you to confirm.
     - It writes `posts-<date>.json` (the selected posts' data) and the files in `media/`, two at a time,
       with live progress.
     - **Cancel download** stops safely. Unfinished files are deleted, never left half-written.
  - Running it again skips files already saved (tracked in `manifest.json`).
  - Existing files are never overwritten: a new copy gets `-2`, `-3`, and so on.
  - Only X's media servers are contacted, and no login or token is sent to them.

---

## 5. Status: what the numbers mean

The profile list and the top of each profile show:

- **Posts mirrored**: unique X posts confirmed on Nostr. If you imported an older checkpoint, the count
  is split into *by this app* and *imported*.
- **Latest X post mirrored**: the *original X date* of the newest post copied.
- **Last published**: when the app actually sent a note. With original timestamps the note appears on
  Nostr under its old X date, so these two dates can be years apart.
- **Waiting / failed**: posts that will be retried.
- **Last run**: done, failed, cancelled or interrupted, with a short summary. It survives restarts.

The **Activity** tab shows the log and the checkpoint.

---

## 6. Duplicate protection

- Every profile keeps its own history of *X post → Nostr note*. A post already in it is never posted again.
- The **checkpoint** only moves forward past posts that were fully handled. A failed post, and the
  thread replies after it, are tried again next time.
- Before sending a note, the app saves the **signed note** first. If the app crashes, or only some relays
  accept it, the next run re-sends **the same note (same ID)** rather than a new one. Relays treat it as
  the same note, so it never appears twice.
- Date-range and file-based publishing never move the checkpoint, so they can't make the app skip
  newer posts.
- Two runs of the same profile can't overlap.
- Don't run two different tools (or two computers) against the same Nostr account and X account at the
  same time. They each keep their own history.

---

## 7. Schedules

In the **Schedule** tab, set:

- a start date and time;
- how often to run (at least every 15 minutes);
- optionally, active hours and a time zone.

Then tick **Allow scheduled runs to publish without preview**. Nothing runs automatically until you do.

- **While the app is open**, it checks every minute.
- **When the app is closed**, go to *Settings → Install background agent*. This adds a macOS LaunchAgent
  that starts the app hidden every 15 minutes, runs anything due, and quits. Remove it from the same
  screen.
- **A Mac that is asleep, shut down or offline runs nothing.** When it wakes, missed runs combine into
  one catch-up run. Nothing is skipped; it is just posted later. With original timestamps the notes
  still carry their X dates.
- After repeated errors (for example an expired token) a profile waits longer between attempts,
  starting at 15 minutes and growing up to 12 hours.

---

## 8. Keys and privacy

- The X token and every nsec are encrypted with the macOS Keychain (Electron *safeStorage*).
- If secure storage isn't available, the app refuses to save secrets. It never falls back to plain text.
- Secrets are never shown again, logged or exported.
- **Export/Import** in Settings moves profile settings only: no keys, no tokens and no history.
  Imported profiles start disabled.
- The app sends no analytics. It only connects to the X API and to the relays you choose.
- Nostr notes can't be reliably deleted once published. Preview first.

---

## 9. Moving from an older script-based mirror

1. Create the profile with the schedule turned **off**.
2. Stop the old mirror.
3. Click **Import old mirror checkpoint…** and choose its `state.json`. Posts it already copied are
   counted as *imported* and won't be posted again.
4. Fetch new posts, check the preview, then turn on the schedule.

---

## 10. Troubleshooting

| Message | What to do |
|---|---|
| 401 from X | The token is wrong or was regenerated. Save a new one. |
| 403 from X | Your X developer access doesn't include this endpoint. Check your plan. |
| Rate limit | The app waits for X's reset time automatically. Try later for big backfills. |
| Only n/m relays accepted | The relay may be down or rate-limiting. The same note is retried next run. |
| Secure storage unavailable | Linux without a keyring. On macOS, allow the Keychain prompt. |
| Media size unknown | The server didn't report it; the download still works and is limited by the stop limit. |
| Range returns nothing | The dates are older than the ~3,200 posts X makes available, or there were no posts. |

---

*X to Nostr Mirror is open software, released under the MIT license.*
