import { assertSecrets, config } from './config.js';
import { getDb } from './db.js';
import './settings.js';
import { buildApp } from './app.js';

assertSecrets();
getDb();
const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`[api] listening on http://127.0.0.1:${config.port}${config.demoMode ? '  (DEMO MODE: publishing is simulated)' : ''}${config.noSignIn ? '  (sign-in turned off)' : ''}`);
