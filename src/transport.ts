/**
 * Transport for web.fetch: UA-rotating local HTTP + the key-gated reader
 * backends. Text processing lives in scrape.ts (one-way import).
 */
import { getConfig, sanitizeError } from './config';
import { ABORT_ERROR } from './constants';

export type Renderer = 'local' | 'firecrawl' | 'tavily' | 'exa' | 'jina' | 'kagi' | 'tinyfish' | 'serper' | 'you';

export type RemoteRenderer = Exclude<Renderer, 'local'>;

export interface RemoteDoc {
	title: string;
	markdown: string;
}

export const DEFAULT_SECTION_CAP = 3000;

const USER_AGENTS = [
	'curl/8.0',
	'Mozilla/5.0 (compatible; TextBot/1.0)',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 pi-web-search/0.1',
];
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const LOCAL_TIMEOUT_MS = 15_000;
const RETRY_AFTER_MAX_MS = 10_000;
const READER_TIMEOUTS: Record<RemoteRenderer, number> = {
	firecrawl: 45_000,
	tavily: 30_000,
	exa: 20_000,
	jina: 20_000,
	kagi: 30_000,
	tinyfish: 25_000,
	serper: 25_000,
	you: 25_000,
};

function isBotBlocked(status: number, content: string): boolean {
	if (status !== 403 && status !== 503 && status !== 402) return false;
	const lower = content.toLowerCase();
	return (
		lower.includes('cloudflare') ||
		lower.includes('captcha') ||
		lower.includes('challenge') ||
		lower.includes('blocked') ||
		lower.includes('access denied') ||
		lower.includes('bot detection') ||
		lower.includes('enable javascript')
	);
}

export function looksLikeHtml(content: string): boolean {
	const t = content.trim().toLowerCase();
	return t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<head') || t.startsWith('<body');
}

const DATA_URI_IMAGE_RE = /!\[((?:\\.|[^\\\]])*)\]\(\s*(?:<data:[^>]*>|data:[^)\s]*)[^)]*\)/gi;

export function stripDataUriImages(markdown: string): string {
	return markdown.replace(DATA_URI_IMAGE_RE, (_m, alt: string) => (alt.trim() ? `![${alt}]` : ''));
}

export function isLowQualityOutput(content: string): boolean {
	const lower = content.toLowerCase();
	if (
		/\b(?:experiencing an access issue|unusual traffic|confirm you are (?:a )?(?:human|not a bot))\b/.test(lower) ||
		(lower.includes('icanhazip.com') && lower.length < 2048)
	)
		return true;
	const jsGated = [
		'enable javascript',
		'javascript required',
		'turn on javascript',
		'please enable javascript',
		'browser not supported',
	];
	if (content.length < 1024 && jsGated.some((t) => lower.includes(t))) return true;
	const lines = content.split('\n').filter((l) => l.trim());
	if (lines.length > 30) {
		const seen = new Map<string, number>();
		for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
		const dupChars = [...seen.entries()].reduce((n, [, c]) => (c > 1 ? n + c : n), 0);
		if (dupChars / lines.length > 0.3) return true;
	}
	const words = lower.split(/\s+/).filter(Boolean);
	if (words.length > 150) {
		const grams = new Map<string, number>();
		for (let i = 0; i <= words.length - 5; i++) {
			const g = words.slice(i, i + 5).join(' ');
			grams.set(g, (grams.get(g) ?? 0) + 1);
		}
		const repeatedGrams = [...grams.values()].filter((c) => c > 1).length;
		if (repeatedGrams / grams.size > 0.2) return true;
	}
	const totalChars = lines.reduce((n, l) => n + l.trim().length, 0);
	const shortChars = lines.reduce((n, l) => (l.trim().length < 40 ? n + l.trim().length : n), 0);
	if (lines.length > 10 && totalChars > 0 && shortChars / totalChars > 0.6) return true;
	return false;
}

export function isRawText(contentType: string): boolean {
	const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	return mime === 'text/plain' || mime === 'text/markdown' || mime.endsWith('+markdown');
}

