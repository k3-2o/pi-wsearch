/**
 * Transport for web.fetch: UA-rotating local HTTP + the key-gated reader
 * backends. Text processing lives in scrape.ts (one-way import).
 */
import { getConfig, sanitizeError } from './config';
import { ABORT_ERROR } from './constants';

export type Renderer = 'local' | 'firecrawl' | 'tavily' | 'exa' | 'jina';

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
};

function isBotBlocked(status: number, content: string): boolean {
	if (status !== 403 && status !== 503) return false;
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
	const jsGated = [
		'enable javascript',
		'javascript required',
		'turn on javascript',
		'please enable javascript',
		'browser not supported',
	];
	if (content.length < 1024 && jsGated.some((t) => lower.includes(t))) return true;
	const lines = content.split('\n').filter((l) => l.trim());
	const shortLines = lines.filter((l) => l.trim().length < 40);
	if (lines.length > 10 && shortLines.length / lines.length > 0.7) return true;
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

function decodeBody(bytes: Uint8Array, contentType: string): string {
	const label =
		/charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1] ??
		/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 2048)))?.[1];
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {}
	}
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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

export async function localFetch(url: URL, signal?: AbortSignal): Promise<{ body: string; contentType: string }> {
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) throw new Error(ABORT_ERROR);
		const { ctrl, done } = withTimeout('local fetch', LOCAL_TIMEOUT_MS, signal);
		try {
			const res = await fetch(url, {
				headers: {
					'User-Agent': USER_AGENTS[attempt],
					Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.5',
				},
				redirect: 'follow',
				signal: ctrl.signal,
			});
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
			return { body: decodeBody(bytes, ct), contentType: ct };
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
function withTimeout(label: string, ms: number, signal?: AbortSignal): { ctrl: AbortController; done: () => void } {
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

interface Reader {
	available(): boolean;
	read(url: URL, signal?: AbortSignal): Promise<RemoteDoc>;
}

const READERS: Record<RemoteRenderer, Reader> = {
	firecrawl: { available: () => !!getConfig().firecrawlKey, read: firecrawlRead },
	tavily: { available: () => !!getConfig().tavilyKey, read: tavilyRead },
	exa: { available: () => !!getConfig().exaKey, read: exaRead },
	jina: { available: () => !!getConfig().jinaKey, read: jinaRead },
};

const REMOTE_ORDER: RemoteRenderer[] = ['firecrawl', 'tavily', 'exa', 'jina'];

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
	let lastError: string | undefined;
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
			lastError = sanitizeError(e);
		}
	}
	return {
		ok: false,
		aborted: false,
		error: lastError ? `reader chain exhausted: ${lastError}` : 'no reader backend configured',
	};
}
