// Renders the app icon with Electron (no image tools needed), then makes an .icns with iconutil.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const out = path.resolve(__dirname, '..', 'build');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
 <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a2d"/><stop offset="1" stop-color="#0f0f10"/></linearGradient>
 <linearGradient id="em" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a5c"/><stop offset="1" stop-color="#f2542a"/></linearGradient>
 <radialGradient id="glow" cx="0.5" cy="0.55" r="0.5"><stop offset="0" stop-color="#ff6b3d" stop-opacity="0.35"/><stop offset="1" stop-color="#ff6b3d" stop-opacity="0"/></radialGradient>
 <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.45"/></filter>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#sh)"/>
<rect x="101.5" y="101.5" width="821" height="821" rx="184" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>
<circle cx="470" cy="520" r="330" fill="url(#glow)"/>
<path d="M330 360 Q330 318 368 338 L590 470 Q628 494 590 518 L368 650 Q330 670 330 628 Z" fill="url(#em)"/>
<path d="M650 382 A190 190 0 0 1 650 642" fill="none" stroke="#ff7a4d" stroke-opacity="0.85" stroke-width="34" stroke-linecap="round"/>
<path d="M722 316 A280 280 0 0 1 722 708" fill="none" stroke="#ff7a4d" stroke-opacity="0.45" stroke-width="34" stroke-linecap="round"/>
</svg>`;
app.whenReady().then(async () => {
	const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
	await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
	await new Promise((r) => setTimeout(r, 400));
	const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
	const png = path.join(out, 'icon-1024.png');
	fs.writeFileSync(png, img.resize({ width: 1024, height: 1024 }).toPNG());
	const set = path.join(out, 'icon.iconset');
	fs.rmSync(set, { recursive: true, force: true });
	fs.mkdirSync(set);
	for (const s of [16, 32, 128, 256, 512]) {
		fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), img.resize({ width: s, height: s, quality: 'best' }).toPNG());
		fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), img.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
	}
	execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]);
	fs.rmSync(set, { recursive: true, force: true });
	console.log('icon written');
	app.quit();
});
