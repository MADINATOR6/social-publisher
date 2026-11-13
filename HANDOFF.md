# Handoff

**Updated:** 2026-11-14 01:35 PST
**Source (permanent):** `/Users/arnidokarlosantinos./Projects/social-publisher`. An older copy remains in Claude's temporary session folder and is deleted with that session.
**Packaged app:** `/Users/arnidokarlosantinos./Projects/social-publisher/release/mac-arm64/Publisher.app` (DMG: `release/Publisher-1.0.0-arm64.dmg`)
**App data:** `~/Library/Application Support/Publisher/` (database, videos, settings, Keychain-protected `keys.json`, logs)
**Git:** local commits only, no remote.

## Objective
A private Mac app that publishes one video to the owner's YouTube, Instagram Reels and TikTok, with reliable background jobs.

## Build and launch
- Build: `cd ~/Projects/social-publisher && npm run package` (optional DMG: `npm run package:dmg`)
- Launch: double-click `Publisher.app`, or drag it into Applications first. No Terminal, dev server or Node install needed.
- Development: `npm run dev` (browser, uses `.env`) or `npm run desktop:dev` (Electron, unpackaged).

## Done this pass
- **Desktop app.** Electron 45.3.2 with compiled backend and worker on Electron's Node 24.22.2. Supervised services with readiness waits and crash restarts, a single-instance lock, a loopback-only API with a per-launch cookie, Keychain-protected keys, and a free-port fallback.
- **Mac behaviour.** Closing the window hides it while jobs continue, the Dock reopens it, and Cmd+Q asks Keep Running or Quit and Resume Later when jobs are active. On quit, jobs are handed back to be checked first on the next launch.
- **Sign-in from the desktop.** Sign-in opens in the default browser with one-use server-side state plus PKCE. YouTube uses a Google **Desktop app** client (loopback redirect). Instagram and TikTok need the HTTPS tunnel address.
- **Desktop additions.** Native video picker, About panel with version, Help → Reveal Logs in Finder, and backend and worker status.
- **Recovery fix.** Status checks no longer need the local video. Only sending bytes does (`ctx.needFile()`), with a regression test.
- **Data import.** The existing project's data was imported into the app: 6 posts, 14 destinations, 3 accounts, 4 videos. The key check passed. `.env` and `data/` in the source folder were left untouched.

## Checks actually performed
- `npm test`: **55 of 55 pass**, including desktop auth, the OAuth handoff and the cleaned-up-video recovery. `npm run typecheck` (server, web, desktop): passes.
- **Packaged app**, launched from `release/Test Folder With Spaces/Publisher.app` with no dev servers running:
  - **Startup and isolation:** started its own API and worker. The renderer has no `require` or `process`.
  - **Upload and publish:** a video uploaded through the page's upload path, the bundled ffprobe read 1080×1920 and 0:06 (it also runs with an empty environment, so no PATH or Homebrew), the preview played, and a demo publish completed, including a simulated retry.
  - **Persistence:** history persisted across launches.
  - **Quit with pending jobs:** a quit with jobs pending was held back by the confirmation dialog.
  - **Force-kill recovery:** after a force-kill mid-job and a relaunch, both pending jobs resumed and finished.
  - **Window reopen:** the Dock or `open` reopened the window, still with a single process.
  - **Port conflict:** with 8787 taken, the app used a free port.
  - **API lockdown:** the API returns 401 without the app cookie, password login returns 403, and the server is not reachable from the LAN address.
  - **Missing key:** with the key file missing and the database present, the app refused to start and did not create a key.
  - **Missing credentials:** the setup guide shows Desktop-app steps, and trying to connect returns "not set up yet".
  - **Privacy:** the data and log folders are mode 700 and `keys.json` is 600. No tokens appear in the logs.
- **Not verified by automation** (screen control was declined): the red close button or Cmd+W hiding the window, clicking the quit dialog's buttons, and the native picker dialog itself.

## Remaining limitations
- **Signing:** the app is ad-hoc signed and `spctl` rejects it. It opens on this Mac. Other Macs need Developer ID signing and notarisation, which requires an Apple Developer account. A rebuild may trigger a Keychain prompt; choose Always Allow.
- **OAuth:** developer credentials are not confidential in a local app. Instagram and TikTok need a public HTTPS tunnel, and their redirect must match the port in use (8787 unless it was busy). TikTok public Direct Post is unavailable, so videos go to the TikTok inbox to finish by hand.
- **Publishing:** jobs stop while the app is quit or the Mac sleeps. **No real platform publish has been run.** Everything was tested in demo mode or against mocked APIs.

## Recommended next task
In the app, open Connected accounts, create a Google **Desktop app** OAuth client, paste its keys, connect, then run one owner-authorised **private** YouTube upload end to end.
