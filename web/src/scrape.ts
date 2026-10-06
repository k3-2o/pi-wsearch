/**
 * Fetch layer: robust local-first extraction, reader chain only for what local
 * cannot do (JS-heavy, bot-walled). Local fetch (loadPage-style): UA rotation
 * with bot-wall detection, one bounded 429 retry, charset-aware decoding, and a
 * text/plain|markdown fast path that skips HTML conversion entirely. No provider
 * is needed for the common case (omp's read tool proved a plain UA-rotating
 * fetch + clean extraction handles most of the web provider-free).
 * SSRF guard: private/loopback hosts rejected on the local path.
 */
import { getConfig, sanitizeError } from './config';

export interface ScrapeResult {
	url: string;
	title: string;
	/** which backend rendered the page: 'local' or the reader-chain member */
	renderer: 'local' | 'firecrawl' | 'tavily' | 'exa' | 'jina';
	outline: string[]; // up to ~14 headings
	sections: string[]; // sliced, each ≤ sectionCap chars
	text: string; // composed, ≤ maxChars
	truncated: boolean;
	error?: string;
}

const USER_AGENTS = [
	'curl/8.0',
	'Mozilla/5.0 (compatible; TextBot/1.0)',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 pi-web-search/0.1',
];
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_SECTION_CAP = 3000;
const DEFAULT_MAX_CHARS = 12000;
const RETRY_AFTER_MAX_MS = 10_000;

export function stripToAscii(s: string): string {
	return s
		.replace(/\u00a0/g, ' ')
		.replace(/\u200b/g, '')
		.replace(/\r/g, '');
}

/** Common named HTML entities seen in page text. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	copy: '©',
	reg: '®',
	trade: '™',
	laquo: '«',
	raquo: '»',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	bull: '•',
	middot: '·',
	deg: '°',
	plusmn: '±',
	times: '×',
	divide: '÷',
	frac12: '½',
	sup2: '²',
	sup3: '³',
	ensp: ' ',
	emsp: ' ',
	thinsp: ' ',
};

/**
 * Decode HTML character entities left in page text (`&lt;` -> `<`, `&amp;` ->
 * `&`, `&#39;` -> `'`, `&nbsp;` -> nbsp). Applied AFTER tag stripping so an
 * encoded tag shown as literal text (`&lt;limit ...&gt;`) survives instead of
 * being removed as markup; undecoded entities make escaped docs unreadable.
 */
export function decodeHtmlEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
		if (body[0] === '#') {
			const hex = body[1] === 'x' || body[1] === 'X';
			const n = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return m;
			try {
				return String.fromCodePoint(n);
			} catch {
				return m;
			}
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? m;
	});
}

