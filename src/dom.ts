import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { parseDocument } from 'htmlparser2';

interface DomNode {
	type: string;
	name?: string;
	attribs?: Record<string, string>;
	data?: string;
	children?: DomNode[];
}

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'aside', 'head', 'title']);

const BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'pre']);

function isKatex(n: DomNode): boolean {
	return (n.attribs?.['class'] ?? '').split(/\s+/).includes('katex');
}

function toDom(html: string): DomNode {
	return parse(html, { treeAdapter: adapter }) as unknown as DomNode;
}

function inlineOf(n: DomNode): string {
	const t = n.type;
	if (t === 'text') return n.data ?? '';
	if (t === 'comment' || t === 'directive') return '';
	const name = n.name ?? '';
	if (!name || SKIP.has(name) || isKatex(n)) return '';
	if (name === 'math') {
		const tex = annotationTex(n);
		return tex ? `$${tex}$` : '';
	}
	if (name === 'br' || name === 'hr' || name === 'li') return ' ';
	return (n.children ?? []).map(inlineOf).join('');
}

function annotationTex(n: DomNode): string | undefined {
	const found: DomNode[] = [];
	allDescendants(n, 'annotation', found);
	for (const c of found) {
		const enc = (c.attribs?.['encoding'] ?? '').toLowerCase();
		if (enc === 'application/x-tex' || enc.includes('x-tex')) return inlineOf(c).trim();
	}
	return undefined;
}

function allDescendants(n: DomNode, name: string, out: DomNode[]): void {
	for (const c of n.children ?? []) {
		if (c.type === 'tag') {
			if (c.name === name) out.push(c);
			allDescendants(c, name, out);
		}
	}
}

function listText(n: DomNode, out: string[]): void {
	for (const c of n.children ?? []) {
		if (c.type === 'tag' && c.name === 'li') {
			newline(out);
			out.push('• ');
			liText(c, out);
		}
	}
}

function liText(n: DomNode, out: string[]): void {
	for (const c of n.children ?? []) {
		const t = c.type;
		if (t === 'text') {
			out.push((c.data ?? '').replace(/\s+/g, ' '));
			continue;
		}
		if (t === 'comment' || t === 'directive') continue;
		const name = c.name ?? '';
		if (SKIP.has(name) || isKatex(c)) continue;
		if (name === 'li') {
			newline(out);
			out.push('• ');
			liText(c, out);
			continue;
		}
		if (name === 'ul' || name === 'ol') {
			listText(c, out);
			continue;
		}
		if (name === 'br' || name === 'hr') {
			out.push('\n');
			continue;
		}
		if (name === 'pre') {
			out.push('\n');
			out.push(inlineOf(c).replace(/\n/g, '\uE000'));
			continue;
		}
		if (name === 'math') {
			const tex = annotationTex(c);
			if (tex) out.push(`$${tex}$`);
			continue;
		}
		if (BLOCK.has(name) || name === 'table') {
			newline(out);
			liText(c, out);
			continue;
		}
		out.push(inlineOf(c));
	}
}

