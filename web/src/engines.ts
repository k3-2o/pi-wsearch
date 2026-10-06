/**
 * Search engine registry: a provider pocket for every engine.
 *
 * Each engine declares HOW it is configured (key/endpoint presence) and HOW it
 * searches; runEngines runs every configured-and-wanted engine in parallel and
 * the caller fuses the outcomes (pure RRF: N engines or 1, the merge holds).
 *
 * Adding a provider = one entry in the registry plus its adapter. Engines are
 * gated by key presence, so 1, 2, 3 or 10 coexist depending on what keys are
 * set; WSEARCH_ENGINES pins/subset the set at runtime.
 * Keys are passed via headers/body and never surface in results/errors.
 *
 * Every pocket is keyed or self-hosted: there are no keyless engines. Measured
 * 2026-10: DDG's HTML endpoints bot-wall (HTTP 202, 3/5 sequential, 5/5 parallel),
 * Ecosia is Cloudflare-403, Mojeek/Yandex/Marginalia serve captchas or JS walls
 * (Marginalia's public key rate-limits), and Firecrawl keyless 403s flagged IP
 * ranges (mobile-carrier NAT). Keyless web search is not real without a browser
 * kernel, which we do not ship.
 */
import { getConfig, sanitizeError, type WebConfig } from './config';

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
	engine: string;
	date?: string;
}

export interface EngineOutcome {
	engine: string;
	hits: SearchHit[];
	error?: string;
	latencyMs: number;
}

export type EngineName = 'serper' | 'tavily' | 'exa' | 'brave' | 'jina' | 'kagi' | 'you' | 'firecrawl' | 'tinyfish';
export type Freshness = 'none' | 'day' | 'week' | 'month' | 'year';

export interface SearchOptions {
	query: string;
	maxResults?: number;
	freshness?: Freshness;
	region?: string;
	/** subset/pin of engines to run (default: all configured, or WSEARCH_ENGINES) */
	engines?: EngineName[];
	signal?: AbortSignal;
}

