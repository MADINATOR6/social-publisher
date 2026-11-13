# Handoff

**Updated:** 2026-11-14 01:05 PST
**Path:** `/Users/arnidokarlosantinos./Library/Application Support/Claude-Account2/scratch-workspaces/77dbbdcd-dba2-47dc-890e-5d24e0d3f9ae/8f22af67-7648-4878-ae17-c4776b60d570/scratch-2026-11-10-568d7e/social-publisher`
**Warning:** this is Claude's temporary session folder; deleting the session deletes it. See "Moving the project".
**Git:** local repo, branch `main`, one checkpoint commit, no remote. `.env`, `data/`, videos, `node_modules/` and `dist/` are excluded.

## Objective
A private, local app that publishes one video to the owner's YouTube, Instagram Reels and TikTok from one screen, with reliable background jobs.

## Implemented this pass
1. **Safe uncertain-outcome retries.** A status lookup that fails, times out, is refused or needs a new sign-in no longer triggers a fresh upload. Provider IDs and the "outcome unknown" flag are kept, checks retry with backoff, then end in `needs_attention` with where to look. Restarts happen only on platform evidence (rules in PROJECT.md). Instagram no longer picks the first of several identical captions.
2. **Readiness checklist.** For each destination: account, saved keys, connection, local video checks, required fields, Instagram's public address and TikTok's real delivery mode ("Send to TikTok inbox — finish posting in TikTok"). "Check now" runs a read-only live identity check; only that is labelled "verified live". Publish stays disabled while anything blocks.
3. **Drafts.** Text, destinations, settings and the server media ID survive refreshes (browser storage, no credentials). An expired video keeps the text and asks for a new upload. A restored draft reuses its idempotency key, so it cannot post twice. Discard draft is available.
4. **Results.** One row per destination: account, status (Uploading, Processing, Published, Finish in TikTok, Outcome unknown, Reconnect needed, Failed), a plain explanation, a confirmed link and one safe action. "Check again" only asks the platform. "Retry failed destinations" and "Create another post" are separate.
5. **Local operation.** Worker status comes from the worker's own heartbeat. A persistent "Sign-in off · local only" chip shows while `NO_SIGN_IN=true`.
6. **Bug fixed:** signed video links exceeded Fastify's 100-character parameter limit (HTTP 414), breaking draft previews and, later, Instagram's video download.

## Checks actually run
- `npm test`: **52 of 52 pass**, including `tests/reconcile.test.ts`. Per platform it simulates a successful upload with a lost response, then failed lookups (outage, refusal, expired sign-in), and confirms no second upload or publish. It also covers ambiguous Instagram matches, the attempt limit and evidence-based restarts.
- `npm run build` (both typechecks plus the Vite build): passes. The design detector reports no findings.
- Browser (demo mode, desktop and 375 px): draft restore with video, blocked then ready checklist, simulated publish, draft cleared afterwards, expired-video draft, an "Outcome unknown" row with Check again, worker status and the sign-in notice. No horizontal scroll.

## Mocked, untested or blocked
- **No real publish has run.** Platform behaviour is tested against mocked APIs only.
- Reconcile rules rely on documented provider behaviour (for example, YouTube creates a video only after the last byte). Not observed live.
- **Sign-in is off** (`NO_SIGN_IN=true` in `.env`). Set it to `false` before sharing the app or starting a tunnel.
- TikTok public Direct Post is unavailable to unaudited personal tools. Instagram needs a public HTTPS tunnel. TikTok may refuse `localhost` redirects.
- Not tested: real token refresh, Google's 7-day Testing-mode expiry, multi-GB files.

## External setup still needed
Paste Google OAuth keys in Connected accounts (steps in PROJECT.md). Instagram and TikTok later.

## Moving the project (recommended before real use)
1. Stop the app so the worker and database close.
2. Copy the folder **with `.env` and `data/` together**: the database is encrypted with the key in `.env`. For example: `rsync -a --exclude node_modules --exclude dist <path above>/ ~/Projects/social-publisher/`
3. In the new folder: `chmod 600 .env && chmod 700 data`, then `npm install && npm test && npm run dev`.
4. Delete the old session only after the new copy works.

## Recommended next task
One owner-authorised **private** YouTube upload, end to end.

## Files to review
`server/runner.ts`, `server/platforms/*.ts`, `server/jobs.ts`, `src/pages/Create.tsx`, `src/pages/Readiness.tsx`, `src/pages/Results.tsx`, `tests/reconcile.test.ts`.
