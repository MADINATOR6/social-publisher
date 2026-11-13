import { AuthError, PermanentError, TransientError } from './types.js';

export type HttpOptions = RequestInit & { timeoutMs?: number; authHint?: string };

/** fetch with a timeout and error classification. Messages never include tokens. */
export async function http(url: string, opts: HttpOptions = {}): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal });
	} catch (e: any) {
		throw new TransientError(`Network error contacting ${new URL(url).host}: ${e?.name === 'AbortError' ? 'timed out' : e?.message ?? e}`);
	} finally {
		clearTimeout(timer);
	}
}

export async function json<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
	const res = await http(url, opts);
	const text = await res.text();
	let body: any = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = { raw: text.slice(0, 300) };
	}
	if (!res.ok || body?.error?.code && body.error.code !== 'ok') throw classify(res.status, body, new URL(url).host, res.headers.get('retry-after'));
	return body as T;
}

export function classify(status: number, body: any, host: string, retryAfter?: string | null) {
	const msg = describe(body) || `HTTP ${status}`;
	const where = `${host}: ${msg}`;
	if (status === 401 || /invalid_grant|access_token_invalid|token.*expired|OAuthException.*(190|463)|scope_not_authorized|access_token_expired/i.test(JSON.stringify(body ?? ''))) {
		return new AuthError(where);
	}
	if (status === 429 || status >= 500 || /rate_limit|rate limit|spam_risk_too_many|quotaExceeded|backendError|temporarily/i.test(msg)) {
		const after = retryAfter ? Number(retryAfter) * 1000 : undefined;
		return new TransientError(where, Number.isFinite(after) ? after : undefined);
	}
	return new PermanentError(where);
}

function describe(body: any): string {
	if (!body) return '';
	const e = body.error;
	if (typeof e === 'string') return [e, body.error_description].filter(Boolean).join(': ');
	if (e) return [e.code, e.message, e.error_user_msg, e.errors?.[0]?.reason].filter((x: any) => x && x !== 'ok').join(' · ');
	return body.message ?? body.raw ?? '';
}

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
