// Compiles the Electron main process, preload and the two services for the packaged app.
import { build } from 'esbuild';
import fs from 'node:fs';

const out = 'dist-desktop';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: false, logLevel: 'warning', legalComments: 'none' };

await build({ ...common, entryPoints: ['desktop/main.ts'], outfile: `${out}/main.cjs`, format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['desktop/preload.ts'], outfile: `${out}/preload.cjs`, format: 'cjs', external: ['electron'] });
// Services are ESM (they use top-level await). CommonJS dependencies need require/__dirname shims.
const banner = { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" };
await build({ ...common, entryPoints: { api: 'server/index.ts', worker: 'server/worker.ts' }, outdir: out, outExtension: { '.js': '.mjs' }, format: 'esm', banner });
for (const n of ['api', 'worker']) fs.copyFileSync(`desktop/${n}-entry.mjs`, `${out}/${n}-entry.mjs`);
console.log('desktop build ready:', fs.readdirSync(out).join(', '));
