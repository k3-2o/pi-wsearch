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
	withTimeout,
	DEFAULT_SECTION_CAP,
	type RemoteDoc,
	type Renderer,
} from './transport';

export interface ScrapeResult {
	url: string;
	title: string;
	renderer: Renderer;
	outline: string[];
	sections: string[];
	text: string;
	truncated: boolean;
	continued: number[];
	publishedAt?: string;
	paywalled?: boolean;
	validators?: { etag?: string; lastModified?: string };
	error?: string;
}

const DEFAULT_MAX_CHARS = 12000;

function stripToAscii(s: string): string {
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

function stripKatexSpans(h: string): string {
	let out = '';
	let i = 0;
	for (;;) {
		const start = /<span[^>]*class="[^"]*katex[^"]*"[^>]*>/i.exec(h.slice(i));
		if (!start || start.index === undefined) {
			out += h.slice(i);
			break;
		}
		const abs = i + start.index;
		out += h.slice(i, abs);
		let depth = 1;
		let j = abs + start[0].length;
		while (depth > 0 && j < h.length) {
			const next = /<span\b[^>]*>|<\/span>/gi;
			next.lastIndex = j;
			const tag = next.exec(h);
			if (!tag) {
				j = h.length;
				break;
			}
			j = tag.index + tag[0].length;
			depth += tag[0].startsWith('</') ? -1 : 1;
		}
		i = j;
	}
	return out;
}

export function extractHtml(html: string): { title: string; text: string; publishedAt?: string; paywalled: boolean } {
	const paywalled =
		/class="[^"]*(?:fc-ab-root|metering-modal|paywall|pw-overlay|subscription-overlay|regwall)[^"]*"/i.test(html) ||
		/id="[^"]*(?:paywall|metering|pay-overlay)[^"]*"/i.test(html) ||
		/<meta[^>]+(?:property|name)=["'](?:isAccessibleForFree|tunnel:[^"']*paywall)["'][^>]+content=["'](?:false|yes)["']/i.test(
			html,
		);
	const title =
		/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()?.slice(0, 200) ||
		/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.slice(0, 200) ||
		'';
	const publishedAt = extractPublishedDate(html);
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
	h = h.replace(/<table[\s>][\s\S]*?<\/table>/gi, (table) => {
		const rows = [...table.matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)].map((r) =>
			[...r[0].matchAll(/<t([hd])[\s>][\s\S]*?<\/t\1>/gi)].map((c) =>
				c[0]
					.replace(/<[^>]+>/g, ' ')
					.replace(/\s+/g, ' ')
					.replace(/\|/g, '\\|')
					.trim(),
			),
		);
		const grid = rows.filter((r) => r.length);
		if (grid.length < 2) return table;
		const cols = Math.max(...grid.map((g) => g.length));
		if (cols < 2) return table;
		const line = (g: string[]) => {
			const cells = g.slice(0, cols);
			while (cells.length < cols) cells.push(' ');
			return `| ${cells.join(' | ')} |`;
		};
		const md = [line(grid[0]), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`];
		for (const g of grid.slice(1)) md.push(line(g));
		return `\n${md.join('\n')}\n`;
	});
	h = stripKatexSpans(h);
	h = h.replace(/<math[\s>][\s\S]*?<\/math>/gi, (m) => {
		const tex = /<annotation[^>]*encoding=["']application\/x-tex["'][^>]*>([\s\S]*?)<\/annotation>/i.exec(m)?.[1];
		return tex?.trim() ? ` $${tex.trim()}$ ` : ' ';
	});
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
		.filter((l) => !(/^[-*•]\s/.test(l) && isNavBullet(l)))
		.filter((l) => !/^#{1,6}\s*$/.test(l))
		.map((l) => (/^[-*•]\s{2,}/.test(l) ? l.replace(/^[-*•]\s+/, '').replace(/\s{2,}/g, ' ') : l))
		.filter((l) => !(l.length < 120 && isPromo(l)));
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
	return { title, publishedAt, paywalled, text: out.join('\n').replace(/\n{3,}/g, '\n\n') };
}

function extractPublishedDate(html: string): string | undefined {
	const iso = (v: string | undefined) => {
		if (!v) return undefined;
		const t = Date.parse(v.trim());
		return Number.isNaN(t) || t < 0 ? undefined : new Date(t).toISOString().slice(0, 10);
	};
	const ld = /"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1];
	const meta =
		/<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished|publish-date|pubdate|parsely-pub-date|date)["'][^>]+content=["']([^"']+)["']/i.exec(
			html,
		)?.[1];
	const timeEl = /<time[^>]+datetime=["']([^"']+)["']/i.exec(html)?.[1];
	return iso(ld) ?? iso(meta) ?? iso(timeEl);
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

const PROMO_STRONG = [
	/become a (?:premium )?member/i,
	/unlock exclusive/i,
	/go premium/i,
	/upgrade to (?:the )?premium/i,
	/your membership journey/i,
	/stay on the cutting edge/i,
	/enter your email below/i,
	/by submitting your information/i,
	/sign (?:up|you up) (?:for|to) (?:our )?(?:free )?newsletter/i,
	/subscribe to (?:our )?newsletter/i,
	/get the [a-z][a-z ]{2,40}newsletter/i,
	/limited-?time (?:premium )?offer/i,
	/choose how you want to join/i,
	/explore (?:our )?(?:premium|pro)\b/i,
	/^email newsletter\b/i,
	/^your \(?[\w\s-]+\)? email$/i,
	/^IE \d+ is not supported/i,
	/for an optimal experience visit our site/i,
	/^skip to (?:content|main)/i,
	/^for subscribers$/i,
	/^subscriber (?:only|exclusive)$/i,
	/^[A-Z][A-Z0-9 &'’-]{5,50}$/,
	/\|\s*[A-Z][\w'’&. ]{2,40}\s+\|\s*[A-Z][\w'’&. ]{2,40}\s+News\s*$/,
	/^(?:[A-Z][\w'’.\- ]{2,30}\s+\/\s+)?(?:via )?(?:Getty Images(?:\s+file)?|AP(?: Photo)?|Reuters|Xinhua(?:[\s\w/]+)?|AFP|Bloomberg(?: Photo)?|The Associated Press|NBC(?: News)? via|CNN Wire|Sipa USA|AP Photo\/[^,]{2,40})[\s.]*$/i,
	/^\d+\s*(?:s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|day|days|w|weeks?)\s+ago[\s.]*$/i,
	/^(?:updated|published)\s+(?:just\s+now|\d+\s*\w+\s+ago)$/i,
	/^\d+\s+(?:hours?|minutes?)\s+ago$/i,
	/get started with free access/i,
	/premium (?:newsletter|articles?|membership|features|offer)/i,
	/sign[- ]?up (?:was|is) successful/i,
	/we use cookies[^.]*(?:to (?:improve|enhance|personalize|analyse|analyze))/i,
	/^by continuing (?:to use|to browse)/i,
	/^(?:accept|allow) (?:all|selected|necessary)/i,
	/^(?:manage|customize|consent) (?:preferences|settings|choices)/i,
	/^this (?:site|website) uses (?:cookies|essential cookies)/i,
];
const PROMO_CTA_RE =
	/\b(?:newsletter|membership|club membership|premium member|sign ?up|subscribe|unlock|upgrade|cancel anytime|limited-?time|free trial|join now|join today)\b/gi;

function isPromo(t: string): boolean {
	if (PROMO_STRONG.some((r) => r.test(t))) return true;
	return (t.match(PROMO_CTA_RE) ?? []).length >= 2;
}

function splitSection(s: string, sectionCap: number): string[] {
	const hm = /^(#{1,6})\s+([^\n]+)/.exec(s);
	const partHead = hm ? `${'#'.repeat(hm[1].length)} ${hm[2].trim()}\n\n` : '';
	const floor = Math.min(partHead.length + 1, sectionCap);
	const parts: string[] = [];
	let rest = s;
	for (;;) {
		if (rest.length <= sectionCap) {
			parts.push(rest);
			return parts;
		}
		const cut = rest.slice(0, sectionCap);
		let at = cut.lastIndexOf('\n\n');
		if (at < floor) at = cut.lastIndexOf(' ');
		if (at < floor) at = sectionCap;
		const used = Math.min(at, rest.length - 1);
		parts.push(rest.slice(0, used).replace(/\s+$/, ''));
		rest = partHead + rest.slice(used).trimStart();
	}
}

export function sliceSections(
	text: string,
	sectionCap = DEFAULT_SECTION_CAP,
	docTitle = '',
): { outline: string[]; sections: string[]; continued: number[] } {
	const titleEcho = docTitle ? normHeading(docTitle) : '';
	const blocks = text.replace(/\n{3,}/g, '\n\n').split('\n\n');
	const sections: string[] = [];
	const outlineNames: string[] = [];
	const seenParas = new Set<string>();
	let cur = '';
	let lastBlock = '';
	for (const b of blocks) {
		const tb = b.trim();
		if (!tb || tb === lastBlock) continue;
		lastBlock = tb;
		if (!tb.startsWith('#')) {
			const paraKey = tb.replace(/\s+/g, ' ').toLowerCase();
			if (seenParas.has(paraKey)) continue;
			seenParas.add(paraKey);
		} else {
			const hm = /^(#{1,6})\s+([^\n]+)([\s\S]*)$/.exec(tb);
			const body = (hm?.[3] ?? '').trim();
			if (body) {
				const paraKey = body.replace(/\s+/g, ' ').toLowerCase();
				if (seenParas.has(paraKey)) {
					const name = hm![2].trim();
					if (isBoilerplateHeading(name) || isPromo(name)) continue;
					const depth = hm![1].length;
					if (cur.trim()) sections.push(cur.trim());
					cur = `${'#'.repeat(depth)} ${name}\n`;
					if (outlineNames.length < OUTLINE_CAP && depth <= 4)
						outlineNames.push(name.replace(/\s+/g, ' ').slice(0, 90));
					continue;
				}
				seenParas.add(paraKey);
			}
		}
		if (titleEcho && normHeading(tb) === titleEcho) continue;
		if (isBoilerplate(b) || isPromo(b)) continue;
		if (isOutlineEcho(b, outlineNames)) continue;
		const hm = /^(#{1,6})\s+([^\n]+)([\s\S]*)$/.exec(b);
		if (hm) {
			const name = hm[2].trim();
			if (isBoilerplateHeading(name) || isPromo(name)) continue;
			if (cur.trim()) sections.push(cur.trim());
			const depth = hm[1].length;
			const rest = (hm[3] ?? '').replace(/^[\n\s]+/, '');
			cur = `${'#'.repeat(depth)} ${name}` + (rest ? `\n${rest}` : '') + '\n';
			if (outlineNames.length < OUTLINE_CAP && depth <= 4) outlineNames.push(name.replace(/\s+/g, ' ').slice(0, 90));
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
			return !nonHeading.trim() || !isOutlineEcho(nonHeading, outlineNames);
		});
		return body.join('\n\n');
	});
	const capped: string[] = [];
	const continued: number[] = [];
	const outline: string[] = [];
	const lead = sections.length > 0 && !/^#{1,6} /.test(sections[0]);
	for (let i = 0; i < pruned.length; i++) {
		const s = pruned[i].trim();
		const headingOnly = /^#{1,6} [^\n]+$/.test(s);
		if (s.length < SECTION_MIN && !/^#{1,6} /.test(s)) continue;
		if (headingOnly && s.length < 120) continue;
		const hm = /^(#{1,6})\s+([^\n]+)/.exec(s);
		const own = hm ? hm[2].trim() : '(lead)';
		const base = hm ? (outlineNames[i - (lead ? 1 : 0)] ?? own) : '(lead)';
		const name = base.replace(/\s+/g, ' ').slice(0, 90);
		const parts = s.length <= sectionCap ? [s] : splitSection(s, sectionCap);
		const last = parts.length - 1;
		parts.forEach((p, k) => {
			outline.push(k === 0 ? name : `${name} (cont. ${k})`);
			if (k < last) continued.push(capped.length);
			const body =
				parts.length === 1 || k === last
					? p
					: `${p.replace(/\s+$/, '')}\n\n…(continues at outline index ${capped.length + 1})`;
			capped.push(body);
		});
	}
	return { outline, sections: capped, continued };
}

export interface ScrapeOptions {
	sectionCap?: number;
	maxChars?: number;
	render?: 'auto' | 'local' | 'firecrawl';
	allowPrivate?: boolean;
	signal?: AbortSignal;
	validators?: { etag?: string; lastModified?: string };
}

const SHORT_LINE_JOIN = 28;
const NAV_LABEL_MAX = 40;
const NAV_BLOCK_MAX = 90;
const OUTLINE_CAP = 20;
const OUTLINE_LINE_MAX = 90;
const MIN_OUTLINE_FOR_ECHO = 3;
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
		continued: [],
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
		continued: [],
		error,
	};
}

const GITHUB_REPO_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/?|\?.*)?$/;
const GITHUB_BLOB_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/([^/]+)\/(.+)$/;

function readmeCandidates(url: URL): string[] {
	if (url.hostname !== 'github.com') return [];
	const repo = GITHUB_REPO_RE.exec(url.pathname);
	if (repo) {
		return ['README.md', 'readme.md', 'README.rst', 'README.org'].map(
			(name) => `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/${name}`,
		);
	}
	const blob = GITHUB_BLOB_RE.exec(url.pathname);
	if (blob) {
		return [`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`];
	}
	return [];
}

async function scrapeReadme(
	origUrl: URL,
	opts: ScrapeOptions,
	sectionCap: number,
	maxChars: number,
): Promise<ScrapeResult | undefined> {
	const isBlob = GITHUB_BLOB_RE.test(origUrl.pathname);
	const minLen = isBlob ? 1 : 500;
	for (const rawUrl of readmeCandidates(origUrl)) {
		try {
			const { body, contentType } = await localFetch(new URL(rawUrl), opts.signal);
			if (!isRawText(contentType) || body.length < minLen) continue;
			const text = stripToAscii(decodeHtmlEntities(body));
			if (text.length < (isBlob ? 1 : LOCAL_MIN_TEXT)) continue;
			const { outline, sections, continued } = sliceSections(text, sectionCap);
			const { text: out, truncated } = joinSections(outline, sections, maxChars);
			if (!out) continue;
			const label = isBlob ? 'source (github.com)' : 'README (github.com)';
			return {
				url: origUrl.toString(),
				title: `${origUrl.pathname.split('/')[2]} — ${label}`,
				renderer: 'local',
				outline,
				sections,
				continued,
				text: out,
				truncated,
			};
		} catch {
			continue;
		}
	}
	return undefined;
}

async function tryLocal(
	url: URL,
	render: 'auto' | 'local',
	signal: AbortSignal | undefined,
	sectionCap: number,
	maxChars: number,
	validators?: { etag?: string; lastModified?: string },
): Promise<(ScrapeResult & { validators?: { etag?: string; lastModified?: string } }) | undefined | 'not-modified'> {
	const cond = await localFetch(url, signal, validators);
	if (cond.notModified) return 'not-modified';
	const { body, contentType } = cond;
	let title = '';
	let text: string;
	let publishedAt: string | undefined;
	let paywalled = false;
	if (isRawText(contentType)) {
		text = stripToAscii(decodeHtmlEntities(body));
	} else {
		const extracted = extractHtml(body);
		title = extracted.title;
		text = extracted.text;
		publishedAt = extracted.publishedAt;
		paywalled = extracted.paywalled;
	}
	const { outline, sections, continued } = sliceSections(text, sectionCap, title);
	const { text: out, truncated } = joinSections(outline, sections, maxChars);
	if (render === 'auto' && text.length < LOCAL_MIN_TEXT) return undefined;
	if (render === 'auto' && (sections.length === 0 || out.length < LOCAL_MIN_OUTPUT || isLowQualityOutput(out))) {
		return undefined;
	}
	return {
		url: url.toString(),
		title,
		renderer: 'local',
		outline,
		sections,
		continued,
		text: out,
		truncated,
		publishedAt,
		paywalled: paywalled || undefined,
		validators: cond.validators,
	};
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
	const { outline, sections, continued } = sliceSections(markdown, sectionCap);
	const { text, truncated } = joinSections(outline, sections, maxChars);
	return { url: url.toString(), title, renderer: doc.renderer, outline, sections, continued, text, truncated };
}

const BOILERPLATE_HEADING =
	/^(?:site |main |global |primary )?(?:navigation(?: menu| bar| links)?|menu|sidebar|footer|header|contents?|related topics|quick search|site index|breadcrumbs?|personal tools|namespaces|views|user links|wiki tools|languages|repository navigation|in other(?: languages| projects)|print\/export|navigation menu)$/i;

function isBoilerplateHeading(name: string): boolean {
	return BOILERPLATE_HEADING.test(name.trim());
}

// Archive fallback for DEAD pages only (doctrine line): 404/dead-host, never
// 403-walls. Resurrecting lost content is a service; bypassing walls is not.
async function archivedFetch(
	url: URL,
	signal: AbortSignal | undefined,
	sectionCap: number,
	maxChars: number,
): Promise<ScrapeResult | undefined> {
	if (signal?.aborted) return undefined;
	if (isPrivateHost(url.hostname)) return undefined;
	try {
		const { ctrl, done } = withTimeout('archive lookup', 10_000, signal);
		let snapshotUrl: string | undefined;
		try {
			const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url.toString())}`, {
				signal: ctrl.signal,
				headers: { Accept: 'application/json' },
			});
			if (res.ok) {
				const d = (await res.json()) as {
					archived_snapshots?: { closest?: { url?: string; status?: string; timestamp?: string } };
				};
				const snap = d.archived_snapshots?.closest;
				if (snap?.url && snap.status === '200') snapshotUrl = snap.url;
				var snapTs = snap?.timestamp;
			}
		} finally {
			done();
		}
		if (!snapshotUrl || signal?.aborted) return undefined;
		const { body, contentType } = await localFetch(new URL(snapshotUrl), signal);
		if (!/html|text/.test(contentType)) return undefined;
		const extracted = extractHtml(body);
		if (extracted.text.length < LOCAL_MIN_TEXT) return undefined;
		const { outline, sections, continued } = sliceSections(extracted.text, sectionCap, extracted.title);
		const { text: out, truncated } = joinSections(outline, sections, maxChars);
		if (!out) return undefined;
		const snapDate =
			typeof snapTs === 'string' && snapTs.length >= 8
				? `${snapTs.slice(0, 4)}-${snapTs.slice(4, 6)}-${snapTs.slice(6, 8)}`
				: 'unknown date';
		return {
			url: url.toString(),
			title: `${extracted.title || url.hostname} [ARCHIVED copy ${snapDate} — live page is gone]`,
			renderer: 'local',
			outline,
			sections,
			continued,
			text: out,
			truncated,
			publishedAt: extracted.publishedAt,
		};
	} catch {
		return undefined;
	}
}

