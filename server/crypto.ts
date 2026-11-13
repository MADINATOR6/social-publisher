import crypto from 'node:crypto';
import { config } from './config.js';

// Tokens are encrypted at rest with AES-256-GCM. The key never leaves the server.
const key = () => Buffer.from(config.tokenKey, 'base64');

export function seal(plain: string | null | undefined): string | null {
	if (plain == null || plain === '') return null;
	const iv = crypto.randomBytes(12);
	const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
	const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function open(sealed: string | null | undefined): string | null {
	if (!sealed) return null;
	const [v, iv, tag, data] = sealed.split('.');
	if (v !== 'v1') throw new Error('Unknown token format');
	const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
	d.setAuthTag(Buffer.from(tag, 'base64'));
	return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const sign = (value: string) => crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');

export function signedToken(payload: object, ttlSeconds: number) {
	const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
	return `${body}.${sign(body)}`;
}

export function readSignedToken<T>(token: string | undefined): T | null {
	if (!token) return null;
	const [body, sig] = token.split('.');
	if (!body || !sig) return null;
	const expected = sign(body);
	if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
	const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
	return data as T;
}

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function pkcePair() {
	const verifier = randomId(48);
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

/** Removes anything that looks like a credential before a message is stored or logged. */
export function redact(text: string): string {
	return String(text)
		.replace(/(access_token|refresh_token|client_secret|code|token)=([^&\s"]+)/gi, '$1=[redacted]')
		.replace(/(Bearer|OAuth)\s+[A-Za-z0-9._\-]+/g, '$1 [redacted]')
		.replace(/"(access_token|refresh_token|id_token)"\s*:\s*"[^"]+"/g, '"$1":"[redacted]"')
		.slice(0, 1200);
}
