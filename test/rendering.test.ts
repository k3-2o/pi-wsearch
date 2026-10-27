/**
 * Rendering contract for the collapse-dimming feature (spec: .agents/specs/collapse-dimming).
 * When a tool call is COLLAPSED every tool-output content line renders dim; EXPANDED output
 * keeps its existing per-line coloring. Truncation geometry and hint behavior are untouched.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { registerWebTools } from '../src/tools';
import { buildSearchText } from '../src/view';

beforeAll(() => initTheme());

// Real SGR so the markers survive pi-tui Text's ANSI-aware re-wrapping.
const DIM = '\u001b[2m';
const ACCENT = '\u001b[31m';
const WARNING = '\u001b[33m';
const TOOLOUTPUT = '\u001b[96m';
const reset = '\u001b[0m';
const esc = (n: number, s: string) => `\u001b[${n}m${s}${reset}`;
/** Fake theme: distinct real SGR per style key. */
const SIZE: Record<string, number> = { dim: 2, accent: 31, muted: 90, warning: 33, toolOutput: 96 };
/** Fake theme: distinct real SGR per style key. */
const theme = {
	fg: (code: string, s: string) => (code in SIZE ? esc(SIZE[code]!, s) : s),
	bold: (s: string) => esc(1, s),
	italic: (s: string) => esc(3, s),
} as never;

type CompiledTool = {
	name: string;
	renderResult: (
		result: { content: { type: string; text?: string }[] },
		options: { expanded: boolean },
		th: never,
	) => {
		render(width: number): string[];
	};
};

function tools(): Record<string, CompiledTool> {
	const regs: CompiledTool[] = [];
	const stub = { registerTool: (t: CompiledTool) => void regs.push(t) } as never;
	registerWebTools(stub);
	return Object.fromEntries(regs.map((t) => [t.name, t]));
}

const render = (t: CompiledTool, text: string, expanded: boolean, width = 60): string[] =>
	(
		t.renderResult({ content: [{ type: 'text', text }] }, { expanded }, theme) as { render(w: number): string[] }
	).render(width);

/** Strip SGR (and any fake markers) back to plain text. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string): string => s.replace(ANSI, '');

/** content = every line except the expand hint (… N more lines). */
function contentLines(lines: string[]): string[] {
	return lines.filter((l) => !l.includes('more lines'));
}
function isHint(l: string): boolean {
	return l.includes('more lines');
}
function allDim(lines: string[]): boolean {
	return lines.every((l) => l.includes(DIM));
}
function anyContain(lines: string[], token: string): boolean {
	return lines.some((l) => l.includes(token));
}