function parseRetryAfter(value: string | null): number {
	if (!value) return 1_000;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
	return 1_000;
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error(ABORT_ERROR));
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error(ABORT_ERROR));
		};
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

const MOJIBAKE_RE = /[ÃÂâ€œâ€ â€™Ã©Ã¼ï¬Åˆ]{2,}|â€[˜›”˜]/g;

function looksMojibake(text: string): boolean {
	if (!text.includes('Ã') && !text.includes('â€') && !text.includes('Â')) return false;
	const hits = text.match(MOJIBAKE_RE);
	return !!hits && hits.length >= 2 && hits.length * 12 > text.length * 0.001;
}

const CP1252_REV = new Map([
	[0x20ac, 0x80],
	[0x201a, 0x82],
	[0x192, 0x83],
	[0x201e, 0x84],
	[0x2026, 0x85],
	[0x2020, 0x86],
	[0x2021, 0x87],
	[0x2c6, 0x88],
	[0x2030, 0x89],
	[0x160, 0x8a],
	[0x2039, 0x8b],
	[0x152, 0x8c],
	[0x17d, 0x8e],
	[0x2018, 0x91],
	[0x2019, 0x92],
	[0x201c, 0x93],
	[0x201d, 0x94],
	[0x2022, 0x95],
	[0x2013, 0x96],
	[0x2014, 0x97],
	[0x2dc, 0x98],
	[0x2122, 0x99],
	[0x161, 0x9a],
	[0x203a, 0x9b],
	[0x152, 0x9c],
	[0x17e, 0x9e],
	[0x178, 0x9f],
]);

function repairMojibake(text: string): string {
	try {
		const bytes = new Uint8Array(
			[...text].map((c) => {
				const cp = c.codePointAt(0)!;
				return cp < 256 ? cp : (CP1252_REV.get(cp) ?? 0x3f);
			}),
		);
		const repaired = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
		const before = (text.match(MOJIBAKE_RE) ?? []).length;
		const after = (repaired.match(MOJIBAKE_RE) ?? []).length;
		return after < before ? repaired : text;
	} catch {
		return text;
	}
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
	const label =
		/charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1] ??
		/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 2048)))?.[1];
	let text: string;
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			text = new TextDecoder(label).decode(bytes);
		} catch {
			text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
		}
	} else {
		text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	}
	return looksMojibake(text) ? repairMojibake(text) : text;
}

async function readBodyBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(res.headers.get('content-length') ?? 0);
	if (declared > maxBytes) throw new Error('page too large');
	const reader = res.body?.getReader();
	if (!reader) {
		const buf = await res.arrayBuffer();
		if (buf.byteLength > maxBytes) throw new Error('page too large');
		return new Uint8Array(buf);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) throw new Error('page too large');
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out;
}

export interface ConditionalValidators {
	etag?: string;
	lastModified?: string;
}

