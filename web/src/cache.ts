/**
 * Tiny TTL cache persisted to a single JSON file.
 * - key = sha256 of a normalized cache key string (includes query/mode/freshness)
 * - TTL buckets chosen by caller
 * - LRU eviction with a hard cap; atomic writes (tmp + rename)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_CAP = 400;

interface Entry {
	exp: number; // epoch ms
	value: unknown;
}

interface Store {
	entries: Record<string, Entry>;
	order: string[]; // most-recently-used last
}

export class TtlCache {
	private store: Store = { entries: {}, order: [] };
	private dirty = false;
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
				const now = Date.now();
				this.store.order = this.store.order.filter((k) => (this.store.entries[k]?.exp ?? 0) > now);
			}
		} catch {
			this.store = { entries: {}, order: [] };
		}
	}
	private persist() {
		if (!this.dirty) return;
		this.dirty = false;
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
		if (!e) return undefined;
		if (e.exp < Date.now()) {
			delete this.store.entries[key];
			this.store.order = this.store.order.filter((k) => k !== key);
			this.dirty = true;
			return undefined;
		}
		// touch (LRU: move to end)
		const i = this.store.order.indexOf(key);
		if (i >= 0) this.store.order.splice(i, 1);
		this.store.order.push(key);
		this.dirty = false; // ordering-only change: skip persist to avoid churn
		return e.value;
	}
	set(key: string, value: unknown, ttlMs: number) {
		this.store.entries[key] = { exp: Date.now() + ttlMs, value };
		const i = this.store.order.indexOf(key);
		if (i >= 0) this.store.order.splice(i, 1);
		this.store.order.push(key);
		// evict LRU (front) beyond cap
		while (this.store.order.length > this.cap) {
			const old = this.store.order.shift()!;
			delete this.store.entries[old];
		}
		this.dirty = true;
		this.persist();
	}
	stats() {
		const now = Date.now();
		const live = Object.values(this.store.entries).filter((e) => e.exp > now).length;
		return { entries: Object.keys(this.store.entries).length, live };
	}
}

export function cacheKey(parts: string[]): string {
	return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Cache TTL for everything that is cached: fetches (24h) and refine plans (24h).
 * Search results are NOT cached: exact-repeat reuse is rare, the agent's own
 * context already dedupes repeats, and staleness risk is not worth it. */
export const CACHE_TTL_HOURS = 24;

export function defaultCacheDir(): string {
	return join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.pi', 'agent', 'wsearch');
}

export function openCache(file?: string): TtlCache {
	return new TtlCache(file ?? join(defaultCacheDir(), 'cache.json'));
}