describe('collapse-dimming: WebSearch', () => {
	const { WebSearch } = tools();

	test('collapsed truncated output renders every shown line dim, no accent/warning/default', () => {
		const raw = buildSearchText(
			{
				query: 'nodejs lts',
				hits: Array.from({ length: 6 }, (_, i) => ({
					title: `Result ${i + 1} — a fairly long title that wraps at this width`,
					url: `https://example.com/${i + 1}/long/path`,
					snippet: 'a snippet long enough to wrap across many lines of tool output text body',
					engine: 'serper',
					engines: ['serper', 'exa'],
					engineRanks: [
						{ engine: 'serper', rank: i + 1 },
						{ engine: 'exa', rank: 3 },
					],
					rrfScore: 0,
					finalScore: 1,
					junk: false,
				})),
				enginesUsed: ['serper', 'exa'],
				errored: [],
				fatal: undefined,
			},
			{ wrap: 60 },
		);
		const lines = render(WebSearch, raw, false);
		const content = contentLines(lines);
		expect(content.length).toBeGreaterThan(0);
		// Truncated: there is a hint, and every content line shown is dim.
		expect(lines.some(isHint)).toBe(true);
		expect(allDim(content)).toBe(true);
		expect(anyContain(content, ACCENT)).toBe(false);
		expect(anyContain(content, WARNING)).toBe(false);
	});

	test('collapsed output that already fits the preview window is still all dim', () => {
		const raw = buildSearchText(
			{
				query: 'q',
				hits: [
					{
						title: 'T1',
						url: 'https://ex.com/1',
						snippet: 'short',
						engine: 'serper',
						engines: ['serper'],
						engineRanks: [{ engine: 'serper', rank: 1 }],
						rrfScore: 0,
						finalScore: 1,
						junk: false,
					},
				],
				enginesUsed: ['serper'],
				errored: [],
				fatal: undefined,
			},
			{ wrap: 200 },
		);
		const lines = render(WebSearch, raw, false, 200);
		const content = contentLines(lines); // auto-fills to full content, still folded
		expect(allDim(content)).toBe(true);
		expect(anyContain(content, ACCENT)).toBe(false);
	});

	test('collapsed output dims the truncation marker line, not warning', () => {
		const raw = `# Title\n## 1. A chapter\nsome body\n\n…[truncated]\n\n## 2. Next\nmore body`;
		const lines = render(WebSearch, raw, false, 40);
		const marker = contentLines(lines).find((l) => l.includes('…[truncated]'));
		expect(marker).toBeDefined();
		expect(marker!.includes(DIM)).toBe(true);
		expect(marker!.includes(WARNING)).toBe(false);
	});

	test('expanded output keeps full per-line coloring (chapter accent, tag bold, index dim, meta default)', () => {
		const raw = buildSearchText(
			{
				query: 'nodejs lts',
				hits: [
					{
						title: 'ChapterOne long title',
						url: 'https://example.com/1',
						snippet: 'snippet body',
						engine: 'serper',
						engines: ['serper', 'exa'],
						engineRanks: [
							{ engine: 'serper', rank: 1 },
							{ engine: 'exa', rank: 2 },
						],
						rrfScore: 0,
						finalScore: 1,
						junk: false,
					},
					{
						title: 'ChapterTwo',
						url: 'https://example.com/2',
						snippet: 'more body',
						engine: 'serper',
						engines: ['serper'],
						engineRanks: [{ engine: 'serper', rank: 2 }],
						rrfScore: 0,
						finalScore: 1,
						junk: false,
					},
				],
				enginesUsed: ['serper', 'exa'],
				errored: [],
				fatal: undefined,
			},
			{ wrap: 60 },
		);
		const lines = render(WebSearch, raw, true);
		const content = contentLines(lines);
		// a ## chapter header renders accent
		expect(content.some((l) => strip(l).startsWith('## ') && l.includes(ACCENT))).toBe(true);
		// a TOC index row renders dim (existing behavior, preserved)
		expect(content.some((l) => /^\s*\d+\. /.test(strip(l)) && !l.startsWith('##') && l.includes(DIM))).toBe(true);
		// NOT all dim: an accent chapter line is genuinely full color, not the collapsed preview
		expect(content.some((l) => !l.includes(DIM))).toBe(true);
	});
});

describe('collapse-dimming: WebFetch', () => {
	const { WebFetch } = tools();

	test('collapsed output renders every shown content line dim, no toolOutput/accent', () => {
		const raw = [
			'# Page Title',
			'indices - 0 - 4 sections',
			'- *0* Intro section heading',
			'## [0] Intro section heading',
			'some body text that is reasonably long so it wraps across the preview lines area here',
			'',
			'## [1] Another heading',
			'more body content for the second section to fill preview space',
		].join('\n');
		const lines = render(WebFetch, raw, false, 60);
		const content = contentLines(lines);
		expect(anyContain(content, TOOLOUTPUT)).toBe(false);
		expect(anyContain(content, ACCENT)).toBe(false);
		expect(allDim(content)).toBe(true);
	});

	test('expanded output keeps colorizedResult styling (accent headings, italic outline indices)', () => {
		const raw = [
			'# Page Title',
			'indices - 0 - 1 sections',
			'- *0* Intro section heading',
			'## [0] Intro section heading',
			'some body text',
		].join('\n');
		const lines = render(WebFetch, raw, true, 60);
		expect(anyContain(lines, ACCENT)).toBe(true); // ## [n] heading accent
		expect(anyContain(lines, DIM)).toBe(true); // - *n* index dim per colorLine
		expect(lines.some((l) => l.includes('\u001b[3m'))).toBe(true); // outline index italic
	});
});
