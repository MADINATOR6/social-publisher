import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPost, getTarget, postView, claimNext } from '../server/jobs.js';
import { runTarget } from '../server/runner.js';
import { getDb } from '../server/db.js';
import { chunkPlan } from '../server/platforms/tiktok.js';
import { validateMedia } from '../server/media.js';
import { freshDb, instantSleep, seedAccount, seedMedia } from './helpers.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(routes: [RegExp, Handler][]) {
	const calls: { url: string; method: string }[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any = {}) => {
		const url = String(input);
		calls.push({ url, method: init.method ?? 'GET' });
		const r = routes.find(([re]) => re.test(url));
		if (!r) throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
		return r[1](url, init);
	});
	return calls;
}
const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

beforeEach(() => freshDb());
afterEach(() => vi.restoreAllMocks());

function newTarget(platform: 'youtube' | 'instagram' | 'tiktok', settings: object, bytes = 3 * 1024 * 1024) {
	const m = seedMedia(bytes);
	const a = seedAccount(platform);
	const p = createPost({ idempotencyKey: `k-${Math.random()}`, mediaId: m, caption: 'cap', isDemo: false, targets: [{ accountId: a.id, platform, settings: settings as any }] });
	return { postId: p.id, targetId: postView(p.id)!.targets[0].id };
}

describe('YouTube', () => {
	it('uploads with an explicit visibility, waits for confirmation and returns the Shorts link', async () => {
		let meta: any;
		const calls = mockFetch([
			[/upload\/youtube\/v3\/videos\?uploadType=resumable/, (_u, i) => ((meta = JSON.parse(String(i.body))), new Response('', { status: 200, headers: { location: 'https://upload.example/session1' } }))],
			[/upload\.example\/session1/, (_u, i) => (String((i.headers as any)['Content-Range']).startsWith('bytes */') ? new Response('', { status: 308 }) : ok({ id: 'vid123' }))],
			[/youtube\/v3\/videos\?part=status/, () => ok({ items: [{ status: { uploadStatus: 'processed' } }] })],
		]);
		const { targetId } = newTarget('youtube', { title: 'My video', description: 'd', privacy: 'unlisted', madeForKids: false });
		await runTarget(claimNext('w')!, 'w', instantSleep);
		const t = getTarget(targetId)!;
		expect(meta.status.privacyStatus).toBe('unlisted');
		expect(meta.status.selfDeclaredMadeForKids).toBe(false);
		expect(t.state).toBe('published');
		expect(t.permalink).toBe('https://www.youtube.com/shorts/vid123');
		expect(calls.filter((c) => c.url.includes('uploadType=resumable'))).toHaveLength(1);
	});

	it('resumes an interrupted upload from the server offset instead of starting a new video', async () => {
		const ranges: string[] = [];
		const calls = mockFetch([
			[/uploadType=resumable/, () => new Response('', { status: 200, headers: { location: 'https://upload.example/s2' } })],
			[/upload\.example\/s2/, (_u, i) => {
				const r = String((i.headers as any)['Content-Range']);
				ranges.push(r);
				return r.startsWith('bytes */') ? new Response('', { status: 308, headers: { range: 'bytes=0-1048575' } }) : ok({ id: 'vid9' });
			}],
			[/part=status/, () => ok({ items: [{ status: { uploadStatus: 'processed' } }] })],
		]);
		const { targetId } = newTarget('youtube', { title: 'T', privacy: 'private', madeForKids: false });
		// Pretend a previous worker created the session and uploaded the first MB, then died.
		getDb().prepare("UPDATE targets SET provider_ref = '{\"sessionUrl\":\"https://upload.example/s2\"}', phase = 'upload', state = 'uploading', uncertain = 1 WHERE id = ?").run(targetId);
		await runTarget(getTarget(targetId)!, 'w', instantSleep);
		expect(calls.filter((c) => c.url.includes('uploadType=resumable'))).toHaveLength(0);
		expect(ranges.find((r) => !r.startsWith('bytes */'))).toMatch(/^bytes 1048576-/);
		expect(getTarget(targetId)!.state).toBe('published');
	});
});

