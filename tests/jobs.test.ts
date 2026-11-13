import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, now } from '../server/db.js';
import { claimNext, createPost, getTarget, MAX_ATTEMPTS, postView, retryTargets } from '../server/jobs.js';
import { runTarget, tick, cleanupMedia } from '../server/runner.js';
import { AuthError, PermanentError, TransientError } from '../server/platforms/types.js';
import { getAccount } from '../server/accounts.js';
import { fakeAdapter, freshDb, instantSleep, seedAccount, seedMedia } from './helpers.js';

const post = (mediaId: string, accounts: { id: string; platform: string }[], key = `key-${Math.random()}`) =>
	createPost({ idempotencyKey: key, mediaId, caption: 'hello', isDemo: false, targets: accounts.map((a) => ({ accountId: a.id, platform: a.platform, settings: {} })) });

describe('jobs', () => {
	beforeEach(() => freshDb());

	it('creates a post once per idempotency key (no duplicates from repeated clicks)', () => {
		const m = seedMedia();
		const a = seedAccount('youtube');
		const one = post(m, [a], 'same-key-1234');
		const two = post(m, [a], 'same-key-1234');
		expect(two.id).toBe(one.id);
		expect(two.duplicate).toBe(true);
		expect((getDb().prepare('SELECT COUNT(*) n FROM targets').get() as any).n).toBe(1);
	});

	it('tracks each destination independently, so one failing does not affect the others', async () => {
		const m = seedMedia();
		const yt = seedAccount('youtube');
		const ig = seedAccount('instagram');
		fakeAdapter('youtube', async () => ({ state: 'published', permalink: 'https://youtu.be/abc' }));
		fakeAdapter('instagram', async () => {
			throw new PermanentError('Instagram could not process the video');
		});
		const p = post(m, [yt, ig]);
		await tick('w1', 3, instantSleep);
		const v = postView(p.id)!;
		const byP = Object.fromEntries(v.targets.map((t) => [t.platform, t]));
		expect(byP.youtube.state).toBe('published');
		expect(byP.youtube.permalink).toBe('https://youtu.be/abc');
		expect(byP.instagram.state).toBe('failed');
		expect(byP.instagram.error).toContain('could not process');
		expect(v.done).toBe(true);
	});

	it('retries transient failures with backoff and stops after the maximum attempts', async () => {
		const m = seedMedia();
		const a = seedAccount('youtube');
		let calls = 0;
		fakeAdapter('youtube', async () => {
			calls++;
			throw new TransientError('HTTP 503');
		});
		const p = post(m, [a]);
		const tid = postView(p.id)!.targets[0].id;
		for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
			getDb().prepare('UPDATE targets SET next_run_at = 0 WHERE id = ?').run(tid);
			await tick('w1', 1, instantSleep);
		}
		const t = getTarget(tid)!;
		expect(calls).toBe(MAX_ATTEMPTS);
		expect(t.state).toBe('failed');
		expect(t.error).toContain('gave up');
	});

	it('waits before retrying (bounded exponential backoff)', async () => {
		const m = seedMedia();
		const a = seedAccount('youtube');
		fakeAdapter('youtube', async () => {
			throw new TransientError('rate limited');
		});
		const p = post(m, [a]);
		await tick('w1', 1, instantSleep);
		const t = getTarget(postView(p.id)!.targets[0].id)!;
		expect(t.state).toBe('queued');
		const wait = (getDb().prepare('SELECT next_run_at FROM targets WHERE id = ?').get(t.id) as any).next_run_at - now();
		expect(wait).toBeGreaterThan(5_000);
		expect(wait).toBeLessThan(20 * 60_000);
		expect(claimNext('w2')).toBeNull();
	});

	it('recovers a job after the worker dies, and reconciles before retrying so nothing is posted twice', async () => {
		const m = seedMedia();
		const a = seedAccount('instagram');
		let published = 0;
		let reconciled = 0;
		fakeAdapter(
			'instagram',
			async (ctx) => {
				ctx.save({ state: 'processing', phase: 'publishing', providerRef: { containerId: 'c1' } });
				published++;
				return { state: 'published', permalink: 'https://instagram.com/p/x' };
			},
			async () => {
				reconciled++;
				// The platform says it is already published: return that instead of posting again.
				return { state: 'published', permalink: 'https://instagram.com/p/x' };
			},
		);
		const p = post(m, [a]);
		// Simulate a crash: the target was claimed and mid-publish when the worker vanished.
		const t = claimNext('dead-worker')!;
		getDb().prepare("UPDATE targets SET state = 'processing', phase = 'publishing', provider_ref = '{\"containerId\":\"c1\"}', lease_until = ? WHERE id = ?").run(now() - 1000, t.id);
		const again = claimNext('new-worker')!;
		expect(again.id).toBe(t.id);
		expect(again.uncertain).toBe(1);
		await runTarget(again, 'new-worker', instantSleep);
		expect(reconciled).toBe(1);
		expect(published).toBe(0);
		expect(getTarget(t.id)!.state).toBe('published');
		expect(postView(p.id)!.targets[0].events.some((e) => e.message.includes('restarted'))).toBe(true);
	});

	it('does not hand a running job to a second worker while its lease is live', () => {
		const m = seedMedia();
		const a = seedAccount('youtube');
		post(m, [a]);
		const t = claimNext('w1')!;
		getDb().prepare("UPDATE targets SET state = 'uploading' WHERE id = ?").run(t.id);
		expect(claimNext('w2')).toBeNull();
	});

	it('retries only the failed destinations', async () => {
		const m = seedMedia();
		const yt = seedAccount('youtube');
		const ig = seedAccount('instagram');
		let ytRuns = 0;
		fakeAdapter('youtube', async () => (ytRuns++, { state: 'published', permalink: 'https://youtu.be/1' }));
		let igFail = true;
		fakeAdapter('instagram', async () => {
			if (igFail) throw new PermanentError('bad');
			return { state: 'published', permalink: 'https://instagram.com/p/1' };
		});
		const p = post(m, [yt, ig]);
		await tick('w', 3, instantSleep);
		igFail = false;
		const retried = retryTargets(p.id);
		expect(retried).toHaveLength(1);
		await tick('w', 3, instantSleep);
		expect(ytRuns).toBe(1);
		expect(postView(p.id)!.targets.every((t) => t.state === 'published')).toBe(true);
	});

	it('marks the account for reconnection when sign-in expires, without failing other accounts', async () => {
		const m = seedMedia();
		const yt = seedAccount('youtube');
		const tt = seedAccount('tiktok');
		fakeAdapter('youtube', async () => {
			throw new AuthError('invalid_grant');
		});
		fakeAdapter('tiktok', async () => ({ state: 'needs_attention', message: 'Sent to your TikTok inbox.' }));
		const p = post(m, [yt, tt]);
		await tick('w', 3, instantSleep);
		const v = postView(p.id)!;
		expect(v.targets.find((t) => t.platform === 'youtube')!.state).toBe('needs_attention');
		expect(v.targets.find((t) => t.platform === 'youtube')!.error).toContain('Reconnect');
		expect(getAccount(yt.id)!.status).toBe('reconnect_required');
		expect(v.targets.find((t) => t.platform === 'tiktok')!.state).toBe('needs_attention');
		expect(getAccount(tt.id)!.status).toBe('connected');
	});

	it('demo posts are simulated, separate and never get a link', async () => {
		const m = seedMedia();
		const a = seedAccount('instagram', { demo: true });
		const p = createPost({ idempotencyKey: 'demo-key-123', mediaId: m, caption: 'demo', isDemo: true, targets: [{ accountId: a.id, platform: 'instagram', settings: {} }] });
		await tick('w', 1, instantSleep);
		const v = postView(p.id)!;
		expect(v.isDemo).toBe(true);
		expect(v.targets[0].state).toBe('published');
		expect(v.targets[0].permalink).toBeNull();
		expect(v.targets[0].events[0].message).toMatch(/Simulated|Nothing was posted/);
	});

	it('refuses to run a demo account inside a real post', async () => {
		const m = seedMedia();
		const a = seedAccount('youtube', { demo: true });
		const p = post(m, [a]);
		await tick('w', 1, instantSleep);
		expect(postView(p.id)!.targets[0].state).toBe('failed');
	});

	it('removes old video files only after every destination has finished', async () => {
		const m = seedMedia();
		const a = seedAccount('youtube');
		post(m, [a]);
		getDb().prepare('UPDATE media SET created_at = 0').run();
		expect(cleanupMedia()).toBe(0);
		getDb().prepare("UPDATE targets SET state = 'published'").run();
		expect(cleanupMedia()).toBe(1);
	});
});
