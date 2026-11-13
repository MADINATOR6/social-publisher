# Publisher sign-in relay

A small Cloudflare Worker that lets customers connect YouTube, Instagram and TikTok with one click. Without it, every customer would have to create developer apps and run a tunnel.

## What it does
- **Holds the secrets.** The client secrets of your Google, Meta and TikTok apps live here as Worker secrets. They never ship inside the app.
- **Owns the redirect address.** Each platform sends the browser back to `https://<relay>/callback/<platform>`. The relay forwards the code to the Publisher app on the customer's PC (`http://127.0.0.1:<port>`, and nowhere else). The app then swaps the code for tokens through `/token/<platform>`.
- **Renews sign-ins.** `/refresh/youtube` and `/refresh/tiktok` add the secret to token refreshes. `/revoke/tiktok` does the same for disconnects.
- **Hosts Instagram videos briefly.** Instagram Login can only publish a Reel from a public URL. The app uploads the video to R2, Instagram downloads it from a signed link (valid 6 hours), and the app deletes it. An hourly cron removes anything older than 24 hours. Only someone holding a working Instagram token can upload.
- **Serves the public pages** the platform reviews ask for: `/` (home), `/terms` and `/privacy`.

It keeps no database and stores no tokens. Platform errors are passed through unchanged, so the app can tell an expired sign-in from an outage.

## Set it up
You need a Cloudflare account. The free plan covers the Worker. R2 has a free tier, but Cloudflare asks for a payment method before enabling it.

1. Sign in, and create the video bucket. Run this from the repository root:
   ```
   npx wrangler login
   npx wrangler r2 bucket create publisher-media
   ```
2. Fill in the `[vars]` in `relay/wrangler.toml`:
   - `OPERATOR_NAME` and `CONTACT_EMAIL`, which are shown on the Terms and Privacy pages.
   - `GOOGLE_CLIENT_ID`, `TIKTOK_CLIENT_KEY` and `INSTAGRAM_APP_ID`.
3. Add the secrets. Each command prompts for the value, so nothing is saved in a file.
   ```
   npx wrangler secret put GOOGLE_CLIENT_SECRET --config relay/wrangler.toml
   npx wrangler secret put TIKTOK_CLIENT_SECRET --config relay/wrangler.toml
   npx wrangler secret put INSTAGRAM_APP_SECRET --config relay/wrangler.toml
   npx wrangler secret put SIGNING_KEY --config relay/wrangler.toml
   ```
   `SIGNING_KEY` is any long random value, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
4. Deploy: `npm run relay:deploy`. It prints the address, for example `https://publisher-relay.<you>.workers.dev`.
   - Google verification needs the home and privacy pages on a domain you own and have verified. Add a custom domain to the Worker in the Cloudflare dashboard (Workers → publisher-relay → Settings → Domains), then use that address everywhere below.
5. Check it: open `https://<relay>/health`. Each platform with its keys set shows `true`.
6. Register the redirect address in each platform:
   - **Google Cloud:** create an OAuth client of type **Web application**. Add `https://<relay>/callback/youtube` as an authorized redirect URI. Enable the YouTube Data API v3.
   - **Meta (Instagram API with Instagram login):** in Business login settings, add `https://<relay>/callback/instagram` as the OAuth redirect URI.
   - **TikTok (Login Kit):** add `https://<relay>/callback/tiktok` as a redirect URI.
7. Build the app with the relay in it:
   ```
   $env:PUBLISHER_RELAY_URL = "https://<relay>"
   npm run windows:build
   ```
   `PUBLISHER_RELAY_PLATFORMS` (for example `youtube`) limits one-click Connect to the platforms that are approved so far. The rest still accept developer keys.

## Reviews before strangers can connect
Until each review passes, only accounts you add as testers can connect.
- **Google:** OAuth consent screen verification for the `youtube.upload` scope (sensitive). It needs the home and privacy pages on your verified domain and a demo video. Ask for a YouTube API quota increase too: by default `videos.insert` allows 100 uploads a day, shared by all your customers.
- **Meta:** App Review for `instagram_business_basic` and `instagram_business_content_publish`, plus business verification. Customers need a Professional (Business or Creator) Instagram account.
- **TikTok:** app review for Login Kit (`user.info.basic`) and Content Posting API (`video.upload`). Videos go to the customer's TikTok inbox as drafts. Posting directly needs a further audit.

Use `https://<relay>/terms` and `https://<relay>/privacy` in each form. Have the wording checked for your situation before you rely on it.

## Safety notes
- Codes are forwarded only to `127.0.0.1`. The port and the app's one-use state ride inside the platform's `state`, which the app checks.
- YouTube sign-in uses PKCE end to end, so an intercepted code is useless without the app's verifier.
- Add a Cloudflare rate-limiting rule on `/token/*`, `/refresh/*` and `/media` once real traffic starts.
- Errors are logged by name only, never with request details, so tokens do not end up in Cloudflare logs.

## Test
`npm run relay:test` runs the relay in Node against an in-memory R2 stand-in and stubbed platforms. Nothing leaves the machine.