describe('Instagram', () => {
	it('creates a Reels container from the public URL, waits for FINISHED, then publishes once', async () => {
		let params: URLSearchParams | null = null;
		let polls = 0;
		const calls = mockFetch([
			[/content_publishing_limit/, () => ok({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] })],
			[/\/instagram-1\/media$/, (_u, i) => ((params = new URLSearchParams(String(i.body))), ok({ id: 'cont1' }))],
			[/\/cont1\?fields=status_code/, () => ok({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' })],
			[/media_publish/, () => ok({ id: 'media77' })],
			[/\/media77\?fields=permalink/, () => ok({ permalink: 'https://www.instagram.com/reel/abc/' })],
		]);
		const { targetId } = newTarget('instagram', { shareToFeed: true });
		await runTarget(claimNext('w')!, 'w', instantSleep);
		expect(params!.get('media_type')).toBe('REELS');
		expect(params!.get('video_url')).toMatch(/^https:\/\/public\.example\.test\/m\//);
		expect(calls.filter((c) => c.url.includes('media_publish'))).toHaveLength(1);
		expect(getTarget(targetId)!.permalink).toBe('https://www.instagram.com/reel/abc/');
	});

	it('after a lost publish response, finds the live Reel instead of publishing again', async () => {
		const calls = mockFetch([
			[/\/cont9\?fields=status_code/, () => ok({ status_code: 'PUBLISHED' })],
			[/\/media\?fields=id,permalink,timestamp,caption/, () => ok({ data: [{ id: 'm1', permalink: 'https://www.instagram.com/reel/live/', timestamp: new Date().toISOString(), caption: 'cap' }] })],
		]);
		const { targetId } = newTarget('instagram', {});
		getDb().prepare("UPDATE targets SET provider_ref = '{\"containerId\":\"cont9\"}', phase = 'publishing', state = 'processing', uncertain = 1 WHERE id = ?").run(targetId);
		await runTarget(getTarget(targetId)!, 'w', instantSleep);
		expect(calls.some((c) => c.url.includes('media_publish'))).toBe(false);
		expect(getTarget(targetId)!.permalink).toBe('https://www.instagram.com/reel/live/');
	});
});

describe('TikTok', () => {
	it('sends the video to the TikTok inbox and reports it as needing the user to finish in the app', async () => {
		let init: any;
		mockFetch([
			[/inbox\/video\/init/, (_u, i) => ((init = JSON.parse(String(i.body))), ok({ data: { publish_id: 'p1', upload_url: 'https://upload.tiktok.example/u' }, error: { code: 'ok' } }))],
			[/upload\.tiktok\.example/, () => new Response('', { status: 201 })],
			[/status\/fetch/, () => ok({ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } })],
		]);
		const { targetId } = newTarget('tiktok', { mode: 'inbox' });
		await runTarget(claimNext('w')!, 'w', instantSleep);
		const t = getTarget(targetId)!;
		expect(init.source_info.source).toBe('FILE_UPLOAD');
		expect(init.post_info).toBeUndefined();
		expect(t.state).toBe('needs_attention');
		expect(t.error).toContain('TikTok inbox');
		expect(t.permalink).toBeNull();
	});

	it('refuses Direct Post when it is not enabled', async () => {
		const { targetId } = newTarget('tiktok', { mode: 'direct', privacy: 'PUBLIC_TO_EVERYONE' });
		await runTarget(claimNext('w')!, 'w', instantSleep);
		expect(getTarget(targetId)!.state).toBe('failed');
	});

	it('plans chunks within TikTok limits', () => {
		expect(chunkPlan(3 * 1024 * 1024)).toEqual({ chunkSize: 3 * 1024 * 1024, count: 1 });
		const p = chunkPlan(95 * 1024 * 1024);
		expect(p.count).toBe(9);
		expect(95 * 1024 * 1024 - p.chunkSize * (p.count - 1)).toBeLessThanOrEqual(128 * 1024 * 1024);
	});
});

describe('media validation', () => {
	const base = { size: 10 * 1024 * 1024, duration: 30, width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', fps: 30, container: 'mov,mp4', mime: 'video/mp4', filename: 'a.mp4' };
	it('accepts a normal vertical MP4 everywhere', () => {
		for (const p of ['tiktok', 'instagram', 'youtube'] as const) expect(validateMedia(p, base)).toEqual([]);
	});
	it('flags platform-specific limits', () => {
		expect(validateMedia('instagram', { ...base, size: 400 * 1024 * 1024 })[0].message).toContain('300 MB');
		expect(validateMedia('tiktok', { ...base, duration: 1200 })[0].message).toContain('10 min');
		expect(validateMedia('instagram', { ...base, filename: 'a.webm', mime: 'video/webm' })[0].message).toContain('MP4, MOV');
	});
});