function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (ipv4) {
		const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
		if (a === 10) return true;
		if (a === 127) return true;
		if (a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
	}
	if (/^[0-9a-f:]+$/.test(h) && h.includes(':')) {
		if (h.startsWith('::1') || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
	}
	return false;
}

export function validateUrl(raw: string, allowPrivate = false): URL {
	const u = new URL(raw);
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported protocol: ${u.protocol}`);
	if (!allowPrivate && isPrivateHost(u.hostname)) throw new Error('private/loopback address rejected');
	return u;
}

/** Stable, key-free label for an aborted scrape. */
const abortMessage = (): string => 'aborted (user interrupt)';

/** 403/503 bodies that smell like a bot wall, not a real missing page. */
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

/** Content starts like raw HTML (catches proxies returning HTML where markdown was asked). */
export function looksLikeHtml(content: string): boolean {
	const t = content.trim().toLowerCase();
	return t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<head') || t.startsWith('<body');
}

const DATA_URI_IMAGE_RE = /!\[((?:\\.|[^\\\]])*)\]\(\s*(?:<data:[^>]*>|data:[^)\s]*)[^)]*\)/gi;

/** Drop inline data:/base64 image payloads from reader-chain markdown (noise). */
function stripDataUriImages(markdown: string): string {
	return markdown.replace(DATA_URI_IMAGE_RE, (_m, alt: string) => (alt.trim() ? `![${alt}]` : ''));
}

/** Output that is mostly a JS-gate or nav chrome: treat as a failed scrape. */
function isLowQualityOutput(content: string): boolean {
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

/** text/plain / markdown responses are final text: never run HTML extraction on them. */
function isRawText(contentType: string): boolean {
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
		if (signal?.aborted) return reject(new Error('aborted'));
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error('aborted'));
		};
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** Decode honoring Content-Type charset, then a cheap <meta charset> sniff. */
function decodeBody(buf: ArrayBuffer, contentType: string): string {
	const bytes = new Uint8Array(buf);
	const label =
		/charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1] ??
		/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 2048)))?.[1];
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {
			/* unknown label: fall back to UTF-8 */
		}
	}
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/* eslint-disable no-await-in-loop -- UA rotation + 429 retry must be sequential: later attempts depend on earlier outcomes */
async function localFetch(url: URL, signal?: AbortSignal): Promise<{ body: string; contentType: string }> {
	let lastError: string | undefined;
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) throw new Error('aborted');
		const { ctrl, done } = withTimeout('local fetch', 15_000, signal);
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
			// Bounded honor of Retry-After; a user abort during the wait stays an abort.
			if (res.status === 429 && !retried429) {
				retried429 = true;
				await waitAbortable(parseRetryAfter(res.headers.get('retry-after')), signal);
				attempt--;
				continue;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buf = await res.arrayBuffer();
			if (buf.byteLength === 0) throw new Error('empty body');
			if (buf.byteLength > MAX_HTML_BYTES) throw new Error('page too large');
			const body = decodeBody(buf, ct);
			// A bot wall with this UA may be bypassable with a browser-like UA.
			if (isBotBlocked(res.status, body) && attempt < USER_AGENTS.length - 1) continue;
			return { body, contentType: ct };
		} catch (e) {
			if (signal?.aborted) throw new Error('aborted', { cause: e });
			lastError = sanitizeError(e);
			if (attempt < USER_AGENTS.length - 1 && /HTTP 40[13]|cloudflare|captcha|blocked|access denied/i.test(lastError)) {
				continue;
			}
			throw e;
		} finally {
			done();
		}
	}
	throw new Error(lastError ?? 'local fetch failed');
}

/** Strip tags but preserve heading/code structure as text markers. */
export function extractHtml(html: string): { title: string; text: string } {
	const title =
		/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()?.slice(0, 200) ||
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.slice(0, 200) ||
		'';
	// remove chrome + scripts
	let h = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
		.replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
		.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
	// protect pre/code content from newline collapse
	h = h.replace(/<pre[\s>][\s\S]*?<\/pre>/gi, (m) => m.replace(/\n/g, '\u0001'));
	// headings keep depth markers (BEFORE tag stripping)
	h = h.replace(
		/<h([1-6])[^>]*>(.*?)<\/h\1>/gis,
		(_, n, inner) => `\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, ' ').trim()}\n`,
	);
	// block boundaries as newlines; li items get a bullet prefix (readable lists)
	h = h
		.replace(/<li[^>]*>/gi, '\n• ')
		.replace(/<\/(p|div|li|tr|section|article|blockquote|table|ul|ol|pre)>/gi, '\n')
		.replace(/<(br|hr)[^>]*>/gi, '\n');
	// strip remaining tags, THEN decode entities so escaped markup shown as
	// literal text (`&lt;limit...&gt;`) is preserved, not stripped as a tag
	h = h.replace(/<[^>]+>/g, ' ');
	// eslint-disable-next-line no-control-regex -- internal placeholder for protected newlines
	h = h.replace(/\u0001/g, '\n');
	h = stripToAscii(decodeHtmlEntities(h));
	// collapse blank lines
	const lines = h
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !/^•\s*$/.test(l)) // icon-only li: skip the orphan bullet
		.filter((l) => !(/^[-*•]\s/.test(l) && isNavBullet(l))); // nav/chrome bullets: drop at source
	const out: string[] = [];
	let blank = 0;
	for (const l of lines) {
		if (l.startsWith('#')) {
			if (out.length) out.push('');
			out.push(l);
			blank = 0;
			continue;
		}
		if (out.length === 0 || /^#{1,6} /.test(out[out.length - 1])) {
			out.push(l);
			blank = 0;
			continue;
		}
		if (/^[-*•]\s|^\d{1,2}[.)]\s/.test(l) && l.length < 80) {
			// list item: own line, no blank between siblings (fixes run-on lists)
			const prev = out[out.length - 1];
			if (prev && /^[-*•]\s|^\d{1,2}[.)]\s/.test(prev)) out.push(l);
			else {
				out.push('');
				out.push(l);
			}
			blank = 0;
			continue;
		}
		if (l.length < 28 && blank < 2) {
			// short line = heading-ish or list remnant; join to previous paragraph
			out[out.length - 1] += ' ' + l;
			blank++;
			continue;
		}
		out.push('');
		out.push(l);
		blank = 0;
	}
	return { title, text: out.join('\n').replace(/\n{3,}/g, '\n\n') };
}

/** Navigation/chrome rows that read as noise, not content. */
function isBoilerplate(block: string): boolean {
	const t = block.trim();
	// a paragraph made only of nav labels (merged `Search Search Documentation`)
	const words = t.split(/\s{2,}|\s*[|·>]\s*|\s+/).filter(Boolean);
	if (t.length < 90 && words.length >= 2 && words.every((w) => NAV_LABEL_RE.test(w.trim()))) return true;
	const tldr = t.length < 120;
	if (tldr) {
		if (
			/^(skip to|jump to|table of contents|related (articles|posts|links)|share this|back to top|sign (in|up| out)|subscribe to|newsletter|follow (us|@)|menu|navigation|breadcrumbs\b|tags:|categories:|©|all rights reserved|privacy policy|terms of (use|service)|cookie|cookies|accept )/i.test(
				t,
			)
		)
			return true;
	}
	// pure link rows (firecrawl markdown nav bars): [A](/a) [B](/b) ...
	const links = t.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
	if (links.length) {
		const rest = t.replace(/\[[^\]]+\]\([^)]+\)/g, '').trim();
		if (rest.length === 0) return true;
		if (rest.length < 8 && links.length >= 3) return true;
	}
	return false;
}

/**
 * A single nav/chrome link label (Home, About, Download, Login, …). Bullets of
 * these leak into the body of section text on most sites; drop the lines.
 */
const NAV_LABEL_RE =
	/^(home|menu|about( us)?|docs?|documentation|downloads?|license|licence|support|purchase|buy|pricing|search|login|log ?in|sign ?(in|up|out)|register|account|blog|news|contact|careers?|jobs|store|shop|forum|community|tutorials?|api|guide|guides|reference|examples?|faq|help|terms|privacy|cookies?|sitemap|rss|changelog|releases?|twitter|facebook|github|discord|youtube|linkedin|mastodon|x)$/i;

/** True for a bullet line that is just one nav/chrome label. */
function isNavBullet(line: string): boolean {
	const t = line
		.replace(/^[-*•]\s*/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t) return true; // orphan bullet
	if (t.length > 40) return false;
	// split on multi-word separators too (`Home Docs Download` run-ons)
	const words = t.split(/\s{2,}|\s*[|·>]\s*/).filter(Boolean);
	if (words.length > 1) return words.every((w) => NAV_LABEL_RE.test(w.trim()));
	return NAV_LABEL_RE.test(t);
}

/** Drop nav-bullet runs from body text (a run = 2+ nav bullets, or any 1). */
function scrubNavBullets(text: string): string {
	const lines = text.split('\n');
	const kept = lines.filter((l) => !/^[-*•]\s/.test(l) || !isNavBullet(l));
	return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Normalized heading text for outline/ToC comparison. */
const normHeading = (s: string): string =>
	s
		.replace(/^[#\d.\s]+/, '')
		.replace(/[^a-z0-9 ]/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();

/**
 * True when a block looks like an in-body table of contents that just repeats
 * the outline we already emit (most doc pages render one). Measured by how
 * many of its lines match outline headings.
 */
function isOutlineEcho(block: string, outline: string[]): boolean {
	if (outline.length < 3) return false;
	const trimmed = block.trim();
	// the ToC label on its own line, optionally prefixed by the page title
	if (/\btable of contents\b/i.test(trimmed) && trimmed.length < 80) return true;
	const heads = outline.map(normHeading).filter(Boolean);
	// split a block into candidate heading lines: by newline, then by leading
	// numbering (`2.1. Concurrency 2.2. Checkpointing` runs on one line)
	const raw = trimmed
		.split('\n')
		.flatMap((l) => l.split(/(?=\d+(?:\.\d+)*\.\s)/))
		.map((l) => l.replace(/^[-*•]?\s*\d*\.?\s*/, '').trim())
		.filter((l) => l.length > 2 && l.length < 90);
	// a ToC is a *run* of heading labels; a lone sentence that happens to
	// mention a heading word is not one
	if (raw.length < 3) return false;
	const hit = (l: string): boolean => {
		const n = normHeading(l);
		return heads.some((h) => h === n || h.startsWith(n + ' ') || n.startsWith(h + ' '));
	};
	return raw.filter(hit).length / raw.length >= 0.6;
}

/**
 * Split structured text (local or firecrawl markdown) into sections at
 * headings; drop navigation chrome and outline-echo ToCs; cap each section at
 * a paragraph boundary. Multi-newline runs are collapsed here so no path can
 * leak 3+ blank lines.
 */
export function sliceSections(
	text: string,
	sectionCap = DEFAULT_SECTION_CAP,
): { outline: string[]; sections: string[] } {
	const blocks = text.replace(/\n{3,}/g, '\n\n').split('\n\n');
	const sections: string[] = [];
	const outline: string[] = [];
	let cur = '';
	for (const b of blocks) {
		if (!b.trim()) continue; // empty fragment between runs: skip, no stray blanks
		if (isBoilerplate(b)) continue;
		if (isOutlineEcho(b, outline)) continue; // in-body ToC = the outline we already print
		const hm = /^(#{1,6})\s+([^\n]+)([\s\S]*)$/.exec(b);
		if (hm) {
			const name = hm[2].trim();
			if (/^(navigation|contents|related topics|quick search|sidebar|footer)$/i.test(name)) continue; // frame headings, not content
			if (cur.trim()) sections.push(cur.trim());
			const depth = hm[1].length;
			const rest = (hm[3] ?? '').replace(/^[\n\s]+/, '');
			cur = `${'#'.repeat(depth)} ${name}` + (rest ? `\n${rest}` : '') + '\n';
			if (outline.length < 14 && depth <= 4) outline.push(name.replace(/\s+/g, ' ').slice(0, 90));
			continue;
		}
		cur += scrubNavBullets(b) + '\n\n';
	}
	if (cur.trim()) sections.push(cur.trim());
	// Post-pass: with the full outline known, drop paragraphs that just echo it
	// (in-body ToCs render above the headings, so they precede the outline build).
	// Heading lines are always preserved; only the surrounding prose is tested.
	const pruned = sections.map((s) => {
		const paras = s.split(/\n\n/);
		const body = paras.filter((p) => {
			const nonHeading = p
				.split('\n')
				.filter((l) => !/^#{1,6} /.test(l))
				.join('\n');
			return !nonHeading.trim() || !isOutlineEcho(nonHeading, outline);
		});
		return body.join('\n\n');
	});
	// cap sections individually; slice at the last paragraph boundary, never mid-word
	const capped: string[] = [];
	for (let s of pruned) {
		if (s.length > sectionCap) {
			const cut = s.slice(0, sectionCap);
			const at = cut.lastIndexOf('\n\n');
			if (at > sectionCap - 400) s = cut.slice(0, at) + '\n…[section truncated]';
			else s = cut + ' …[section truncated]';
		}
		if (s.trim().length >= 12 || /^#{1,6} /.test(s)) capped.push(s.trim());
	}
	return { outline, sections: capped };
}

// ---------------------------------------------------------------------------
// Remote reader chain: a pocket per extraction provider, tried in order,
// key-gated, quality-gated. Local extraction is step 0 and wins when it works;
// every remote backend runs only when its key/endpoint is configured and each
// is time-bounded so one stalled endpoint cannot starve the rest.
// ---------------------------------------------------------------------------

export type Renderer = 'local' | 'firecrawl' | 'tavily' | 'exa' | 'jina';

type RemoteRenderer = Exclude<Renderer, 'local'>;

const REMOTE_ORDER: RemoteRenderer[] = ['firecrawl', 'tavily', 'exa', 'jina'];

interface RemoteDoc {
	title: string;
	markdown: string;
}

/** Per-attempt timeout + pre-abort for dead signals (listeners never fire). */
function withTimeout(label: string, ms: number, signal?: AbortSignal): { ctrl: AbortController; done: () => void } {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(new Error(`${label} timeout`)), ms);
	const onAbort = () => ctrl.abort(signal?.reason ?? new Error('aborted'));
	if (signal?.aborted) ctrl.abort(signal?.reason ?? new Error('aborted'));
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
	const { ctrl, done } = withTimeout('firecrawl', 45_000, signal);
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

async function tavilyRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().tavilyKey!;
	const { ctrl, done } = withTimeout('tavily', 30_000, signal);
	try {
		// docs: Authorization: Bearer header (not body api_key); format defaults
		// to markdown (set explicitly); per-URL failures land in failed_results
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

async function exaRead(url: URL, signal?: AbortSignal): Promise<RemoteDoc> {
	const key = getConfig().exaKey!;
	const { ctrl, done } = withTimeout('exa', 20_000, signal);
	try {
		// docs: /contents has NO contents wrapper: top-level text/highlights/
		// summary; text is an object ({maxCharacters}), not a boolean
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
	const { ctrl, done } = withTimeout('jina', 20_000, signal);
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

const READERS: Record<
	RemoteRenderer,
	{ available(): boolean; read(url: URL, signal?: AbortSignal): Promise<RemoteDoc> }
> = {
	firecrawl: { available: () => !!getConfig().firecrawlKey, read: firecrawlRead },
	tavily: { available: () => !!getConfig().tavilyKey, read: tavilyRead },
	exa: { available: () => !!getConfig().exaKey, read: exaRead },
	jina: { available: () => !!getConfig().jinaKey, read: jinaRead },
};

/** Chain order: WSEARCH_FETCH_CHAIN override (comma list), else the default. */
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

/**
 * Try each configured reader backend in order. A backend's output must clear
 * the quality gate (≥100 non-whitespace chars that slice into ≥1 section),
 * otherwise the next backend is tried. Returns null when the user aborts.
 */
/* eslint-disable no-await-in-loop -- the reader chain MUST try backends sequentially in priority order, stopping at the first that clears the gate */
async function remoteChain(url: URL, signal?: AbortSignal): Promise<(RemoteDoc & { renderer: Renderer }) | null> {
	const order = readerOrder();
	let lastError: string | undefined;
	for (const id of order) {
		if (signal?.aborted) return null;
		const reader = READERS[id];
		if (!reader.available()) continue;
		try {
			const doc = await reader.read(url, signal);
			if (doc.markdown.replace(/\s+/g, '').length < 100) continue;
			const { sections } = sliceSections(doc.markdown, DEFAULT_SECTION_CAP);
			if (sections.length === 0) continue;
			return { ...doc, renderer: id };
		} catch (e) {
			if (signal?.aborted) return null;
			lastError = sanitizeError(e);
		}
	}
	throw new Error(lastError ? `reader chain exhausted: ${lastError}` : 'no reader backend configured');
}

export interface ScrapeOptions {
	sectionCap?: number;
	maxChars?: number;
	/** "auto": try local, fall back to the reader chain; "local"/"firecrawl": force */
	render?: 'auto' | 'local' | 'firecrawl';
	allowPrivate?: boolean;
	signal?: AbortSignal;
}

export async function scrape(urlRaw: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
	const cfg = getConfig();
	const url = validateUrl(urlRaw, opts.allowPrivate ?? cfg.allowPrivate);
	const sectionCap = opts.sectionCap ?? DEFAULT_SECTION_CAP;
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const render = opts.render ?? 'auto';

	try {
		if (render === 'firecrawl') throw new Error('force remote chain');
		const { body, contentType } = await localFetch(url, opts.signal);
		let title = '';
		let text: string;
		if (isRawText(contentType)) {
			// text/plain|markdown is final text: never HTML-mangle it
			text = stripToAscii(decodeHtmlEntities(body));
		} else {
			const extracted = extractHtml(body);
			title = extracted.title;
			text = extracted.text;
		}
		if (text.length < 240 && render === 'auto') {
			throw new Error(`local extraction too thin (${text.length} chars)`);
		}
		let { outline, sections } = sliceSections(text, sectionCap);
		let out = joinSections(outline, sections, maxChars);
		let truncated = false;
		if (out.length > maxChars) {
			out = out.slice(0, maxChars) + '\n…[truncated]';
			truncated = true;
		}
		// if local gave almost nothing useful: or mostly JS-gate/nav chrome: fall
		// back, but only in auto mode (forced-local always succeeds with thin output)
		if (render === 'auto' && (sections.length === 0 || out.length < 200 || isLowQualityOutput(out))) {
			throw new Error(
				out.length < 200
					? 'local extraction empty, falling back'
					: 'local extraction is nav/JS-gate noise, falling back',
			);
		}
		return {
			url: url.toString(),
			title,
			renderer: 'local',
			outline,
			sections,
			text: out,
			truncated,
		};
	} catch (e) {
		// A user/session abort is NOT a fetch failure: never route it into a paid
		// reader backend (which would otherwise run its full timeout on the dead
		// signal). Distinguish so the abort stays abort.
		if (opts.signal?.aborted) {
			return {
				url: url.toString(),
				title: '',
				renderer: 'local',
				outline: [],
				sections: [],
				text: '',
				truncated: false,
				error: abortMessage(),
			};
		}
		if (render === 'local') {
			return {
				url: url.toString(),
				title: '',
				renderer: 'local',
				outline: [],
				sections: [],
				text: '',
				truncated: false,
				error: sanitizeError(e),
			};
		}
		let chain: RemoteDoc & { renderer: Renderer };
		try {
			chain = (await remoteChain(url, opts.signal))!;
		} catch (e2) {
			return {
				url: url.toString(),
				title: '',
				renderer: 'local',
				outline: [],
				sections: [],
				text: '',
				truncated: false,
				error: opts.signal?.aborted ? abortMessage() : sanitizeError(e2),
			};
		}
		let markdown = stripDataUriImages(chain.markdown);
		// some backends proxy raw HTML; re-extract if that slipped through
		if (looksLikeHtml(markdown)) {
			const extracted = extractHtml(markdown);
			markdown = extracted.text;
			if (extracted.title) chain = { ...chain, title: extracted.title };
		}
		const { outline, sections } = sliceSections(markdown, sectionCap);
		let out = joinSections(outline, sections, maxChars);
		let truncated = false;
		if (out.length > maxChars) {
			out = out.slice(0, maxChars) + '\n…[truncated]';
			truncated = true;
		}
		return {
			url: url.toString(),
			title: chain.title,
			renderer: chain.renderer,
			outline,
			sections,
			text: out,
			truncated,
		};
	}
}

export function joinSections(outline: string[], sections: string[], maxChars: number): string {
	const parts: string[] = [];
	if (outline.length) parts.push('Outline: ' + outline.join(' | '));
	for (const s of sections.slice(0, 12)) parts.push(s);
	let out = parts.join('\n\n').replace(/\n{3,}/g, '\n\n');
	if (out.length > maxChars) out = out.slice(0, maxChars);
	return out;
}

/**
 * Cursor-based paged read over a page's retained sections (read-tool style).
 * Canonical text = sections joined with \n\n (each section starts with its
 * heading line). Deterministic: the fetch cache stores the same sections, so
 * repeated offset reads slice the identical text without re-fetching.
 */
/**
 * Line-based paging over the retained page content (read-tool convention):
 * offset = 1-indexed start line, limit = max lines to return. Sections are
 * joined into one text stream; cursor fields let callers page through.
 */
export function pageSlice(
	sections: string[],
	offset: number,
	limit: number,
	chosen?: number[],
): { content: string; total: number; nextOffset: number | null; remaining: number } {
	const picked = chosen && chosen.length ? chosen.map((i) => sections[i] ?? '') : sections;
	const joined = picked.join('\n\n').replace(/\n{3,}/g, '\n\n');
	const lines = joined === '' ? [] : joined.split('\n');
	const total = lines.length;
	const start = Math.max(0, Math.min(offset < 1 ? 0 : offset - 1, total));
	const end = Math.min(total, start + Math.max(0, limit));
	return {
		content: lines.slice(start, end).join('\n'),
		total,
		nextOffset: end >= total ? null : end + 1,
		remaining: Math.max(0, total - end),
	};
}
