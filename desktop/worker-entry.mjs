// Utility-process entry for the worker. Waits for its settings over the private message port from the
// main process (so secrets never appear in argv or the inherited environment), then loads the service.
process.parentPort.once('message', async (e) => {
	if (e.data?.type !== 'start') return;
	Object.assign(process.env, e.data.env);
	try {
		await import('./worker.mjs');
	} catch (err) {
		console.error('[worker] failed to start:', err?.stack ?? err);
		process.parentPort.postMessage({ type: 'fatal', message: String(err?.message ?? err) });
		setTimeout(() => process.exit(1), 100);
	}
});
