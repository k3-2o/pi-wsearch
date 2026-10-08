import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_CAP = 400;

interface Entry {
	exp: number;
	value: unknown;
}

interface Store {
	entries: Record<string, Entry>;
	order: string[];
}

export class TtlCache {
	private store: Store = { entries: {}, order: [] };
	constructor(
		private file: string,
		private cap = DEFAULT_CAP,
	) {
		this.load();
	}
	private load() {
		try {
			if (!existsSync(this.file)) return;
			const raw = JSON.parse(readFileSync(this.file, 'utf8'));
			if (raw && typeof raw === 'object' && typeof raw.entries === 'object') {
				this.store = raw;
				this.store.order = this.store.order.filter((k) => this.store.entries[k] !== undefined);
			}
		} catch {
			this.store = { entries: {}, order: [] };
		}
	}
	private persist() {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = this.file + '.tmp';
			writeFileSync(tmp, JSON.stringify(this.store), 'utf8');
			renameSync(tmp, this.file);
		} catch {
			/* cache writes are best-effort */
		}
	}
	get(key: string): unknown | undefined {
		const e = this.store.entries[key];
		if (!e || e.exp < Date.now()) return undefined;
		const i = this.store.order.indexOf(key);
		if (i >= 0) this.store.order.splice(i, 1);
		this.store.order.push(key);
		return e.value;
	}

	/** Expired copy WITHOUT deleting it (stale-if-error reserve). */
	peekStale(key: string): { value: unknown; ageHours: number } | undefined {
		const e = this.store.entries[key];
		if (!e) return undefined;
		const ageHours = (Date.now() - e.exp) / 3600_000;
		if (ageHours <= 0) return undefined;
		return { value: e.value, ageHours };
	}
	set(key: string, value: unknown, ttlMs: number) {
		this.store.entries[key] = { exp: Date.now() + ttlMs, value };
		const i = this.store.order.indexOf(key);
		if (i >= 0) this.store.order.splice(i, 1);
		this.store.order.push(key);
		while (this.store.order.length > this.cap) {
			const old = this.store.order.shift()!;
			delete this.store.entries[old];
		}
		this.persist();
	}
}

export function cacheKey(parts: string[]): string {
	return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Search results are NOT cached: exact-repeat reuse is rare; staleness risk is not worth it. */
export const CACHE_TTL_HOURS = 24;

function defaultCacheDir(): string {
	return join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.pi', 'agent', 'wsearch');
}

export function openCache(file?: string): TtlCache {
	return new TtlCache(file ?? join(defaultCacheDir(), 'cache.json'));
}