/** Adapter shape every engine implements (one clear job per engine). */
export interface EngineDef {
	id: EngineName;
	/** credentials/endpoint configured right now */
	available(cfg: WebConfig): boolean;
	search(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome>;
}

const jsonHeaders = (extra: Record<string, string> = {}) => ({
	'Content-Type': 'application/json',
	...extra,
});

/** Test seam: single engine POST with abort plumbing (see pre-abort guard). */
export async function postJson<T>(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<T> {
	return request<T>(url, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
}

/** GET with the same timeout + pre-abort plumbing as postJson. */
async function getJson<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
	return request<T>(url, { method: 'GET', headers }, signal);
}

async function request<T>(
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string },
	signal?: AbortSignal,
): Promise<T> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(new Error('engine timeout')), 12_000);
	const onAbort = () => ctrl.abort(signal?.reason ?? new Error('aborted'));
	// An already-aborted signal never fires "abort" listeners. Pre-abort the
	// request controller now so the fetch rejects immediately instead of running
	// its full timeout (pi aborts the run signal once; every call started after
	// that moment sees an already-aborted signal).
	if (signal?.aborted) ctrl.abort(signal?.reason ?? new Error('aborted'));
	else signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: ctrl.signal });
		if (!res.ok) {
			const txt = await res.text().catch(() => '');
			throw new Error(`HTTP ${res.status}: ${txt.slice(0, 160)}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(t);
		signal?.removeEventListener('abort', onAbort);
	}
}

const TBS: Record<Freshness, string> = {
	none: '',
	day: 'qdr:d',
	week: 'qdr:w',
	month: 'qdr:m',
	year: 'qdr:y',
};
/** Relative window size per freshness tier (for engines with absolute-date filters). */
const FRESHNESS_DAYS: Record<Exclude<Freshness, 'none'>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};
/** Brave freshness period codes. */
const BRAVE_FRESHNESS: Record<Exclude<Freshness, 'none'>, string> = {
	day: 'pd',
	week: 'pw',
	month: 'pm',
	year: 'py',
};

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

async function serper(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().serperKey!;
	try {
		const body: Record<string, unknown> = {
			q: opts.query,
			num: opts.maxResults ?? 8,
			gl: opts.region ?? 'us',
		};
		const tbs = TBS[opts.freshness ?? 'none'];
		if (tbs) body.tbs = tbs;
		const d = await postJson<{
			organic?: { title?: string; link?: string; snippet?: string; date?: string }[];
		}>('https://google.serper.dev/search', body, jsonHeaders({ 'X-API-KEY': key }), signal);
		const hits: SearchHit[] = (d.organic ?? [])
			.filter((r) => r?.link)
			.map((r) => ({
				title: r.title ?? r.link!,
				url: r.link!,
				snippet: r.snippet ?? '',
				engine: 'serper',
				date: r.date,
			}));
		return { engine: 'serper', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'serper', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function tavily(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().tavilyKey!;
	try {
		const body: Record<string, unknown> = {
			query: opts.query,
			max_results: opts.maxResults ?? 8,
			// 'basic' = 1 API credit ('advanced' = 2). Docs: basic is the balanced
			// general-purpose default; advanced buys multi-chunk snippets we don't use.
			search_depth: 'basic',
			topic: 'general',
		};
		// Documented auth is the Authorization: Bearer header (body api_key is not
		// in the current reference). Documented param is time_range (day|week|
		// month|year); the legacy 'days' field is not in the API reference.
		const tr = (opts.freshness && opts.freshness !== 'none' ? opts.freshness : undefined) as
			| 'day'
			| 'week'
			| 'month'
			| 'year'
			| undefined;
		if (tr) body.time_range = tr;
		const d = await postJson<{
			results?: { title?: string; url?: string; content?: string; published_date?: string }[];
		}>('https://api.tavily.com/search', body, jsonHeaders({ Authorization: `Bearer ${key}` }), signal);
		const hits: SearchHit[] = (d.results ?? [])
			.filter((r) => r?.url)
			.map((r) => ({
				title: r.title ?? r.url!,
				url: r.url!,
				snippet: r.content ?? '',
				engine: 'tavily',
				date: r.published_date,
			}));
		return { engine: 'tavily', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'tavily', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function exa(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().exaKey!;
	try {
		const body: Record<string, unknown> = {
			query: opts.query,
			numResults: opts.maxResults ?? 8,
			// docs: request contents.highlights for query-relevant snippets (free up
			// to 10 results per search): text:false returned no snippets at all
			contents: { highlights: true },
		};
		// exa has no relative window param; their documented filter is an absolute
		// ISO startPublishedDate. Compute now - window from freshness.
		const f = opts.freshness && opts.freshness !== 'none' ? FRESHNESS_DAYS[opts.freshness] : undefined;
		if (f !== undefined) {
			const start = new Date(Date.now() - f * 86_400_000).toISOString();
			body.startPublishedDate = start;
		}
		const d = await postJson<{
			results?: { title?: string; url?: string; highlights?: string[]; publishedDate?: string }[];
		}>('https://api.exa.ai/search', body, jsonHeaders({ 'x-api-key': key }), signal);
		const hits: SearchHit[] = (d.results ?? [])
			.filter((r) => r?.url)
			.map((r) => ({
				title: r.title ?? r.url!,
				url: r.url!,
				snippet: (r.highlights ?? []).join(' '),
				engine: 'exa',
				date: r.publishedDate,
			}));
		return { engine: 'exa', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'exa', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function brave(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().braveKey!;
	try {
		const url = new URL('https://api.search.brave.com/res/v1/web/search');
		url.searchParams.set('q', opts.query);
		url.searchParams.set('count', String(opts.maxResults ?? 8));
		url.searchParams.set('extra_snippets', 'true');
		url.searchParams.set('text_decorations', 'false');
		url.searchParams.set('safesearch', 'moderate');
		const f = opts.freshness && opts.freshness !== 'none' ? BRAVE_FRESHNESS[opts.freshness] : undefined;
		if (f) url.searchParams.set('freshness', f);
		const d = await getJson<{
			web?: {
				results?: { title?: string; url?: string; description?: string; extra_snippets?: string[]; age?: string }[];
			};
		}>(url.toString(), { Accept: 'application/json', 'X-Subscription-Token': key }, signal);
		const hits: SearchHit[] = (d.web?.results ?? [])
			.filter((r) => r?.url)
			.map((r) => ({
				title: r.title ?? r.url!,
				url: r.url!,
				snippet: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join('\n'),
				engine: 'brave',
				date: r.age,
			}));
		return { engine: 'brave', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'brave', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function jina(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().jinaKey;
	try {
		// official form is s.jina.ai/?q=<query> (path-style also worked but is not
		// documented); search requires a key (docs: no key = blocked on s.jina.ai)
		const url = new URL('https://s.jina.ai/');
		url.searchParams.set('q', opts.query);
		url.searchParams.set('count', String(opts.maxResults ?? 8));
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'X-Respond-With': 'no-content',
			'X-Retain-Images': 'none',
		};
		headers.Authorization = `Bearer ${key}`;
		const d = await getJson<{
			data?: { title?: string | null; url?: string | null; description?: string | null; content?: string | null }[];
		}>(url.toString(), headers, signal);
		const hits: SearchHit[] = (d.data ?? [])
			.filter((r) => r?.url)
			.map((r) => ({
				title: r.title ?? r.url!,
				url: r.url!,
				snippet: r.description?.trim() || r.content?.trim() || '',
				engine: 'jina',
			}));
		return { engine: 'jina', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'jina', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function kagi(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().kagiKey!;
	try {
		// v1 API: GET /api/v1/search with Authorization: Bot <key> (per the
		// official quickstart; the OpenAPI also lists POST). Result items live in
		// data.search[] with url/title/snippet/published at top level.
		const url = new URL('https://kagi.com/api/v1/search');
		url.searchParams.set('q', opts.query);
		url.searchParams.set('limit', String(opts.maxResults ?? 8));
		const d = await getJson<{
			data?: {
				search?: {
					url?: string;
					link?: string;
					title?: string;
					t?: string;
					snippet?: string;
					s?: string;
					published?: string;
				}[];
			};
		}>(url.toString(), { Accept: 'application/json', Authorization: `Bot ${key}` }, signal);
		const hits: SearchHit[] = (d.data?.search ?? [])
			.filter((r) => r?.url || r?.link)
			.map((r) => ({
				title: r.title ?? r.t ?? r.url ?? r.link!,
				url: r.url ?? r.link!,
				snippet: r.snippet ?? r.s ?? '',
				engine: 'kagi',
				date: r.published,
			}));
		return { engine: 'kagi', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'kagi', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function you(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().youKey!;
	try {
		// POST /v1/search (docs: GET is legacy, no new features); auth is the
		// X-API-Key header; web + news results live in results.web[] / .news[].
		const body: Record<string, unknown> = {
			query: opts.query,
			count: opts.maxResults ?? 8,
			safesearch: 'moderate',
		};
		const tr = opts.freshness && opts.freshness !== 'none' ? opts.freshness : undefined;
		if (tr) body.freshness = tr;
		const d = await postJson<{
			results?: {
				web?: { url?: string; title?: string; description?: string; snippets?: string[]; page_age?: string }[];
				news?: { url?: string; title?: string; description?: string; page_age?: string }[];
			};
		}>('https://ydc-index.io/v1/search', body, jsonHeaders({ 'X-API-Key': key }), signal);
		const rows = [
			...(d.results?.web ?? []).map((w) => ({
				title: w.title ?? w.url ?? '',
				url: w.url ?? '',
				snippet: w.snippets?.join('\n') || w.description || '',
				date: w.page_age,
			})),
			...(d.results?.news ?? []).map((n) => ({
				title: n.title ?? n.url ?? '',
				url: n.url ?? '',
				snippet: n.description || '',
				date: n.page_age,
			})),
		].filter((r) => r.url);
		const hits: SearchHit[] = rows.map((r) => ({ ...r, engine: 'you' }));
		return { engine: 'you', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'you', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function firecrawl(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().firecrawlKey!;
	try {
		const body: Record<string, unknown> = { query: opts.query, limit: opts.maxResults ?? 8, sources: ['web'] };
		const tbs = TBS[opts.freshness ?? 'none'];
		if (tbs) body.tbs = tbs;
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: `Bearer ${key}`,
		};
		type FcHit = { url?: string; title?: string; description?: string; snippet?: string; markdown?: string };
		const d = await request<{
			success?: boolean;
			data?: { web?: FcHit[] } | FcHit[];
			results?: FcHit[];
		}>('https://api.firecrawl.dev/v2/search', { method: 'POST', headers, body: JSON.stringify(body) }, signal);
		const web: FcHit[] = Array.isArray(d.data) ? d.data : (d.data?.web ?? d.results ?? []);
		const hits: SearchHit[] = web
			.filter((r) => r?.url)
			.map((r) => ({
				title: r.title ?? r.url!,
				url: r.url!,
				snippet: r.description ?? r.snippet ?? r.markdown ?? '',
				engine: 'firecrawl',
			}));
		return { engine: 'firecrawl', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'firecrawl', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

async function tinyfish(opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	const key = getConfig().tinyfishKey!;
	try {
		const url = new URL('https://api.search.tinyfish.ai');
		url.searchParams.set('query', opts.query);
		if (opts.maxResults) url.searchParams.set('num_results', String(opts.maxResults));
		const d = await getJson<{ results?: { url?: string; title?: string; snippet?: string; position?: number }[] }>(
			url.toString(),
			{ Accept: 'application/json', 'X-API-Key': key },
			signal,
		);
		const hits: SearchHit[] = (d.results ?? [])
			.filter((r) => r?.url)
			.map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: r.snippet ?? '', engine: 'tinyfish' }));
		return { engine: 'tinyfish', hits, latencyMs: Date.now() - t0 };
	} catch (e) {
		return { engine: 'tinyfish', hits: [], error: sanitizeError(e), latencyMs: Date.now() - t0 };
	}
}

// ---------------------------------------------------------------------------
// registry + dispatch
// ---------------------------------------------------------------------------

export const ENGINE_REGISTRY: EngineDef[] = [
	{ id: 'serper', available: (c) => !!c.serperKey, search: serper },
	{ id: 'tavily', available: (c) => !!c.tavilyKey, search: tavily },
	{ id: 'exa', available: (c) => !!c.exaKey, search: exa },
	{ id: 'brave', available: (c) => !!c.braveKey, search: brave },
	{ id: 'jina', available: (c) => !!c.jinaKey, search: jina },
	{ id: 'kagi', available: (c) => !!c.kagiKey, search: kagi },
	{ id: 'you', available: (c) => !!c.youKey, search: you },
	{ id: 'firecrawl', available: (c) => !!c.firecrawlKey, search: firecrawl },
	{ id: 'tinyfish', available: (c) => !!c.tinyfishKey, search: tinyfish },
];

function parseEngineList(raw: string | undefined): EngineName[] | undefined {
	if (!raw) return undefined;
	const out: EngineName[] = [];
	for (const s of raw.split(',')) {
		const t = s.trim().toLowerCase();
		if (!t) continue;
		if (ENGINE_REGISTRY.some((e) => e.id === t)) out.push(t as EngineName);
	}
	return out.length ? out : undefined;
}

/** Which engines to run: explicit param > WSEARCH_ENGINES pin > all configured. */
export function selectEngines(opts: SearchOptions): EngineDef[] {
	const cfg = getConfig();
	const wanted = opts.engines ?? parseEngineList(cfg.searchEngines);
	const selected = ENGINE_REGISTRY.filter((def) => {
		if (!def.available(cfg)) return false;
		return wanted ? wanted.includes(def.id) : true;
	});
	return selected;
}

export async function runEngines(opts: SearchOptions): Promise<EngineOutcome[]> {
	const chosen = selectEngines(opts);
	if (chosen.length === 0) {
		return [
			{
				engine: 'none',
				hits: [],
				error: 'no search engine keys configured',
				latencyMs: 0,
			} as EngineOutcome,
		];
	}
	return Promise.all(chosen.map((def) => def.search(opts, opts.signal)));
}
