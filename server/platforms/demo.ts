// Demo mode: simulated publishing for UI work. Never touches a real platform and never
// produces a link. Posts made here are stored with is_demo = 1 and shown as "Simulated".
import type { Adapter, Outcome } from './types.js';
import { PermanentError, TransientError } from './types.js';
import { tiktok } from './tiktok.js';
import { instagram } from './instagram.js';
import { youtube } from './youtube.js';
import type { Platform } from '../db.js';

const real = { tiktok, instagram, youtube };

export function demoAdapter(platform: Platform): Adapter {
	const base = real[platform];
	return {
		...base,
		availability: () => ({ available: true, mode: 'demo', note: 'Demo account. Publishing is simulated and nothing is posted.' }),
		async reconcile() {
			return 'resume';
		},
		async run(ctx): Promise<Outcome> {
			// Add "#fail" or "#flaky" to a caption to try the failure and retry paths.
			const fail = /#fail\b/i.test(ctx.caption);
			const flaky = /#flaky\b/i.test(ctx.caption) && ctx.target.attempts < 2;
			ctx.save({ state: 'uploading', phase: 'upload' });
			for (let p = ctx.target.progress; p < 1; p += 0.1) {
				ctx.save({ progress: Math.min(1, p + 0.1) });
				await ctx.sleep(250);
			}
			if (flaky) throw new TransientError('Simulated network hiccup', 1500);
			ctx.save({ state: 'processing', phase: 'processing' });
			await ctx.sleep(1200);
			if (fail && platform !== 'youtube') throw new PermanentError('Simulated failure (caption contains #fail)');
			if (platform === 'tiktok') return { state: 'needs_attention', message: 'Simulated: would be sent to your TikTok inbox to finish in the app.' };
			return { state: 'published', permalink: null, message: 'Simulated. Nothing was posted.' };
		},
	};
}
