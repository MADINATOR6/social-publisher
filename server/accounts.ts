import { getDb, now, type Platform } from './db.js';
import { open, randomId, redact, seal } from './crypto.js';
import { adapterFor } from './platforms/index.js';
import type { AccountRow, Identity, TokenSet } from './platforms/types.js';
import { AuthError } from './platforms/types.js';

export function upsertAccount(platform: Platform, id: Identity, t: TokenSet, isDemo = false): AccountRow {
	const db = getDb();
	const existing = db.prepare('SELECT id FROM accounts WHERE platform = ? AND external_id = ? AND is_demo = ?').get(platform, id.externalId, isDemo ? 1 : 0) as { id: string } | undefined;
	const row = {
		id: existing?.id ?? randomId(10),
		platform,
		external_id: id.externalId,
		display_name: id.displayName,
		handle: id.handle ?? null,
		avatar_url: id.avatarUrl ?? null,
		is_demo: isDemo ? 1 : 0,
		status: 'connected',
		access_token: seal(t.accessToken),
		refresh_token: seal(t.refreshToken ?? null),
		access_expires_at: t.accessExpiresAt ?? null,
		refresh_expires_at: t.refreshExpiresAt ?? null,
		scopes: t.scopes ?? null,
		meta: id.meta ? JSON.stringify(id.meta) : null,
		t: now(),
	};
	db.prepare(`INSERT INTO accounts (id, platform, external_id, display_name, handle, avatar_url, is_demo, status, status_detail, access_token, refresh_token, access_expires_at, refresh_expires_at, scopes, meta, created_at, updated_at)
		VALUES (:id, :platform, :external_id, :display_name, :handle, :avatar_url, :is_demo, :status, NULL, :access_token, :refresh_token, :access_expires_at, :refresh_expires_at, :scopes, :meta, :t, :t)
		ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, handle = excluded.handle, avatar_url = excluded.avatar_url, status = 'connected', status_detail = NULL,
		access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token), access_expires_at = excluded.access_expires_at,
		refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes, meta = excluded.meta, updated_at = excluded.updated_at`).run(row);
	return getAccount(row.id)!;
}

export const getAccount = (id: string) => getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;

export function markAccount(id: string, status: 'connected' | 'reconnect_required' | 'error', detail: string | null) {
	getDb().prepare('UPDATE accounts SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(status, detail ? redact(detail) : null, now(), id);
}

/** Safe view for the browser: never includes tokens. */
export function publicAccount(a: AccountRow) {
	return {
		id: a.id,
		platform: a.platform,
		displayName: a.display_name,
		handle: a.handle,
		avatarUrl: a.avatar_url,
		isDemo: Boolean(a.is_demo),
		status: a.status,
		statusDetail: a.status_detail,
		accessExpiresAt: a.access_expires_at,
		connectedAt: a.created_at,
	};
}

export function listAccounts() {
	return (getDb().prepare('SELECT * FROM accounts ORDER BY platform, created_at').all() as AccountRow[]).map(publicAccount);
}

const inflight = new Map<string, Promise<string>>();

/** Returns a working access token, refreshing it shortly before it expires. */
export async function accessToken(accountId: string): Promise<string> {
	const running = inflight.get(accountId);
	if (running) return running;
	const p = (async () => {
		const a = getAccount(accountId);
		if (!a) throw new AuthError('Account was disconnected');
		if (a.is_demo) return 'demo';
		if (a.status === 'reconnect_required') throw new AuthError('Reconnect this account');
		const token = open(a.access_token);
		const expiring = a.access_expires_at != null && a.access_expires_at - now() < 5 * 60_000;
		const igRefreshDue = a.platform === 'instagram' && a.access_expires_at != null && a.access_expires_at - now() < 10 * 86_400_000;
		if (token && !expiring && !igRefreshDue) return token;
		try {
			const t = await adapterFor(a.platform, false).refresh(a, open(a.refresh_token), token);
			getDb()
				.prepare('UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), access_expires_at = ?, refresh_expires_at = COALESCE(?, refresh_expires_at), status = \'connected\', status_detail = NULL, updated_at = ? WHERE id = ?')
				.run(seal(t.accessToken), seal(t.refreshToken ?? null), t.accessExpiresAt ?? null, t.refreshExpiresAt ?? null, now(), a.id);
			return t.accessToken;
		} catch (e: any) {
			if (token && !expiring) return token; // Early Instagram refresh failed but the token still works.
			markAccount(a.id, 'reconnect_required', `Sign-in expired: ${e?.message ?? e}`);
			throw new AuthError('Sign-in expired. Reconnect this account.');
		}
	})();
	inflight.set(accountId, p);
	try {
		return await p;
	} finally {
		inflight.delete(accountId);
	}
}

export async function disconnect(id: string) {
	const a = getAccount(id);
	if (!a) return;
	if (!a.is_demo) await adapterFor(a.platform, false).revoke?.(open(a.access_token), open(a.refresh_token)).catch(() => undefined);
	const db = getDb();
	const busy = db.prepare("SELECT COUNT(*) n FROM targets WHERE account_id = ? AND state IN ('queued','uploading','processing')").get(id) as { n: number };
	if (busy.n > 0) throw new Error('This account has posts in progress. Wait for them to finish first.');
	// Keep the row so post history still shows the account name; wipe the credentials.
	db.prepare("UPDATE accounts SET status = 'disconnected', access_token = NULL, refresh_token = NULL, access_expires_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
}
