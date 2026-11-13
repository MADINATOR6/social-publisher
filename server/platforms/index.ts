import type { Platform } from '../db.js';
import type { Adapter } from './types.js';
import { tiktok } from './tiktok.js';
import { instagram } from './instagram.js';
import { youtube } from './youtube.js';
import { demoAdapter } from './demo.js';

export const ADAPTERS: Record<Platform, Adapter> = { tiktok, instagram, youtube };
export const PLATFORMS: Platform[] = ['tiktok', 'instagram', 'youtube'];

export function adapterFor(platform: Platform, isDemo: boolean): Adapter {
	return isDemo ? demoAdapter(platform) : ADAPTERS[platform];
}
