// Regression tests: an upload that succeeded but whose response was lost, followed by status checks
// that fail. None of these may start a fresh upload or publish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNext, createPost, getTarget, postView, MAX_ATTEMPTS } from '../server/jobs.js';
import { runTarget } from '../server/runner.js';
import { getDb } from '../server/db.js';
import { getAccount } from '../server/accounts.js';
import { freshDb, instantSleep, seedAccount, seedMedia } from './helpers.js';

type Handler = (url: string, init: any) => Response | Promise<Response>;
function mockFetch(routes: [RegExp, Handler][]) {
	const calls: { url: string; method: string; range?: string }[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
		const url = String(input);
		calls.push({ url, method: init.method ?? 'GET', range: init.headers?.['Content-Range'] });
		const r = routes.find(([re]) => re.test(url));
		if (!r) throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
		return r[1](url, init);
	});
	return calls;
}
const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const lost = () => Promise.reject(new TypeError('socket hang up'));
const outage = () => new Response(JSON.stringify({ error: { code: 503, message: 'backendError' } }), { status: 503 });

beforeEach(() => freshDb());
afterEach(() => vi.restoreAllMocks());

function newTarget(platform: 'youtube' | 'instagram' | 'tiktok', settings: object) {
	const m = seedMedia(3 * 1024 * 1024);
	const a = seedAccount(platform);
	const p = createPost({ idempotencyKey: `k-${Math.random()}`, mediaId: m, caption: 'same caption', isDemo: false, targets: [{ accountId: a.id, platform, settings: settings as any }] });
	return { targetId: postView(p.id)!.targets[0].id, accountId: a.id };
}
/** Makes a queued target due now and runs it, as the worker would. */
async function runAgain(id: string) {
	getDb().prepare('UPDATE targets SET next_run_at = 0 WHERE id = ?').run(id);
	const t = claimNext('w');
	expect(t?.id).toBe(id);
	await runTarget(t!, 'w', instantSleep);
	return getTarget(id)!;
}
const ref = (id: string) => JSON.parse(getTarget(id)!.provider_ref ?? '{}');

