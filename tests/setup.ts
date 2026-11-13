import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
Object.assign(process.env, {
	APP_PASSWORD: 'test-password-123',
	SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
	TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
	DATA_DIR: dir,
	APP_URL: 'http://localhost:5173',
	PUBLIC_BASE_URL: 'https://public.example.test',
	TIKTOK_CLIENT_KEY: 'tk',
	TIKTOK_CLIENT_SECRET: 'ts',
	INSTAGRAM_APP_ID: 'ia',
	INSTAGRAM_APP_SECRET: 'is',
	GOOGLE_CLIENT_ID: 'gid',
	GOOGLE_CLIENT_SECRET: 'gs',
	DEMO_MODE: 'true',
	NO_SIGN_IN: 'false',
});
