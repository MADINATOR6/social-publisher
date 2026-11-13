# Publisher: project brief

## Purpose and scope
A private, single-user web app to publish one video to the owner's own TikTok, Instagram and YouTube accounts from one place: connect accounts, drop in a video, write captions, choose destinations, publish, and follow each destination's status.

**In scope (v1):** video only; TikTok, Instagram Reels, YouTube (including Shorts-shaped videos); immediate publishing; post history; account connect, reconnect and disconnect; demo mode.
**Out of scope (v1):** images and documents, scheduling, analytics, AI captions, teams, subscriptions, editing tools, public deployment.

## Confirmed requirements
- Three sections: **Create post** (default), **Post history**, **Connected accounts**.
- Official OAuth only. The app never asks for or stores social media passwords.
- Tokens live only on the server, encrypted at rest (AES-256-GCM), never sent to the browser or written to logs.
- Persistent background jobs: publishing continues after the page is closed and resumes after a restart.
- Each destination is tracked on its own. States: `queued`, `uploading`, `processing`, `published`, `failed`, `needs_attention`.
- Success is only reported after the platform confirms it.
- Repeated clicks cannot create a second post record (client idempotency key, unique in the database; a restored draft reuses its key). This prevents duplicates inside the app; it cannot stop a duplicate on a platform whose API offers no way to check, so unclear outcomes are handed to the owner instead of retried blindly.
- Transient failures retry with bounded exponential backoff (5 attempts, at most 15 minutes apart).
- An attempt whose outcome is unknown is reconciled with the platform before any retry. A failed, timed-out, refused or unauthorised status lookup is **never** treated as proof that the upload failed: provider IDs and the "outcome unknown" flag are kept, the check is retried with backoff, and after the attempt limit the destination moves to `needs_attention` with where to look. A fresh upload starts only on platform evidence (see "Reconcile rules").
- Only failed destinations are retried.
- Uploaded videos are deleted after a retention period once every destination is finished (default 72 h).
- Demo mode is clearly labelled, kept apart from real accounts, and never shows a simulated post as real or with a link.
- Design: based on the owner's Ethereal Enchantment app (charcoal, slim sidebar, compact rows, hairline borders), but plainer and without the blue. One ember accent (#ff6b3d) for primary actions; other colour is used only for status. See DESIGN.md.

## Assumptions
- One owner, running it locally or on a private machine. Access is protected by a password (`APP_PASSWORD`) and a signed, httpOnly session cookie, with a CSRF header check on state-changing requests.
- TikTok defaults to **Send to TikTok inbox — finish posting in TikTok** (the `video.upload` inbox flow) because Direct Post is not available to this use case (see below).
- YouTube: a vertical or square video of 3 minutes or less becomes a Short automatically. No `#Shorts` tag is needed.

## Architecture
| Part | Choice | Why |
|---|---|---|
| UI | React 19 + Vite, plain CSS tokens | Small, fast, no UI framework to fight |
| API | Fastify 5 (`server/app.ts`) | Streams large uploads straight to disk |
| Worker | Separate Node process (`server/worker.ts`) | Publishing survives page closes and API restarts |
| Store | SQLite via built-in `node:sqlite` (WAL) | Persistent queue with no extra services or native builds |
| Media facts | `ffprobe` | Real duration, size, codec and dimensions for validation |

**Queue:** `targets` rows are claimed with a lease (`lease_owner`, `lease_until`, 60 s, kept alive by heartbeat). A lease that expires mid-step means the worker died, so the row is picked up again and flagged `uncertain`. Before continuing, the adapter's `reconcile()` asks the platform what actually happened.

