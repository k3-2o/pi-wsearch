import type { FusedHit } from './fuse';
import { hostOf } from './urls';

const SNIPPET_MAX = 240;
const CHAPTER_TITLE_MAX = 100;
const TOC_TITLE_MAX = 60;
const ERROR_SNIP = 40;
const DEFAULT_WRAP = 100;
const MAX_WRAP = 240;

export const READ_FIRST_TAG = ' · recommended first read';

interface ErroredEngine {
	engine: string;
	error: string;
}

export interface SearchViewOpts {
	wrap?: number;
}

export interface SearchView {
	query: string;
	hits: FusedHit[];
	enginesUsed: string[];
	errored: ErroredEngine[];
	fatal?: { engine: string; error: string };
	retryNote?: string;
}

function fmtSnippet(s: string, max: number): string {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max) + '…' : t;
}

function cleanSnippet(s: string): string {
	return s
		.replace(/\\(.)/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\[\[\d+\]\]\([^)]*\)\)?/g, '')
		.replace(/\[\[\d+\]\]/g, '')
		.replace(/\(https?:\/\/[^)]*\)/g, ' ')
		.replace(/#{2,6}\s+/g, '')
		.replace(/\|/g, ' ')
		.replace(/(^|\s)-+(?=\s|$)/g, '$1')
		.replace(/(^|[()?!:;])\s?\d{1,2}:\d{2}\s+/g, '$1 ')
		.replace(/\(\s*\)/g, '')
		.replace(/\((?=[0-9+\-–·\s]*[+\-–·])[0-9+\-–·\s]*\)/g, ' ')
		.replace(/\d{1,4}[KM]?\s*•\s*\d{1,4}(?:mo|d|w|y|h)\s+ago/gi, ' ')
		.replace(/\s+([?:!;])/g, '$1')
		.replace(/(^|\s)([*]{1,3}|_{1,2}|`)(\S(?:[^*`_]*\S)?)\2(?=\s|$|[.,;:!?)]|\b)/g, '$1$3')
		.replace(/\s+/g, ' ')
		.trim();
}

function stripSiteSuffix(title: string, host: string): string {
	const m = /^(.{3,})\s+[|–—-]\s+([^|–—-]{2,40})$/.exec(title.trim());
	if (!m) return title;
	const suffix = m[2].trim();
	const head = m[1].trim();
	const hostBase = host.replace(/^www\./, '').split('.')[0];
	if (host && suffix.toLowerCase().includes(hostBase)) return head;
	if (suffix.length <= 25 && !/\s/.test(suffix)) return head;
	return title;
}

function normalizeHitDate(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const t = Date.parse(raw);
	if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
	const rel = /^(\d+)\s*(m|min|minute|minutes|h|hour|hours|d|day|days|w|week|weeks|mo|month|months)\b/i.exec(
		raw.trim(),
	);
	if (rel) {
		const n = parseInt(rel[1], 10);
		const unit = rel[2].toLowerCase();
		const ms = unit.startsWith('h')
			? 3_600_000
			: unit.startsWith('mo')
				? 2_592_000_000
				: unit.startsWith('m')
					? 60_000
					: unit.startsWith('d')
						? 86_400_000
						: 604_800_000;
		return new Date(Date.now() - n * ms).toISOString().slice(0, 10);
	}
	if (/^yesterday$/i.test(raw.trim())) return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	return undefined;
}

function formatEvidence(r: FusedHit): string {
	if (!r.engineRanks?.length) return r.engines.length > 1 ? ` ← ${r.engines.length} engines` : '';
	if (r.engineRanks.length === 1) return ` ⇐ ${r.engineRanks[0].engine} only (single-engine: unverified)`;
	const shown = r.engineRanks
		.slice(0, 6)
		.map((e) => `${e.engine}#${e.rank}`)
		.join(', ');
	const rest = r.engineRanks.length > 6 ? `, +${r.engineRanks.length - 6} more` : '';
	return ` ⇐ ${shown}${rest}`;
}

function cleanTitle(s: string, host: string): string {
	return stripSiteSuffix(cleanSnippet(s), host).replace(/\s+[—–]\s+/g, ': ');
}

function tocTitle(r: FusedHit): string {
	return fmtSnippet(cleanTitle(r.title, hostOf(r.url)), TOC_TITLE_MAX) || fmtSnippet(r.url, TOC_TITLE_MAX);
}