export async function localFetch(
	url: URL,
	signal?: AbortSignal,
	validators?: ConditionalValidators,
): Promise<{ body: string; contentType: string; validators: ConditionalValidators; notModified: boolean }> {
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) throw new Error(ABORT_ERROR);
		const { ctrl, done } = withTimeout('local fetch', LOCAL_TIMEOUT_MS, signal);
		try {
			const condHeaders: Record<string, string> = {};
			if (validators?.etag) condHeaders['If-None-Match'] = validators.etag;
			if (validators?.lastModified) condHeaders['If-Modified-Since'] = validators.lastModified;
			const res = await fetch(url, {
				headers: {
					'User-Agent': USER_AGENTS[attempt],
					Accept: 'text/markdown,text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
					'Accept-Language': 'en-US,en;q=0.5',
					...condHeaders,
				},
				redirect: 'follow',
				signal: ctrl.signal,
			});
			if (res.status === 304 && attempt === 0) {
				done();
				return { body: '', contentType: '', validators: validators ?? {}, notModified: true };
			}
			const ct = res.headers.get('content-type') ?? '';
			const mime = ct.split(';')[0]?.trim().toLowerCase() ?? '';
			if (
				!/html|xml|text/.test(mime) &&
				!mime.includes('application/javascript') &&
				!mime.includes('application/json')
			) {
				throw new Error(`not a readable page (${mime || '?'})`);
			}
			if (res.status === 429 && !retried429) {
				retried429 = true;
				await waitAbortable(parseRetryAfter(res.headers.get('retry-after')), signal);
				attempt--;
				continue;
			}
			if (!res.ok) {
				const sample = await res.text().catch(() => '');
				if (isBotBlocked(res.status, sample) && attempt < USER_AGENTS.length - 1) continue;
				throw new Error(`HTTP ${res.status}`);
			}
			const bytes = await readBodyBounded(res, MAX_HTML_BYTES);
			if (bytes.byteLength === 0) throw new Error('empty body');
			return {
				body: decodeBody(bytes, ct),
				contentType: ct,
				validators: {
					etag: res.headers.get('etag') ?? undefined,
					lastModified: res.headers.get('last-modified') ?? undefined,
				},
				notModified: false,
			};
		} catch (e) {
			if (signal?.aborted) throw new Error(ABORT_ERROR, { cause: e });
			const clean = sanitizeError(e);
			if (
				attempt < USER_AGENTS.length - 1 &&
				/HTTP 40[13]|HTTP 503|cloudflare|captcha|blocked|access denied/i.test(clean)
			) {
				continue;
			}
			throw e;
		} finally {
			done();
		}
	}
	throw new Error('local fetch failed');
}

// Per-attempt timeout + pre-abort: an already-aborted signal never fires
// abort listeners, so the request must reject immediately on its own.
export function withTimeout(
	label: string,
	ms: number,
	signal?: AbortSignal,
): { ctrl: AbortController; done: () => void } {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(new Error(`${label} timeout`)), ms);
	const onAbort = () => ctrl.abort(signal?.reason ?? new Error(ABORT_ERROR));
	if (signal?.aborted) ctrl.abort(signal?.reason ?? new Error(ABORT_ERROR));
	else signal?.addEventListener('abort', onAbort, { once: true });
	return {
		ctrl,
		done: () => {
			clearTimeout(t);
			signal?.removeEventListener('abort', onAbort);
		},
	};
}

async function readJson<T>(
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string },
	ctrl: AbortSignal,
): Promise<T> {
	const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: ctrl });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as T;
}

async function firecrawlRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().firecrawlKey!;
	const { ctrl, done } = withTimeout('firecrawl', READER_TIMEOUTS.firecrawl, signal);
	try {
		const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: url.toString(), formats: ['markdown'], onlyMainContent: true, timeout: 45000 }),
			signal: ctrl.signal,
		});
		if (!res.ok) throw new Error(`firecrawl HTTP ${res.status}`);
		const d = (await res.json()) as { success?: boolean; data?: { markdown?: string; metadata?: { title?: string } } };
		const md = d.data?.markdown ?? '';
		if (!md) throw new Error('firecrawl returned no markdown');
		return {
			title: d.data?.metadata?.title ?? '',
			markdown: md.length > MAX_HTML_BYTES ? md.slice(0, MAX_HTML_BYTES) : md,
		};
	} finally {
		done();
	}
}

// Docs: auth is Authorization: Bearer (not body api_key); per-URL failures
// land in failed_results, not an error status.
async function tavilyRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().tavilyKey!;
	const { ctrl, done } = withTimeout('tavily', READER_TIMEOUTS.tavily, signal);
	try {
		const d = await readJson<{
			results?: { url?: string; title?: string; raw_content?: string }[];
			failed_results?: { url?: string; error?: string }[];
		}>(
			'https://api.tavily.com/extract',
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify({ urls: [url.toString()], extract_depth: 'basic', format: 'markdown' }),
			},
			ctrl.signal,
		);
		const doc = (d.results ?? []).find((r) => r && !!r.raw_content);
		if (!doc?.raw_content?.trim()) {
			const fail = (d.failed_results ?? [])[0];
			throw new Error(
				fail
					? `tavily extract failed: ${fail.error ?? fail.url ?? 'no content'}`
					: 'tavily extract returned no content',
			);
		}
		return { title: doc.title ?? '', markdown: doc.raw_content };
	} finally {
		done();
	}
}