**Reconcile rules** (`server/runner.ts`, each adapter's `reconcile()`):
| Platform | Restart only when | Otherwise |
|---|---|---|
| YouTube | No upload session was stored, or the session expired **before** the last part was sent (`finalSent` is recorded before that request). | Keep the session; a finished session returns the video ID. Session gone after the last part → `needs_attention` ("check YouTube Studio"). |
| Instagram | No container was stored (a Reel only goes live via `media_publish` with one), or the container is `ERROR`/`EXPIRED`. | `FINISHED` → publish the same container again (one container can only become one Reel). `PUBLISHED` → match exactly one recent Reel by caption and time; several identical captions → `needs_attention`, none yet → check again later. |
| TikTok | No publish ID was stored, or TikTok still reports `PROCESSING_UPLOAD` and the last part was never sent. | Keep polling the same publish ID; last part sent but not acknowledged → wait and check again. |

`RejectedError` marks a failure the platform itself confirmed (rejected or failed processing), which clears provider references so a later retry may upload afresh. Any other permanent error during a check becomes `needs_attention`.

**Worker health:** the worker writes a heartbeat to `worker_status` every 10 s on its own timer; `/api/status` reports `running`, `stale` (no beat for 45 s) or `never`. The web server answering is not taken as proof the worker runs.

**Drafts:** the composer saves caption, chosen destinations, platform fields, the server media ID and the idempotency key to `localStorage` (`sp.draft.v1`). No tokens or keys. Restoring only fills the form; if the video was cleaned up, the text is kept and the owner is asked to upload again.

**Adapter interface** (`server/platforms/types.ts`): `availability`, `validateSettings`, `authorizeUrl`, `exchangeCode`, `refresh`, `identity`, `revoke`, `run`, `reconcile`. Errors are typed: `TransientError` (retry), `AuthError` (reconnect), `AttentionError` (user action), `PermanentError` (fail, or `needs_attention` if the outcome may be unknown), `RejectedError` (platform-confirmed failure). Provider checkpoints (publish id, container id, resumable session URL) are saved in `provider_ref` as soon as they exist.

## Platform constraints (checked 13 Nov 2026)
**TikTok, Content Posting API.** [Get started](https://developers.tiktok.com/docs/en/content-posting-api-get-started) · [Sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) · [Upload](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video)
- Direct Post (`video.publish`) from an unaudited app is limited to private accounts, `SELF_ONLY` visibility and 5 users a day. The guidelines list "a utility tool that uploads content to accounts that you or your team manage" as not eligible for the audit. **So public direct posting is unavailable for this app.**
- The supported alternative, used by default, is Upload (`video.upload`). The video is sent to the creator's TikTok inbox, and the creator finishes and posts it in the TikTok app. The app shows this as **Needs attention: finish in TikTok**, never as published. Limits are 5 pending shares per 24 h and 6 requests per minute per token.
- Chunked `FILE_UPLOAD`: chunks of 5–64 MB, with the final chunk up to 128 MB. The upload URL is valid for 1 hour.
- `TIKTOK_DIRECT_POST_ENABLED=true` turns on the Direct Post code path, which checks `creator_info` first. Only use it if TikTok approves the app.

**Instagram, Instagram API with Instagram Login.** [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- Requires a Professional (Business or Creator) account and the scopes `instagram_business_basic` and `instagram_business_content_publish`.
- Reels are created from a **public `video_url`**. Resumable direct upload (`rupload`) is documented only for the Facebook Login path, so the app serves each video at a signed URL under `PUBLIC_BASE_URL` that expires after 6 hours.
- The flow is: create container (`media_type=REELS`) → poll `status_code` until `FINISHED` → `media_publish` → fetch `permalink`. The publishing limit is checked through `content_publishing_limit`. Meta's docs give 50 and 100 posts per 24 h in different places.
- Tokens are long-lived (60 days) and refreshed automatically once they are over 24 hours old.
- Without App Review, only accounts with a role on the Meta app (yours) can connect. That is fine for personal use.

**YouTube, Data API v3.** [Resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) · [Revision history](https://developers.google.com/youtube/data/revision_history)
- Uses `youtube.upload` and `youtube.readonly`, with resumable `videos.insert`. Visibility and "made for kids" are always sent explicitly.
- Since 2 Nov 2026, uploads from unverified projects are **no longer forced to private** (this reverses the July 2020 rule). Some older doc pages still say otherwise.
- Since 1 Jun 2026, `videos.insert` has its own quota bucket (100 calls a day by default).
- While the OAuth consent screen is in "Testing", Google expires refresh tokens after 7 days. Publish the consent screen (no verification is needed for your own use) to avoid weekly reconnects.

## External setup the owner must do
Platform keys are entered **in the app** (Connected accounts). Each platform has a short guide with direct links, the exact redirect address with a Copy button, and fields for the keys. Keys are stored encrypted in SQLite (`app_settings`), apply without a restart, override `.env`, and are never sent back to the browser (only a masked ID is shown).

1. **Secrets.** Copy `.env.example` to `.env`, then set `APP_PASSWORD`, `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`. `NO_SIGN_IN=true` skips the password for local testing only; set it to `false` **before** sharing the app, opening it to your network or starting a tunnel (the Instagram step below needs one).
2. **YouTube.** In Google Cloud, create a project, enable the YouTube Data API v3, configure the OAuth consent screen (External, add yourself as a test user, then publish it), and create an OAuth client of type Web application with redirect URI `{APP_URL}/api/oauth/youtube/callback`. Paste the Client ID and secret in the app.
3. **Instagram.** Make the Instagram account Professional. In Meta for Developers, create an app with the use case "Manage messaging & content on Instagram" (Instagram API with Instagram Login), add your Instagram account as an Instagram Tester and accept the invite, and set the OAuth redirect URI to `{APP_URL}/api/oauth/instagram/callback`. Paste the Instagram app ID and secret in the app. Finally, expose the app over HTTPS (for example `cloudflared tunnel --url http://localhost:8787`) and paste that address in the app (or set `PUBLIC_BASE_URL`).
4. **TikTok.** In TikTok for Developers, create an app, add Login Kit and the Content Posting API, request the scopes `user.info.basic` and `video.upload`, and set the redirect URI to `{APP_URL}/api/oauth/tiktok/callback`. TikTok requires redirect URIs to be HTTPS on a registered domain, so local `http://localhost` callbacks may be refused, and you may need the tunnel URL as `APP_URL`. Then paste the client key and secret in the app, and submit the app for review if TikTok requires it for `video.upload`.

## Acceptance criteria
- [x] Create post is the default screen, with a drag-and-drop or file picker upload, preview, filename, duration and upload progress.
- [x] Destination toggles show each account's name. There is a shared caption with per-platform overrides, a YouTube title and description, and platform settings.
- [x] Validation messages appear beside the relevant field, on both client and server.
- [x] Each destination has its own upload, processing and published progress, with links once confirmed.
- [x] OAuth connect, reconnect, disconnect (with revoke) and token refresh, with clear errors when sign-in fails.
- [x] Platform keys can be pasted in the app, with guided steps; no file editing or restart needed.
- [x] Persistent jobs survive page closes and process restarts, and reconcile before retrying.
- [x] Duplicate submits are prevented, transient failures retry with bounded backoff, and only failed destinations are retried.
- [x] Demo mode is separate, labelled, and never shows links or claims real success.
- [x] Lost responses and failed status checks never start a second upload or publish (regression tests in `tests/reconcile.test.ts`).
- [x] Readiness checklist before publishing; Publish stays disabled while anything blocks, and live checks are labelled as such.
- [x] Drafts survive refreshes without storing credentials, and cannot republish.
- [x] One result row per destination with an accurate status, explanation, confirmed link and a safe next step.
- [x] Worker status from its own heartbeat, and a persistent notice while sign-in is off.
- [ ] Real end-to-end publish to each platform. Blocked on credentials and setup; not run.