describe('lost response, then failed status checks', () => {
	it('YouTube: keeps the upload session and never starts a second upload', async () => {
		let lookup: 'lost' | 'outage' | 'auth' | 'done' = 'lost';
		const calls = mockFetch([
			[/uploadType=resumable/, () => new Response('', { status: 200, headers: { location: 'https://upload.example/s1' } })],
			[/upload\.example\/s1/, (_u, i) => {
				const query = String(i.headers['Content-Range']).startsWith('bytes */');
				if (!query) return lost(); // YouTube got every byte, but the reply never arrives
				if (calls.filter((c) => c.range?.startsWith('bytes */')).length === 1) return new Response('', { status: 308 });
				if (lookup === 'outage') return outage();
				if (lookup === 'auth') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 });
				return ok({ id: 'vid1' });
			}],
			[/part=status/, () => ok({ items: [{ status: { uploadStatus: 'processed' } }] })],
		]);
		const { targetId, accountId } = newTarget('youtube', { title: 'T', privacy: 'private', madeForKids: false });
		const uploads = () => calls.filter((c) => c.method === 'PUT' && !c.range?.startsWith('bytes */')).length;
		const sessions = () => calls.filter((c) => c.url.includes('uploadType=resumable')).length;

		await runTarget(claimNext('w')!, 'w', instantSleep);
		let t = getTarget(targetId)!;
		expect(t.state).toBe('queued');
		expect(t.uncertain).toBe(1);
		expect(ref(targetId)).toMatchObject({ sessionUrl: 'https://upload.example/s1', finalSent: true });

		lookup = 'outage';
		t = await runAgain(targetId);
		expect(t.state).toBe('queued');
		expect(t.uncertain).toBe(1);
		expect(ref(targetId).sessionUrl).toBe('https://upload.example/s1');

		lookup = 'auth';
		t = await runAgain(targetId);
		expect(t.state).toBe('needs_attention');
		expect(t.uncertain).toBe(1);
		expect(getAccount(accountId)!.status).toBe('reconnect_required');
		expect(postView(t.post_id)!.targets[0].outcomeUnknown).toBe(true);

		expect(sessions()).toBe(1);
		expect(uploads()).toBe(1);

		// Owner reconnects and presses "Check again": the same session reports the finished video.
		getDb().prepare("UPDATE accounts SET status = 'connected' WHERE id = ?").run(accountId);
		getDb().prepare("UPDATE targets SET state = 'queued' WHERE id = ?").run(targetId);
		lookup = 'done';
		t = await runAgain(targetId);
		expect(t.state).toBe('published');
		expect(t.remote_id).toBe('vid1');
		expect(sessions()).toBe(1);
		expect(uploads()).toBe(1);
	});

	it('YouTube: a refused status lookup is not treated as a failed upload', async () => {
		const calls = mockFetch([[/upload\.example\/s2/, () => new Response(JSON.stringify({ error: { code: 400, message: 'badRequest' } }), { status: 400 })]]);
		const { targetId } = newTarget('youtube', { title: 'T', privacy: 'private' });
		getDb().prepare("UPDATE targets SET provider_ref = ?, phase = 'upload', uncertain = 1 WHERE id = ?").run(JSON.stringify({ sessionUrl: 'https://upload.example/s2', finalSent: true }), targetId);
		const t = await runAgain(targetId);
		expect(t.state).toBe('needs_attention');
		expect(t.error).toContain('YouTube Studio');
		expect(t.uncertain).toBe(1);
		expect(calls.every((c) => c.range?.startsWith('bytes */'))).toBe(true);
	});

	it('YouTube: an expired session after the last part was sent needs the owner, not a new upload', async () => {
		const calls = mockFetch([[/upload\.example\/s3/, () => new Response('', { status: 404 })]]);
		const { targetId } = newTarget('youtube', { title: 'Holiday', privacy: 'private' });
		getDb().prepare("UPDATE targets SET provider_ref = ?, phase = 'upload', uncertain = 1 WHERE id = ?").run(JSON.stringify({ sessionUrl: 'https://upload.example/s3', finalSent: true }), targetId);
		const t = await runAgain(targetId);
		expect(t.state).toBe('needs_attention');
		expect(t.error).toContain('Holiday');
		expect(calls.some((c) => c.url.includes('uploadType=resumable'))).toBe(false);
	});

	it('YouTube: an expired session before the last part was sent is safe to restart', async () => {
		let n = 0;
		const calls = mockFetch([
			[/upload\.example\/old/, () => new Response('', { status: 404 })],
			[/uploadType=resumable/, () => new Response('', { status: 200, headers: { location: 'https://upload.example/new' } })],
			[/upload\.example\/new/, (_u, i) => (String(i.headers['Content-Range']).startsWith('bytes */') ? new Response('', { status: 308 }) : (n++, ok({ id: 'v2' })))],
			[/part=status/, () => ok({ items: [{ status: { uploadStatus: 'processed' } }] })],
		]);
		const { targetId } = newTarget('youtube', { title: 'T', privacy: 'private' });
		getDb().prepare("UPDATE targets SET provider_ref = ?, phase = 'upload', uncertain = 1 WHERE id = ?").run(JSON.stringify({ sessionUrl: 'https://upload.example/old' }), targetId);
		let t = await runAgain(targetId); // session gone, nothing created: clears and retries
		expect(t.state).toBe('queued');
		t = await runAgain(targetId);
		expect(t.state).toBe('published');
		expect(calls.filter((c) => c.url.includes('uploadType=resumable'))).toHaveLength(1);
	});

	it('Instagram: never creates a new container or publishes again, and refuses to guess between identical captions', async () => {
		let lookup: 'outage' | 'published' = 'outage';
		const calls = mockFetch([
			[/content_publishing_limit/, () => ok({ data: [] })],
			[/\/instagram-1\/media$/, () => ok({ id: 'c1' })],
			[/\/c1\?fields=status_code/, () => (calls.some((c) => c.url.includes('media_publish')) ? (lookup === 'outage' ? outage() : ok({ status_code: 'PUBLISHED' })) : ok({ status_code: 'FINISHED' }))],
			[/media_publish/, () => lost()],
			[/\/instagram-1\/media\?fields/, () => {
				const ts = new Date(Date.now() + 1000).toISOString();
				return ok({ data: [{ id: 'a', caption: 'same caption', timestamp: ts, permalink: 'https://instagram.com/reel/a' }, { id: 'b', caption: 'same caption', timestamp: ts, permalink: 'https://instagram.com/reel/b' }] });
			}],
		]);
		const { targetId } = newTarget('instagram', { shareToFeed: true });
		await runTarget(claimNext('w')!, 'w', instantSleep);
		let t = getTarget(targetId)!;
		expect(t.state).toBe('queued');
		expect(t.uncertain).toBe(1);
		expect(ref(targetId).containerId).toBe('c1');

		t = await runAgain(targetId); // status lookup fails
		expect(t.state).toBe('queued');
		expect(t.uncertain).toBe(1);

		lookup = 'published';
		t = await runAgain(targetId); // two identical captions
		expect(t.state).toBe('needs_attention');
		expect(t.error).toContain('same caption');
		expect(t.permalink).toBeNull();

		expect(calls.filter((c) => /\/instagram-1\/media$/.test(c.url))).toHaveLength(1);
		expect(calls.filter((c) => c.url.includes('media_publish'))).toHaveLength(1);
	});

	it('TikTok: keeps the publish ID through failed checks and never starts a new upload', async () => {
		let lookup: 'outage' | 'uploading' | 'inbox' = 'outage';
		const calls = mockFetch([
			[/inbox\/video\/init/, () => ok({ data: { publish_id: 'p1', upload_url: 'https://upload.tiktok.example/u' }, error: { code: 'ok' } })],
			[/upload\.tiktok\.example/, () => lost()],
			[/status\/fetch/, () => (lookup === 'outage' ? outage() : ok({ data: { status: lookup === 'uploading' ? 'PROCESSING_UPLOAD' : 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } }))],
		]);
		const { targetId } = newTarget('tiktok', { mode: 'inbox' });
		await runTarget(claimNext('w')!, 'w', instantSleep);
		expect(getTarget(targetId)!.uncertain).toBe(1);
		expect(ref(targetId)).toMatchObject({ publishId: 'p1', finalSent: true });

		let t = await runAgain(targetId);
		expect(t.state).toBe('queued');
		lookup = 'uploading'; // TikTok hasn't caught up yet: wait, don't re-upload
		t = await runAgain(targetId);
		expect(t.state).toBe('queued');
		expect(t.uncertain).toBe(1);
		lookup = 'inbox';
		t = await runAgain(targetId);
		expect(t.state).toBe('needs_attention');
		expect(t.error).toContain('TikTok inbox');

		expect(calls.filter((c) => c.url.includes('init'))).toHaveLength(1);
		expect(calls.filter((c) => c.url.includes('upload.tiktok.example'))).toHaveLength(1);
	});

	it('stops checking after the attempt limit and asks the owner instead of reporting a failure', async () => {
		mockFetch([[/status\/fetch/, () => outage()]]);
		const { targetId } = newTarget('tiktok', { mode: 'inbox' });
		getDb().prepare("UPDATE targets SET provider_ref = ?, uncertain = 1, attempts = ? WHERE id = ?").run(JSON.stringify({ publishId: 'p9', uploaded: true }), MAX_ATTEMPTS - 1, targetId);
		const t = await runAgain(targetId);
		expect(t.state).toBe('needs_attention');
		expect(t.error).toContain('could not confirm');
		expect(t.uncertain).toBe(1);
		expect(ref(targetId).publishId).toBe('p9');
	});
});
