/**
 * Fetch orchestration + pure text pipeline (transport in transport.ts). SSRF:
 * private/loopback numeric literals are rejected on the local path; see
 * isPrivateHost for the deliberate scope.
 */
import { getConfig, sanitizeError } from './config';
import { ABORT_ERROR } from './constants';
import {
	localFetch,
	looksLikeHtml,
	remoteChain,
	isRawText,
	isLowQualityOutput,
	stripDataUriImages,
	DEFAULT_SECTION_CAP,
	type RemoteDoc,
	type Renderer,
} from './transport';

export { DEFAULT_SECTION_CAP, type Renderer } from './transport';

export interface ScrapeResult {
	url: string;
	title: string;
	renderer: Renderer;
	outline: string[];
	sections: string[];
	text: string;
	truncated: boolean;
	error?: string;
}

const DEFAULT_MAX_CHARS = 12000;

export function stripToAscii(s: string): string {
	return s
		.replace(/\u00a0/g, ' ')
		.replace(/\u200b/g, '')
		.replace(/\r/g, '');
}

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

function isPrivateIpv4(h: string): boolean {
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!ipv4) return false;
	const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

function numericIpv4(h: string): string | null {
	if (!/^[0-9.]+$/.test(h) && !/^0[xX][0-9a-fA-F.]+$/.test(h)) return null;
	const fields = h.split('.');
	if (fields.length > 4) return null;
	const parts: number[] = [];
	for (const f of fields) {
		if (/^0[xX][0-9a-fA-F]+$/.test(f)) parts.push(parseInt(f, 16));
		else if (/^0[0-7]+$/.test(f)) parts.push(parseInt(f, 8));
		else if (/^\d+$/.test(f)) parts.push(Number(f));
		else return null;
	}
	const last = parts[parts.length - 1];
	if (parts.length === 1) {
		if (last >= 2 ** 32) return null;
		return [(last >>> 24) & 0xff, (last >>> 16) & 0xff, (last >>> 8) & 0xff, last & 0xff].join('.');
	}
	if (parts.slice(0, -1).some((n) => n > 255)) return null;
	if (last >= 2 ** (8 * (4 - parts.length + 1))) return null;
	if (parts.length === 2) return [parts[0], 0, 0, last].join('.');
	if (parts.length === 3) return [parts[0], parts[1], (last >>> 8) & 0xff, last & 0xff].join('.');
	return parts.join('.');
}

export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
	if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
	const mapped = /:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
	if (mapped) {
		const [a, b] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
		if (isPrivateIpv4(`${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`)) return true;
	}
	const ipv4 = numericIpv4(h);
	if (ipv4 && isPrivateIpv4(ipv4)) return true;
	if (/^[0-9a-f:]+$/.test(h) && h.includes(':')) {
		if (h.startsWith('::1') || h === '0:0:0:0:0:0:0:1') return true;
		if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
	}
	return false;
}

