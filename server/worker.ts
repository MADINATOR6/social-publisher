// Background publisher. Runs separately from the web server, so uploads continue after the page closes.
import os from 'node:os';
import { assertSecrets } from './config.js';
import { getDb, workerBeat } from './db.js';
import './settings.js';
import { randomId } from './crypto.js';
import { cleanupMedia, tick } from './runner.js';

assertSecrets();
getDb();
const owner = `${os.hostname()}:${process.pid}:${randomId(4)}`;
let stopping = false;
let lastCleanup = 0;

console.log(`[worker] started as ${owner}`);
// Heartbeat on its own timer so a long upload does not make the worker look stopped.
const startedAt = Date.now();
const beat = () => {
	try {
		workerBeat(owner, startedAt);
	} catch {}
};
beat();
const beatTimer = setInterval(beat, 10_000);
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

while (!stopping) {
	try {
		const n = await tick(owner);
		if (Date.now() - lastCleanup > 10 * 60_000) {
			const removed = cleanupMedia();
			if (removed) console.log(`[worker] removed ${removed} old video file(s)`);
			lastCleanup = Date.now();
		}
		if (n === 0) await new Promise((r) => setTimeout(r, 1500));
	} catch (e: any) {
		console.error('[worker] loop error:', e?.message ?? e);
		await new Promise((r) => setTimeout(r, 3000));
	}
}
clearInterval(beatTimer);
console.log('[worker] stopped; unfinished uploads resume on next start');
process.exit(0);
