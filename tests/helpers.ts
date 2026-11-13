import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { getDb, now, resetDbForTests, type Platform } from '../server/db.js';
import { upsertAccount } from '../server/accounts.js';
import { ADAPTERS } from '../server/platforms/index.js';
import { resetSettingsCache } from '../server/settings.js';
import type { Adapter } from '../server/platforms/types.js';

const originals = { ...ADAPTERS };

export function freshDb() {
	for (const k of Object.keys(originals) as Platform[]) ADAPTERS[k] = originals[k];
	resetSettingsCache();
	return resetDbForTests();
}

export function seedMedia(bytes = 3 * 1024 * 1024, info: Partial<{ duration: number; width: number; height: number; codec: string }> = {}) {
	const dir = path.join(config.dataDir, 'media');
	fs.mkdirSync(dir, { recursive: true });
	// Same length as real media IDs, so signed-link length limits are exercised.
	const id = `m${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 9)}`.padEnd(16, 'x');
	const file = path.join(dir, `${id}.mp4`);
	fs.writeFileSync(file, Buffer.alloc(bytes, 7));
	getDb()
		.prepare('INSERT INTO media (id, path, filename, mime, size, duration, width, height, video_codec, audio_codec, fps, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
		.run(id, file, 'clip.mp4', 'video/mp4', bytes, info.duration ?? 20, info.width ?? 1080, info.height ?? 1920, info.codec ?? 'h264', 'aac', 30, now());
	return id;
}

export function seedAccount(platform: Platform, opts: { demo?: boolean; externalId?: string; expiresIn?: number } = {}) {
	return upsertAccount(
		platform,
		{ externalId: opts.externalId ?? `${platform}-1`, displayName: `${platform} acct`, handle: `@${platform}acct` },
		{ accessToken: `secret-access-${platform}`, refreshToken: `secret-refresh-${platform}`, accessExpiresAt: Date.now() + (opts.expiresIn ?? 30 * 86_400_000) },
		Boolean(opts.demo),
	);
}

export function fakeAdapter(platform: Platform, run: Adapter['run'], reconcile?: Adapter['reconcile']): Adapter {
	const a: Adapter = { ...originals[platform], run, reconcile: reconcile ?? (async () => 'resume') };
	ADAPTERS[platform] = a;
	return a;
}

export const instantSleep = { sleep: async () => {} };