export function validateUrl(raw: string, allowPrivate = false): URL {
	const u = new URL(raw);
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported protocol: ${u.protocol}`);
	if (!allowPrivate && isPrivateHost(u.hostname)) throw new Error('private/loopback address rejected');
	return u;
}

export function extractHtml(html: string): { title: string; text: string } {
	const title =
		/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()?.slice(0, 200) ||
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.slice(0, 200) ||
		'';
	let h = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
		.replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
		.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
	h = h.replace(/<pre[\s>][\s\S]*?<\/pre>/gi, (m) => m.replace(/\n/g, '\uE000'));
	h = h.replace(
		/<h([1-6])[^>]*>(.*?)<\/h\1>/gis,
		(_, n, inner) => `\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, ' ').trim()}\n`,
	);
	h = h
		.replace(/<li[^>]*>/gi, '\n• ')
		.replace(/<\/(p|div|li|tr|section|article|blockquote|table|ul|ol|pre)>/gi, '\n')
		.replace(/<(br|hr)[^>]*>/gi, '\n');
	// strip tags first, THEN decode entities: escaped markup shown as literal
	// text (`&lt;limit...&gt;`) must survive as text, not be stripped as a tag
	h = h.replace(/<[^>]+>/g, ' ');
	h = h.replace(/\uE000/g, '\n');
	h = stripToAscii(decodeHtmlEntities(h));
	const lines = h
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !/^•\s*$/.test(l))
		.filter((l) => !(/^[-*•]\s/.test(l) && isNavBullet(l)));
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
			const prev = out[out.length - 1];
			if (prev && /^[-*•]\s|^\d{1,2}[.)]\s/.test(prev)) out.push(l);
			else {
				out.push('');
				out.push(l);
			}
			blank = 0;
			continue;
		}
		if (l.length < SHORT_LINE_JOIN && blank < 2) {
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

const NAV_LABEL_RE =
	/^(home|menu|about( us)?|docs?|documentation|downloads?|license|licence|support|purchase|buy|pricing|search|login|log ?in|sign ?(in|up|out)|register|account|blog|news|contact|careers?|jobs|store|shop|forum|community|tutorials?|api|guide|guides|reference|examples?|faq|help|terms|privacy|cookies?|sitemap|rss|changelog|releases?|twitter|facebook|github|discord|youtube|linkedin|mastodon|x)$/i;

function isBoilerplate(block: string): boolean {
	const t = block.trim();
	const words = t.split(/\s{2,}|\s*[|·>]\s*|\s+/).filter(Boolean);
	if (t.length < NAV_BLOCK_MAX && words.length >= 2 && words.every((w) => NAV_LABEL_RE.test(w.trim()))) return true;
	const tldr = t.length < 120;
	if (tldr) {
		if (
			/^(skip to|jump to|table of contents|related (articles|posts|links)|share this|back to top|sign (in|up| out)|subscribe to|newsletter|follow (us|@)|menu|navigation|breadcrumbs\b|tags:|categories:|©|all rights reserved|privacy policy|terms of (use|service)|cookie|cookies|accept )/i.test(
				t,
			)
		)
			return true;
	}
	const links = t.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
	if (links.length) {
		const rest = t.replace(/\[[^\]]+\]\([^)]+\)/g, '').trim();
		if (rest.length === 0) return true;
		if (rest.length < 8 && links.length >= 3) return true;
	}
	return false;
}

function isNavBullet(line: string): boolean {
	const t = line
		.replace(/^[-*•]\s*/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t) return true;
	if (t.length > NAV_LABEL_MAX) return false;
	const words = t.split(/\s{2,}|\s*[|·>]\s*/).filter(Boolean);
	if (words.length > 1) return words.every((w) => NAV_LABEL_RE.test(w.trim()));
	return NAV_LABEL_RE.test(t);
}

function scrubNavBullets(text: string): string {
	const lines = text.split('\n');
	const kept = lines.filter((l) => !/^[-*•]\s/.test(l) || !isNavBullet(l));
	return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

const normHeading = (s: string): string =>
	s
		.replace(/^[#\d.\s]+/, '')
		.replace(/[^a-z0-9 ]/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();

function isOutlineEcho(block: string, outline: string[]): boolean {
	if (outline.length < MIN_OUTLINE_FOR_ECHO) return false;
	const trimmed = block.trim();
	if (/\btable of contents\b/i.test(trimmed) && trimmed.length < 80) return true;
	const heads = outline.map(normHeading).filter(Boolean);
	const raw = trimmed
		.split('\n')
		.flatMap((l) => l.split(/(?=\d+(?:\.\d+)*\.\s)/))
		.map((l) => l.replace(/^[-*•]?\s*\d*\.?\s*/, '').trim())
		.filter((l) => l.length > 2 && l.length < OUTLINE_LINE_MAX);
	if (raw.length < MIN_OUTLINE_FOR_ECHO) return false;
	const hit = (l: string): boolean => {
		const n = normHeading(l);
		return heads.some((h) => h === n || h.startsWith(n + ' ') || n.startsWith(h + ' '));
	};
	return raw.filter(hit).length / raw.length >= 0.6;
}

export function sliceSections(
	text: string,
	sectionCap = DEFAULT_SECTION_CAP,
): { outline: string[]; sections: string[] } {
	const blocks = text.replace(/\n{3,}/g, '\n\n').split('\n\n');
	const sections: string[] = [];
	const outline: string[] = [];
	let cur = '';
	for (const b of blocks) {
		if (!b.trim()) continue;
		if (isBoilerplate(b)) continue;
		if (isOutlineEcho(b, outline)) continue;
		const hm = /^(#{1,6})\s+([^\n]+)([\s\S]*)$/.exec(b);
		if (hm) {
			const name = hm[2].trim();
			if (/^(navigation|contents|related topics|quick search|sidebar|footer)$/i.test(name)) continue;
			if (cur.trim()) sections.push(cur.trim());
			const depth = hm[1].length;
			const rest = (hm[3] ?? '').replace(/^[\n\s]+/, '');
			cur = `${'#'.repeat(depth)} ${name}` + (rest ? `\n${rest}` : '') + '\n';
			if (outline.length < OUTLINE_CAP && depth <= 4) outline.push(name.replace(/\s+/g, ' ').slice(0, 90));
			continue;
		}
		cur += scrubNavBullets(b) + '\n\n';
	}
	if (cur.trim()) sections.push(cur.trim());
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
	const capped: string[] = [];
	for (let s of pruned) {
		if (s.length > sectionCap) {
			const cut = s.slice(0, sectionCap);
			const at = cut.lastIndexOf('\n\n');
			if (at > sectionCap - CAP_BREAK_GRACE) s = cut.slice(0, at) + '\n…[section truncated]';
			else s = cut + ' …[section truncated]';
		}
		if (s.trim().length >= SECTION_MIN || /^#{1,6} /.test(s)) capped.push(s.trim());
	}
	return { outline, sections: capped };
}

export interface ScrapeOptions {
	sectionCap?: number;
	maxChars?: number;
	render?: 'auto' | 'local' | 'firecrawl';
	allowPrivate?: boolean;
	signal?: AbortSignal;
}

const SHORT_LINE_JOIN = 28;
const NAV_LABEL_MAX = 40;
const NAV_BLOCK_MAX = 90;
const OUTLINE_CAP = 14;
const OUTLINE_LINE_MAX = 90;
const MIN_OUTLINE_FOR_ECHO = 3;
const CAP_BREAK_GRACE = 400;
const SECTION_MIN = 12;

const LOCAL_MIN_TEXT = 240;
const LOCAL_MIN_OUTPUT = 200;
const MAX_JOINED_SECTIONS = 12;
const TRUNCATED_MARKER = '\n…[truncated]';

function abortResult(url: URL): ScrapeResult {
	return {
		url: url.toString(),
		title: '',
		renderer: 'local',
		outline: [],
		sections: [],
		text: '',
		truncated: false,
		error: ABORT_ERROR,
	};
}

function errorResult(url: URL, error: string): ScrapeResult {
	return {
		url: url.toString(),
		title: '',
		renderer: 'local',
		outline: [],
		sections: [],
		text: '',
		truncated: false,
		error,
	};
}

async function tryLocal(
	url: URL,
	render: 'auto' | 'local',
	signal: AbortSignal | undefined,
	sectionCap: number,
	maxChars: number,
): Promise<ScrapeResult | undefined> {
	const { body, contentType } = await localFetch(url, signal);
	let title = '';
	let text: string;
	if (isRawText(contentType)) {
		text = stripToAscii(decodeHtmlEntities(body));
	} else {
		const extracted = extractHtml(body);
		title = extracted.title;
		text = extracted.text;
	}
	if (render === 'auto' && text.length < LOCAL_MIN_TEXT) return undefined;
	const { outline, sections } = sliceSections(text, sectionCap);
	const { text: out, truncated } = joinSections(outline, sections, maxChars);
	if (render === 'auto' && (sections.length === 0 || out.length < LOCAL_MIN_OUTPUT || isLowQualityOutput(out))) {
		return undefined;
	}
	return { url: url.toString(), title, renderer: 'local', outline, sections, text: out, truncated };
}

function fromChain(
	url: URL,
	doc: RemoteDoc & { renderer: Renderer },
	sectionCap: number,
	maxChars: number,
): ScrapeResult {
	let markdown = stripDataUriImages(doc.markdown);
	let title = doc.title;
	if (looksLikeHtml(markdown)) {
		const extracted = extractHtml(markdown);
		markdown = extracted.text;
		if (extracted.title) title = extracted.title;
	}
	const { outline, sections } = sliceSections(markdown, sectionCap);
	const { text, truncated } = joinSections(outline, sections, maxChars);
	return { url: url.toString(), title, renderer: doc.renderer, outline, sections, text, truncated };
}

export async function scrape(urlRaw: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
	const cfg = getConfig();
	const url = validateUrl(urlRaw, opts.allowPrivate ?? cfg.allowPrivate);
	const sectionCap = opts.sectionCap ?? DEFAULT_SECTION_CAP;
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const render = opts.render ?? 'auto';

	if (opts.signal?.aborted) return abortResult(url);

	if (render === 'local') {
		try {
			return await tryLocal(url, 'local', opts.signal, sectionCap, maxChars);
		} catch (e) {
			return opts.signal?.aborted ? abortResult(url) : errorResult(url, sanitizeError(e));
		}
	}

	const usable = (markdown: string): boolean => {
		if (markdown.replace(/\s+/g, '').length < 100) return false;
		const { sections } = sliceSections(markdown, DEFAULT_SECTION_CAP);
		return sections.length > 0;
	};

	if (render === 'auto') {
		let local: ScrapeResult | undefined;
		try {
			local = await tryLocal(url, 'auto', opts.signal, sectionCap, maxChars);
		} catch (e) {
			if (opts.signal?.aborted) return abortResult(url);
		}
		if (local) return local;
	}

	const chainResult = await remoteChain(url, opts.signal, usable);
	if (!chainResult.ok) {
		return chainResult.aborted || opts.signal?.aborted ? abortResult(url) : errorResult(url, chainResult.error);
	}
	return fromChain(url, chainResult.doc, sectionCap, maxChars);
}

/** Compose outline + sections; the cap is honest (marker included). */
export function joinSections(
	outline: string[],
	sections: string[],
	maxChars: number,
): { text: string; truncated: boolean } {
	const parts: string[] = [];
	if (outline.length) parts.push('Outline: ' + outline.join(' | '));
	for (const s of sections.slice(0, MAX_JOINED_SECTIONS)) parts.push(s);
	let out = parts.join('\n\n').replace(/\n{3,}/g, '\n\n');
	const truncated = out.length > maxChars;
	if (truncated) out = out.slice(0, maxChars - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
	return { text: out, truncated };
}

/** Deterministic over the cached sections: repeated offset reads avoid re-fetching. */
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