// Docs: /contents has no contents wrapper; text is an object, not a boolean.
async function exaRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().exaKey!;
	const { ctrl, done } = withTimeout('exa', READER_TIMEOUTS.exa, signal);
	try {
		const d = await readJson<{ results?: { url?: string; title?: string; text?: string }[] }>(
			'https://api.exa.ai/contents',
			{
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': key },
				body: JSON.stringify({ urls: [url.toString()], text: { maxCharacters: 12000 } }),
			},
			ctrl.signal,
		);
		const doc = (d.results ?? []).find((r) => r && !!r.text);
		if (!doc?.text?.trim()) throw new Error('exa contents returned no content');
		return { title: doc.title ?? '', markdown: doc.text };
	} finally {
		done();
	}
}

async function jinaRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().jinaKey;
	const { ctrl, done } = withTimeout('jina', READER_TIMEOUTS.jina, signal);
	try {
		const headers: Record<string, string> = { Accept: 'text/markdown', 'X-No-Cache': 'true' };
		if (key) headers.Authorization = `Bearer ${key}`;
		const res = await fetch(`https://r.jina.ai/${url.toString()}`, { method: 'GET', headers, signal: ctrl.signal });
		if (!res.ok) throw new Error(`jina reader HTTP ${res.status}`);
		const body = await res.text();
		const marker = 'Markdown Content:';
		const start = body.indexOf(marker);
		const content = (start >= 0 ? body.slice(start + marker.length) : body).trim();
		if (content.length < 100 || content.startsWith('Loading...') || content.startsWith('Please enable JavaScript')) {
			throw new Error('jina reader returned no usable content');
		}
		return { title: '', markdown: content };
	} finally {
		done();
	}
}
async function kagiRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().kagiKey!;
	const { ctrl, done } = withTimeout('kagi', READER_TIMEOUTS.kagi, signal);
	try {
		const d = await readJson<{
			data?: { output?: string; references?: { title?: string; url?: string }[] };
		}>(
			'https://kagi.com/api/v0/summarize',
			{
				method: 'POST',
				headers: { Authorization: `Bot ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: url.toString(), summary_type: 'takeaway' }),
			},
			ctrl.signal,
		);
		const output = d.data?.output?.trim() ?? '';
		if (output.length < 100) throw new Error('kagi summarizer returned no usable summary');
		const refs = (d.data?.references ?? []).filter((r) => r?.url);
		const markdown = refs.length
			? `${output}\n\nSources:\n${refs.map((r) => `- [${r.title ?? r.url}](${r.url})`).join('\n')}`
			: output;
		return { title: '', markdown };
	} finally {
		done();
	}
}
async function tinyfishRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().tinyfishKey!;
	const { ctrl, done } = withTimeout('tinyfish', READER_TIMEOUTS.tinyfish, signal);
	try {
		const d = await readJson<{ results?: { url?: string; title?: string; text?: string; markdown?: string }[] }>(
			'https://api.fetch.tinyfish.ai',
			{
				method: 'POST',
				headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ urls: [url.toString()] }),
			},
			ctrl.signal,
		);
		const doc = (d.results ?? []).find((r) => r && !!r.text);
		if (!doc?.text?.trim()) throw new Error('tinyfish fetch returned no content');
		return { title: doc.title ?? '', markdown: doc.markdown ?? doc.text };
	} finally {
		done();
	}
}
async function serperRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().serperKey!;
	const { ctrl, done } = withTimeout('serper', READER_TIMEOUTS.serper, signal);
	try {
		const d = await readJson<Record<string, unknown>>(
			'https://scrape.serper.dev/',
			{
				method: 'POST',
				headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: url.toString(), includeMarkdown: true }),
			},
			ctrl.signal,
		);
		const data = (typeof d.data === 'object' && d.data ? (d.data as Record<string, unknown>) : {}) as Record<
			string,
			unknown
		>;
		const md = (typeof data.markdown === 'string' ? data.markdown : (d.markdown ?? d.text ?? '')) as string | undefined;
		const markdown = (md ?? '').trim();
		if (markdown.length < 100) throw new Error('serper scrape returned no usable content');
		return { title: typeof d.title === 'string' ? d.title : '', markdown };
	} finally {
		done();
	}
}
async function youRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().youKey!;
	const { ctrl, done } = withTimeout('you', READER_TIMEOUTS.you, signal);
	try {
		const rows = await readJson<{ url?: string; title?: string; markdown?: string }[]>(
			'https://ydc-index.io/v1/contents',
			{
				method: 'POST',
				headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ urls: [url.toString()], formats: ['markdown'] }),
			},
			ctrl.signal,
		);
		const doc = (rows ?? []).find((r) => r && !!r.markdown);
		if (!doc?.markdown?.trim()) throw new Error('you contents returned no markdown');
		return { title: doc.title ?? '', markdown: doc.markdown };
	} finally {
		done();
	}
}

interface Reader {
	available(): boolean;
	read(url: URL, signal?: AbortSignal): Promise<RemoteDoc>;
}

const READERS: Record<RemoteRenderer, Reader> = {
	firecrawl: { available: () => !!getConfig().firecrawlKey, read: firecrawlRead },
	tavily: { available: () => !!getConfig().tavilyKey, read: tavilyRead },
	exa: { available: () => !!getConfig().exaKey, read: exaRead },
	jina: {
		available: () => !!getConfig().jinaKey || (getConfig().fetchChain ?? '').split(',').includes('jina'),
		read: jinaRead,
	},
	kagi: { available: () => !!getConfig().kagiKey, read: kagiRead },
	tinyfish: { available: () => !!getConfig().tinyfishKey, read: tinyfishRead },
	serper: { available: () => !!getConfig().serperKey, read: serperRead },
	you: { available: () => !!getConfig().youKey, read: youRead },
};

const REMOTE_ORDER: RemoteRenderer[] = ['jina', 'tinyfish', 'firecrawl', 'tavily', 'exa', 'serper', 'you', 'kagi'];

function readerOrder(): RemoteRenderer[] {
	const raw = getConfig().fetchChain;
	if (raw) {
		const kept: RemoteRenderer[] = [];
		for (const s of raw.split(',')) {
			const t = s.trim().toLowerCase();
			if (!t) continue;
			if (t in READERS) kept.push(t as RemoteRenderer);
		}
		if (kept.length) return kept;
	}
	return REMOTE_ORDER;
}

export function stubReader(id: RemoteRenderer, reader: Reader): () => void {
	const saved = READERS[id];
	READERS[id] = reader;
	return () => {
		READERS[id] = saved;
	};
}

export type ChainResult =
	| { ok: true; doc: RemoteDoc & { renderer: Renderer } }
	| { ok: false; aborted: boolean; error: string };

export async function remoteChain(
	url: URL,
	signal: AbortSignal | undefined,
	usable: (markdown: string) => boolean,
): Promise<ChainResult> {
	const order = readerOrder();
	const errors: string[] = [];
	for (const id of order) {
		if (signal?.aborted) return { ok: false, aborted: true, error: ABORT_ERROR };
		const reader = READERS[id];
		if (!reader.available()) continue;
		try {
			const doc = await reader.read(url, signal);
			if (!usable(doc.markdown)) continue;
			return { ok: true, doc: { ...doc, renderer: id } };
		} catch (e) {
			if (signal?.aborted) return { ok: false, aborted: true, error: ABORT_ERROR };
			errors.push(`${id}: ${sanitizeError(e)}`);
		}
	}
	return {
		ok: false,
		aborted: false,
		error: errors.length ? `reader chain exhausted: ${errors.join('; ')}` : 'no reader backend configured',
	};
}
