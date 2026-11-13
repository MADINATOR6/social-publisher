import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Platform } from './db.js';

const run = promisify(execFile);

export type MediaInfo = {
	size: number;
	duration: number | null;
	width: number | null;
	height: number | null;
	videoCodec: string | null;
	audioCodec: string | null;
	fps: number | null;
	container: string | null;
};

/** Reads real stream facts with ffprobe. Returns nulls when ffprobe is missing. */
export async function probe(file: string, size: number): Promise<MediaInfo> {
	try {
		const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate', '-of', 'json', file]);
		const j = JSON.parse(stdout);
		const v = j.streams?.find((s: any) => s.codec_type === 'video');
		const a = j.streams?.find((s: any) => s.codec_type === 'audio');
		const [n, d] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
		return {
			size,
			duration: j.format?.duration ? Number(j.format.duration) : null,
			width: v?.width ?? null,
			height: v?.height ?? null,
			videoCodec: v?.codec_name ?? null,
			audioCodec: a?.codec_name ?? null,
			fps: d ? Math.round((n / d) * 100) / 100 : null,
			container: j.format?.format_name ?? null,
		};
	} catch {
		return { size, duration: null, width: null, height: null, videoCodec: null, audioCodec: null, fps: null, container: null };
	}
}

export const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];

/**
 * Upload requirements per platform, from each platform's documentation (checked Nov 2026).
 * They change; PROJECT.md lists the sources to re-check.
 */
export const LIMITS: Record<Platform, { formats: string[]; minSec: number; maxSec: number; maxBytes: number; codecs: string[]; note: string }> = {
	tiktok: { formats: ['mp4', 'mov', 'webm'], minSec: 3, maxSec: 600, maxBytes: 4 * 1024 ** 3, codecs: ['h264', 'hevc', 'vp8', 'vp9'], note: 'MP4/MOV/WebM, up to 10 minutes and 4 GB.' },
	instagram: { formats: ['mp4', 'mov'], minSec: 3, maxSec: 900, maxBytes: 300 * 1024 ** 2, codecs: ['h264', 'hevc'], note: 'Reels: MP4/MOV, H.264 or HEVC, 3 s to 15 min, up to 300 MB.' },
	youtube: { formats: ['mp4', 'mov', 'webm'], minSec: 1, maxSec: 12 * 3600, maxBytes: 256 * 1024 ** 3, codecs: ['h264', 'hevc', 'vp8', 'vp9', 'av1'], note: 'Most video formats; up to 12 hours.' },
};

export type Issue = { field: string; message: string };

export function validateMedia(platform: Platform, m: MediaInfo & { mime: string; filename: string }): Issue[] {
	const L = LIMITS[platform];
	const out: Issue[] = [];
	const ext = m.filename.split('.').pop()?.toLowerCase() ?? '';
	if (!VIDEO_MIME.includes(m.mime) && !L.formats.includes(ext)) out.push({ field: 'media', message: 'This file is not a supported video.' });
	else if (!L.formats.includes(ext === 'm4v' ? 'mp4' : ext)) out.push({ field: 'media', message: `${label(platform)} accepts ${L.formats.join(', ').toUpperCase()}.` });
	if (m.size > L.maxBytes) out.push({ field: 'media', message: `File is ${fmtBytes(m.size)}; ${label(platform)} allows up to ${fmtBytes(L.maxBytes)}.` });
	if (m.duration != null) {
		if (m.duration < L.minSec) out.push({ field: 'media', message: `Video is ${m.duration.toFixed(1)} s; ${label(platform)} needs at least ${L.minSec} s.` });
		if (m.duration > L.maxSec) out.push({ field: 'media', message: `Video is ${fmtDur(m.duration)}; ${label(platform)} allows up to ${fmtDur(L.maxSec)}.` });
	}
	if (m.videoCodec && !L.codecs.includes(m.videoCodec)) out.push({ field: 'media', message: `${label(platform)} does not accept ${m.videoCodec.toUpperCase()} video. Re-export as H.264.` });
	if (m.videoCodec == null && m.duration == null) out.push({ field: 'media', message: 'Could not read this video. Check that it plays and re-export it as MP4 (H.264).' });
	return out;
}

/** Shorts are vertical or square and up to 3 minutes. */
export const isShortsShape = (m: { width: number | null; height: number | null; duration: number | null }) =>
	m.width != null && m.height != null && m.height >= m.width && (m.duration ?? 0) <= 180;

export const label = (p: Platform) => ({ tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' })[p];
export const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
export const fmtDur = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