function renderTable(n: DomNode, out: string[]): void {
	const rows: string[][] = [];
	for (const tr of (() => {
		const found: DomNode[] = [];
		allDescendants(n, 'tr', found);
		return found;
	})()) {
		const cells: string[] = [];
		for (const cell of tr.children ?? []) {
			if (cell.type === 'tag' && (cell.name === 'td' || cell.name === 'th')) {
				cells.push(inlineOf(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
			}
		}
		if (cells.length) rows.push(cells);
	}
	newline(out);
	if (rows.length < 2 || Math.max(...rows.map((r) => r.length)) < 2) {
		out.push(rows.map((r) => r.join(' ')).join('\n'));
		out.push('\n');
		return;
	}
	const cols = Math.max(...rows.map((r) => r.length));
	const line = (r: string[]) => `| ${r.concat(Array(Math.max(0, cols - r.length)).fill(' ')).join(' | ')} |`;
	out.push(
		[line(rows[0]), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join(
			'\n',
		),
	);
	out.push('\n');
}

function newline(out: string[]): void {
	if (out.length > 0 && !out[out.length - 1].endsWith('\n')) out.push('\n');
}

export function treeToMarkdownish(html: string): string {
	const doc = toDom(html);
	const out: string[] = [];
	renderBlocks(doc.children ?? [], out);
	return out.join('');
}

function renderBlocks(nodes: DomNode[], out: string[]): void {
	for (const n of nodes) renderBlock(n, out);
}

function renderBlock(n: DomNode, out: string[]): void {
	const t = n.type;
	if (t === 'text') {
		out.push(n.data ?? '');
		return;
	}
	if (t === 'comment' || t === 'directive' || t === 'style' || t === 'script') return;
	const name = n.name ?? '';
	if (!name || SKIP.has(name) || isKatex(n)) return;
	switch (name) {
		case 'h1':
		case 'h2':
		case 'h3':
		case 'h4':
		case 'h5':
		case 'h6':
			newline(out);
			out.push(`${'#'.repeat(Number(name[1]))} ${inlineOf(n).trim()}\n`);
			return;
		case 'li':
			newline(out);
			out.push('• ');
			liText(n, out);
			return;
		case 'ul':
		case 'ol':
			newline(out);
			listText(n, out);
			newline(out);
			return;
		case 'pre':
			newline(out);
			out.push(inlineOf(n).replace(/\n/g, '\uE000'));
			newline(out);
			return;
		case 'math': {
			const tex = annotationTex(n);
			if (tex) out.push(` $${tex}$ `);
			return;
		}
		case 'br':
		case 'hr':
			newline(out);
			return;
		case 'table':
			renderTable(n, out);
			return;
		case 'p':
		case 'div':
		case 'section':
		case 'article':
		case 'blockquote':
			newline(out);
			renderBlocks(n.children ?? [], out);
			newline(out);
			return;
		default:
			renderBlocks(n.children ?? [], out);
	}
}

const DATE_KEYWORDS = ['datePublished', 'dateCreated', 'uploadDate', 'publishedAt'];
const DATE_META_NAMES = [
	'article:published_time',
	'datePublished',
	'publish-date',
	'pubdate',
	'parsely-pub-date',
	'date',
];

function toIso(v: string | undefined): string | undefined {
	if (!v) return undefined;
	const ms = Date.parse(v.trim());
	if (Number.isNaN(ms) || ms < 0) return undefined;
	return new Date(ms).toISOString().slice(0, 10);
}

function jsonLdDate(nodes: DomNode[]): string | undefined {
	const pick = (value: unknown): string | undefined => {
		if (typeof value === 'string') {
			const iso = toIso(value);
			if (iso) return iso;
		}
		return undefined;
	};
	const walk = (value: unknown): string | undefined => {
		if (Array.isArray(value)) {
			for (const v of value) {
				const hit = walk(v);
				if (hit) return hit;
			}
			return undefined;
		}
		if (typeof value === 'object' && value !== null) {
			for (const key of DATE_KEYWORDS) {
				const hit = pick((value as Record<string, unknown>)[key]);
				if (hit) return hit;
			}
			for (const v of Object.values(value as Record<string, unknown>)) {
				const hit = walk(v);
				if (hit) return hit;
			}
		}
		return undefined;
	};
	const visit = (n: DomNode): string | undefined => {
		if (n.type === 'tag' && n.name === 'script') {
			const type = (n.attribs?.['type'] ?? '').toLowerCase().trim();
			if (type === 'application/ld+json' || type === 'application/json' || type === 'ld+json') {
				try {
					const hit = walk(JSON.parse(n.data ?? ''));
					if (hit) return hit;
				} catch {}
			}
		}
		for (const c of n.children ?? []) {
			const hit = visit(c);
			if (hit) return hit;
		}
		return undefined;
	};
	for (const n of nodes) {
		const hit = visit(n);
		if (hit) return hit;
	}
	return undefined;
}

export interface HeadScan {
	title: string;
	publishedAt?: string;
}

export function headScan(html: string): HeadScan {
	let doc: DomNode;
	try {
		doc = parseDocument(html) as unknown as DomNode;
	} catch {
		const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()?.slice(0, 200) ?? '';
		return { title };
	}
	const nodes = doc.children ?? [];
	let title = '';
	let ogTitle = '';
	let metaDate: string | undefined;
	let timeDate: string | undefined;

	const visit = (n: DomNode): void => {
		if (n.type !== 'tag') return;
		const name = n.name ?? '';
		const attribs = n.attribs ?? {};
		if (name === 'title' && !title) {
			title = (n.children ?? [])
				.filter((c) => c.type === 'text')
				.map((c) => c.data ?? '')
				.join('')
				.trim()
				.slice(0, 200);
		}
		if (name === 'meta') {
			const key = (attribs['property'] ?? attribs['name'] ?? '').toLowerCase().trim();
			if (!ogTitle && key === 'og:title') ogTitle = (attribs['content'] ?? '').trim().slice(0, 200);
			if (!metaDate && DATE_META_NAMES.includes(key)) metaDate = toIso(attribs['content']);
		}
		if (name === 'time' && !timeDate && attribs['datetime']) timeDate = toIso(attribs['datetime']);
		for (const c of n.children ?? []) visit(c);
	};
	for (const n of nodes) visit(n);

	return { title: title || ogTitle, publishedAt: jsonLdDate(nodes) ?? metaDate ?? timeDate };
}
