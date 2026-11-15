// Quality checks for the chosen video. Publisher never re-encodes: the exact file goes to each
// platform. These checks only warn when the file itself is likely to look soft after the
// platform's own compression, and give each platform's best-practice tip.
import type { Media, Platform } from './api.js';

export type QualityNote = { kind: 'ok' | 'warn' | 'info'; text: string };

/** Average bitrate in Mbps, from file size and duration (audio included). */
export const mbps = (m: Pick<Media, 'size' | 'duration'>) => (m.duration && m.duration > 0 ? (m.size * 8) / m.duration / 1e6 : null);

export function qualityNotes(m: Media, platform: Platform): QualityNote[] {
	const out: QualityNote[] = [];
	const w = m.width ?? 0;
	const h = m.height ?? 0;
	const short = Math.min(w, h);
	const rate = mbps(m);
	const res = w && h ? `${w}×${h}` : 'unknown size';
	const fps = m.fps ? `, ${Math.round(m.fps)} fps` : '';
	const kbps = rate != null ? `, ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} Mbps` : '';

	if (!w || !h) return [{ kind: 'info', text: 'Sent as the original file, untouched' }];
	if (short < 720) out.push({ kind: 'warn', text: `Low resolution (${res}). It will look blurry; export at 1080×1920 or higher` });
	else if (short < 1080) out.push({ kind: 'warn', text: `Below 1080p (${res}). Export at 1080×1920 or higher for a sharp result` });
	if (rate != null && short >= 720) {
		const floor = short >= 2160 ? 20 : short >= 1440 ? 12 : 6;
		if (rate < floor) out.push({ kind: 'warn', text: `Low bitrate (${rate.toFixed(1)} Mbps). Export at ${floor * 2}+ Mbps so the platform's compression keeps detail` });
	}
	if (m.fps && m.fps < 23.5) out.push({ kind: 'warn', text: `Low frame rate (${Math.round(m.fps)} fps). Export at 24, 30 or 60 fps` });
	if (!out.length) out.push({ kind: 'ok', text: `Original quality, sent untouched (${res}${fps}${kbps})` });

	if (platform === 'youtube' && short >= 1080 && short < 1440) out.push({ kind: 'info', text: 'Tip: export at 1440p or 4K; YouTube then uses its sharper encoding, even for 1080p viewers' });
	if (platform === 'youtube' && short >= 1080) out.push({ kind: 'info', text: 'HD and 4K versions appear a few minutes after upload, while YouTube processes them' });
	if (platform === 'instagram' && short > 1080) out.push({ kind: 'info', text: 'Instagram shows Reels at up to 1080×1920 and scales larger videos down' });
	if (platform === 'tiktok') out.push({ kind: 'info', text: 'When you finish the draft in TikTok, make sure its high-quality (HD) upload setting is on' });
	return out;
}