function chapterTitle(r: FusedHit): string {
	return fmtSnippet(cleanTitle(r.title, hostOf(r.url)), CHAPTER_TITLE_MAX) || r.url;
}

function compactWarn(e: ErroredEngine): string {
	const status = /HTTP\s+(\d{3})/i.exec(e.error)?.[1];
	return status ? `${status}: ${e.engine}` : `${e.engine}: ${e.error.slice(0, ERROR_SNIP)}`;
}

export function buildSearchText(v: SearchView, opts: SearchViewOpts = {}): string {
	const count = v.hits.length;
	const width = Math.max(40, Math.min(MAX_WRAP, opts.wrap ?? DEFAULT_WRAP));
	const engineWord = v.enginesUsed.length === 1 ? 'engine' : 'engines';
	if (!count) {
		return v.fatal ? `No results: ${v.fatal.error}\n` : `No results. Broaden the query.\n`;
	}
	let text = `${v.enginesUsed.length} ${engineWord} [${v.enginesUsed.join(', ')}]`;
	if (v.retryNote) text += ` · ${v.retryNote}`;
	const warns = v.errored.map(compactWarn);
	if (warns.length) text += ` ⚠ ${warns.join(' · ')}`;
	text += '\n';
	const rows = v.hits.map((r, i) => {
		const host = hostOf(r.url);
		return `${String(i + 1).padStart(2)}. ${tocTitle(r)}${host ? ` · ${host}` : ''}`;
	});
	text += `\n${rows.join('\n')}\n`;
	v.hits.forEach((r, i) => {
		const title = chapterTitle(r);
		const snippet = fmtSnippet(cleanSnippet(r.snippet), SNIPPET_MAX);
		const via = formatEvidence(r).trim();
		const when = normalizeHitDate(r.date);
		let meta = r.url;
		if (when) meta += ` · ${when}`;
		if (via) meta += ` ${via}`;
		text += `\n## ${i + 1}. ${title}${i === 0 && count > 1 ? READ_FIRST_TAG : ''}\n`;
		text += `   ${meta}\n`;
		if (snippet) text += `   ${snippet}\n`;
	});
	return wrapAll(text, width);
}

export function wrapAll(text: string, width: number): string {
	return text
		.split('\n')
		.map((l) => wrapLine(l, width))
		.join('\n');
}

function wrapLine(line: string, width: number): string {
	if (line.length <= width) return line;
	const hasTag = line.endsWith(READ_FIRST_TAG);
	const body = hasTag ? line.slice(0, line.length - READ_FIRST_TAG.length) : line;
	const m = /^(##\s*\d+\.\s+|\s*\d+\.\s+|\s*)/.exec(body);
	const head = m?.[1] ?? '';
	const indent = head.replace(/\S/g, ' ');
	const words = body.slice(head.length).split(' ');
	const limit = width - indent.length;
	const out: string[] = [];
	let cur = '';
	for (const word of words) {
		if (!word) continue;
		const fits = cur ? cur.length + 1 + word.length <= limit : word.length <= limit;
		if (fits) {
			cur = cur ? `${cur} ${word}` : word;
			continue;
		}
		if (cur) {
			out.push(cur);
			cur = '';
		}
		if (word.length > limit) {
			for (const chunk of breakToken(word, limit)) {
				if (cur) {
					out.push(cur);
					cur = '';
				}
				cur = chunk;
			}
		} else {
			cur = word;
		}
	}
	if (cur) out.push(cur);
	const lines = out.map((l, i) => (i ? indent + l : head + l));
	if (hasTag) {
		const last = lines.length - 1;
		if (last >= 0 && lines[last].length + READ_FIRST_TAG.length <= width) {
			lines[last] += READ_FIRST_TAG;
		} else {
			lines.push(indent + READ_FIRST_TAG.trimStart());
		}
	}
	return lines.join('\n');
}

function breakToken(token: string, limit: number): string[] {
	const out: string[] = [];
	let from = 0;
	while (token.length - from > limit) {
		let cut = from + limit;
		for (let i = cut - 1; i > from; i--) {
			if (i < token.length && /[/\-_.?=&]/.test(token[i])) {
				cut = i + 1;
				break;
			}
		}
		out.push(token.slice(from, cut));
		from = cut;
	}
	out.push(token.slice(from));
	return out;
}