export async function scrape(urlRaw: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
	const cfg = getConfig();
	const url = validateUrl(urlRaw, opts.allowPrivate ?? cfg.allowPrivate);
	const sectionCap = opts.sectionCap ?? DEFAULT_SECTION_CAP;
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const render = opts.render ?? 'auto';

	if (opts.signal?.aborted) return abortResult(url);

	if (render === 'auto' || render === 'local') {
		const readme = await scrapeReadme(url, opts, sectionCap, maxChars);
		if (readme) return readme;
	}

	if (render === 'local') {
		try {
			const forced = await tryLocal(url, 'local', opts.signal, sectionCap, maxChars, opts.validators);
			if (forced === 'not-modified') return { ...abortResult(url), error: 'not-modified', renderer: 'local' };
			return forced!;
		} catch (e) {
			return opts.signal?.aborted ? abortResult(url) : errorResult(url, sanitizeError(e));
		}
	}

	const usable = (markdown: string): boolean => {
		if (markdown.replace(/\s+/g, '').length < 100) return false;
		const { sections } = sliceSections(markdown, DEFAULT_SECTION_CAP);
		return sections.length > 0;
	};

	const isJinaProxy = url.hostname === 'r.jina.ai' || url.hostname === 's.jina.ai';

	if (render === 'auto') {
		let local: (ScrapeResult & { validators?: { etag?: string; lastModified?: string } }) | undefined | 'not-modified';
		let localErr: string | undefined;
		try {
			local = await tryLocal(url, 'auto', opts.signal, sectionCap, maxChars, opts.validators);
		} catch (e) {
			if (opts.signal?.aborted) return abortResult(url);
			localErr = sanitizeError(e);
		}
		if (local === 'not-modified') {
			return { ...abortResult(url), error: 'not-modified', renderer: 'local' };
		}
		if (local) return local;
		if (localErr && /HTTP 404|not a readable page|page too large|empty body/.test(localErr)) {
			if (/HTTP 404/.test(localErr)) {
				const archived = await archivedFetch(url, opts.signal, sectionCap, maxChars);
				if (archived) return archived;
			}
			return errorResult(url, localErr);
		}
		if (isJinaProxy) {
			return errorResult(
				url,
				localErr
					? `${localErr} (jina proxy; target walled or unavailable)`
					: 'jina reader returned no usable content for the target (walled or unavailable)',
			);
		}
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
