import { getConfig, sanitizeError, type ProviderKey, type WebConfig } from './config';
import { ABORT_ERROR, DEFAULT_MAX_RESULTS } from './constants';

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

type EngineName = 'serper' | 'tavily' | 'exa' | 'brave' | 'jina' | 'kagi' | 'you' | 'firecrawl' | 'tinyfish';

export interface SearchOptions {
	query: string;
	maxResults?: number;
	engines?: EngineName[];
	signal?: AbortSignal;
}

interface EngineDef {
	id: EngineName;
	key: ProviderKey;
	available(cfg: WebConfig): boolean;
	search(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome>;
}

const jsonHeaders = (extra: Record<string, string> = {}) => ({
	'Content-Type': 'application/json',
	...extra,
});

export async function postJson<T>(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<T> {
	return request<T>(url, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
}

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
	const onAbort = () => ctrl.abort(signal?.reason ?? new Error(ABORT_ERROR));
	// An already-aborted signal never fires abort listeners: pre-abort so the
	// fetch rejects immediately instead of running its full timeout.
	if (signal?.aborted) ctrl.abort(signal?.reason ?? new Error(ABORT_ERROR));
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

function extractSiteOperator(query: string): { query: string; domain?: string } {
	const m = /(?:^|\s)site:([a-z0-9.-]+[a-z0-9])(?:\s|$)/i.exec(query);
	if (!m) return { query };
	return {
		query: query
			.replace(m[0], ' ')
			.replace(/\s{2,}/g, ' ')
			.trim(),
		domain: m[1].toLowerCase(),
	};
}

async function serper(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const body: Record<string, unknown> = {
			q: opts.query,
			num: opts.maxResults ?? DEFAULT_MAX_RESULTS,
			gl: 'us',
		};
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

async function tavily(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const { query, domain } = extractSiteOperator(opts.query);
		const body: Record<string, unknown> = {
			query,
			max_results: opts.maxResults ?? DEFAULT_MAX_RESULTS,
			search_depth: 'basic',
			topic: 'general',
		};
		if (domain) body.include_domains = [domain];
		// Docs: auth = Authorization: Bearer header
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

async function exa(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const { query, domain } = extractSiteOperator(opts.query);
		const body: Record<string, unknown> = {
			query,
			numResults: opts.maxResults ?? DEFAULT_MAX_RESULTS,
			contents: { highlights: true },
		};
		if (domain) body.includeDomains = [domain];
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

async function brave(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const url = new URL('https://api.search.brave.com/res/v1/web/search');
		url.searchParams.set('q', opts.query);
		url.searchParams.set('count', String(opts.maxResults ?? DEFAULT_MAX_RESULTS));
		url.searchParams.set('extra_snippets', 'true');
		url.searchParams.set('text_decorations', 'false');
		url.searchParams.set('safesearch', 'moderate');
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

async function jina(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		// documented form is s.jina.ai/?q=; search requires a key (no key = blocked)
		const url = new URL('https://s.jina.ai/');
		url.searchParams.set('q', opts.query);
		url.searchParams.set('count', String(opts.maxResults ?? DEFAULT_MAX_RESULTS));
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

async function kagi(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const url = new URL('https://kagi.com/api/v1/search');
		url.searchParams.set('q', opts.query);
		url.searchParams.set('limit', String(opts.maxResults ?? DEFAULT_MAX_RESULTS));
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

async function you(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const body: Record<string, unknown> = {
			query: opts.query,
			count: opts.maxResults ?? DEFAULT_MAX_RESULTS,
			safesearch: 'moderate',
		};
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

async function firecrawl(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
	try {
		const body: Record<string, unknown> = {
			query: opts.query,
			limit: opts.maxResults ?? DEFAULT_MAX_RESULTS,
			sources: ['web'],
		};
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

async function tinyfish(key: string, opts: SearchOptions, signal?: AbortSignal): Promise<EngineOutcome> {
	const t0 = Date.now();
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

const ENGINE_REGISTRY: EngineDef[] = [
	{ id: 'serper', key: 'serperKey', available: (c) => !!c.serperKey, search: serper },
	{ id: 'tavily', key: 'tavilyKey', available: (c) => !!c.tavilyKey, search: tavily },
	{ id: 'exa', key: 'exaKey', available: (c) => !!c.exaKey, search: exa },
	{ id: 'brave', key: 'braveKey', available: (c) => !!c.braveKey, search: brave },
	{ id: 'jina', key: 'jinaKey', available: (c) => !!c.jinaKey, search: jina },
	{ id: 'kagi', key: 'kagiKey', available: (c) => !!c.kagiKey, search: kagi },
	{ id: 'you', key: 'youKey', available: (c) => !!c.youKey, search: you },
	{ id: 'firecrawl', key: 'firecrawlKey', available: (c) => !!c.firecrawlKey, search: firecrawl },
	{ id: 'tinyfish', key: 'tinyfishKey', available: (c) => !!c.tinyfishKey, search: tinyfish },
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

const deadEngines = new Set<string>();
const STABLE_ENGINE_ERROR = /HTTP 40[123]/;

export function clearDeadEngines(): void {
	deadEngines.clear();
}

function selectEngines(opts: SearchOptions): EngineDef[] {
	const cfg = getConfig();
	const wanted = opts.engines ?? parseEngineList(cfg.searchEngines);
	const selected = ENGINE_REGISTRY.filter((def) => {
		if (!def.available(cfg)) return false;
		return wanted ? wanted.includes(def.id) : true;
	});
	return selected;
}

export async function runEngines(opts: SearchOptions): Promise<EngineOutcome[]> {
	const cfg = getConfig();
	const chosen = selectEngines(opts).filter((def) => !deadEngines.has(def.id));
	if (chosen.length === 0) {
		const wanted = opts.engines ?? parseEngineList(getConfig().searchEngines);
		const error = wanted?.length
			? `no configured engines match the requested set (${wanted.join(', ')})`
			: 'no search engine keys configured; run /websearch to add one';
		return [{ engine: 'none', hits: [], error, latencyMs: 0 }];
	}
	return Promise.all(
		chosen.map(async (def) => {
			const outcome = await def.search(cfg[def.key] as string, opts, opts.signal);
			if (outcome.error && STABLE_ENGINE_ERROR.test(outcome.error)) deadEngines.add(def.id);
			return outcome;
		}),
	);
}
