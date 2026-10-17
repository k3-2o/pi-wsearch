import { describe, expect, test } from 'bun:test';
import { buildSearchText } from '../src/view';
import type { FusedHit } from '../src/fuse';

function hit(url: string, title: string, over: Partial<FusedHit> = {}): FusedHit {
	return {
		url,
		title,
		snippet: 'snippet text',
		engine: 'serper',
		engines: ['serper'],
		engineRanks: [],
		rrfScore: 0,
		finalScore: 0,
		junk: false,
		...over,
	};
}

describe('buildSearchText layout', () => {
	test('lean header, TOC, then chapters — in that order', () => {
		const text = buildSearchText({
			query: 'tokio',
			hits: [
				hit('https://tokio.rs/', 'Tokio — An async runtime for Rust', {
					snippet: 'Event-driven, non-blocking I/O platform.',
					engines: ['serper', 'exa'],
					engineRanks: [
						{ engine: 'serper', rank: 1 },
						{ engine: 'exa', rank: 2 },
					],
				}),
				hit('https://async-rs.github.io/async-std/', 'async-std — A robust async runtime', {
					date: '3 days ago',
				}),
			],
			enginesUsed: ['serper', 'exa'],
			errored: [],
		});
		expect(text.split('\n')[0]).toBe('2 engines [serper, exa]');
		expect(text).not.toContain('"');
		expect(text).not.toContain('—');
		expect(text).not.toContain('–');
		expect(text).toContain('\n 1. Tokio: An async runtime for Rust · tokio.rs');
		expect(text).toContain('\n 2. async-std: A robust async runtime · async-rs.github.io');
		const toc1 = text.indexOf('\n 1. ');
		const toc2 = text.indexOf('\n 2. ');
		const ch1 = text.indexOf('\n## 1. ');
		const ch2 = text.indexOf('\n## 2. ');
		expect(ch1).toBeGreaterThan(toc2);
		expect(ch2).toBeGreaterThan(ch1);
		expect(toc1).toBeGreaterThan(-1);
		expect(toc1).toBeLessThan(toc2);
		expect(text).toContain(
			'\n## 1. Tokio: An async runtime for Rust · recommended first read\n   https://tokio.rs/ ⇐ serper#1, exa#2\n',
		);
		expect(text).toContain('\n## 2. async-std: A robust async runtime\n   https://async-rs.github.io/async-std/ · ');
		expect(text).toContain('   Event-driven, non-blocking I/O platform.\n');
	});

	test('relative date normalizes to ISO day', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A', { date: '3 days ago' })],
			enginesUsed: ['a'],
			errored: [],
		});
		const want = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
		expect(text).toContain(` · ${want}`);
	});

	test('two-digit ranks keep the column aligned', () => {
		const hits = Array.from({ length: 12 }, (_, i) => hit(`https://h${i}.example/p`, `Headline ${i + 1}`));
		const text = buildSearchText({ query: 'q', hits, enginesUsed: ['a'], errored: [] });
		expect(text).toContain('\n 9. Headline 9 · h8.example');
		expect(text).toContain('\n12. Headline 12 · h11.example');
	});

	test('engine failures warn inline with an extracted status', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A')],
			enginesUsed: ['a', 'b'],
			errored: [{ engine: 'tavily', error: 'HTTP 432: {"detail":{"error":"This request exceeds your plan' }],
		});
		expect(text.split('\n')[0]).toBe('2 engines [a, b] ⚠ 432: tavily');
	});

	test('engine failure without a status falls back to engine: message', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A')],
			enginesUsed: ['a', 'b'],
			errored: [{ engine: 'b', error: '401 invalid key (long tail that gets cut)' }],
		});
		const head = text.split('\n')[0];
		expect(head.startsWith('2 engines [a, b] ⚠ b: 401 invalid key')).toBe(true);
	});

	test('multiple failures stay on one readable line', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A')],
			enginesUsed: ['a'],
			errored: [
				{ engine: 'tavily', error: 'HTTP 432: nope' },
				{ engine: 'serper', error: 'HTTP 401: nope' },
			],
		});
		expect(text.split('\n')[0]).toBe('1 engine [a] ⚠ 432: tavily · 401: serper');
	});

	test('retry note sits on the header with a middle dot', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A')],
			enginesUsed: ['a'],
			errored: [],
			retryNote: 'retried as "p"',
		});
		expect(text.startsWith('1 engine [a] · retried as "p"')).toBe(true);
	});

	test('no results: fatal error vs broaden-the-query', () => {
		const fatal = buildSearchText({
			query: 'q',
			hits: [],
			enginesUsed: [],
			errored: [],
			fatal: { engine: 'none', error: 'all providers down' },
		});
		expect(fatal).toBe('No results: all providers down\n');
		const broad = buildSearchText({ query: 'q', hits: [], enginesUsed: [], errored: [] });
		expect(broad).toBe('No results. Broaden the query.\n');
	});

	test('TOC title caps tighter than chapter titles', () => {
		const longTitle = 'R'.repeat(200);
		const text = buildSearchText(
			{
				query: 'q',
				hits: [hit('https://a.example/', longTitle)],
				enginesUsed: ['a'],
				errored: [],
			},
			{ wrap: 76 },
		);
		const tocLine = text.split('\n').find((l) => l.startsWith(' 1. '))!;
		expect(tocLine.length).toBeLessThan(80);
		expect(text).toContain(`\n## 1. ${'R'.repeat(70)}\n`);
	});

	test('long lines wrap with a hanging indent at the given width', () => {
		const longSnippet = `word${' long'.repeat(60)}`;
		const longUrl = `https://example.com/${'a/'.repeat(45)}tail`;
		const text = buildSearchText(
			{
				query: 'q',
				hits: [hit(longUrl, 'T'.repeat(100), { snippet: longSnippet })],
				enginesUsed: ['a'],
				errored: [],
			},
			{ wrap: 76 },
		);
		for (const l of text.split('\n')) expect(l.length).toBeLessThanOrEqual(76);
		expect(text).toContain('\n   word long long');
		expect(text).toMatch(/\n   https:\/\/example\.com\//);
	});

	test('wide wrap width lets long lines flow instead of boxing', () => {
		const longSnippet = 'word long '.repeat(15);
		const text = buildSearchText(
			{
				query: 'q',
				hits: [hit('https://a.example/', 'A', { snippet: longSnippet })],
				enginesUsed: ['a'],
				errored: [],
			},
			{ wrap: 300 },
		);
		const lines = text.split('\n');
		expect(lines.some((l) => l.length > 140)).toBe(true);
		expect(text).toContain('   word long word long word long');
	});

	test('tag sits on the first chapter, not the index rows', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A'), hit('https://b.example/', 'B')],
			enginesUsed: ['a'],
			errored: [],
		});
		expect(text).toContain('\n 1. A · a.example\n');
		expect(text).toContain('\n## 1. A · recommended first read\n');
		expect(text).toContain('\n## 2. B\n');
		const solo = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A')],
			enginesUsed: ['a'],
			errored: [],
		});
		expect(solo).not.toContain('recommended first read');
	});

	test('the recommended tag stays atomic when the first chapter wraps', () => {
		const text = buildSearchText(
			{
				query: 'q',
				hits: [hit('https://a.example/', 'T '.repeat(40)), hit('https://b.example/', 'B')],
				enginesUsed: ['a'],
				errored: [],
			},
			{ wrap: 60 },
		);
		for (const l of text.split('\n')) {
			if (l.includes('recommended first read')) expect(l).toMatch(/· recommended first read$/);
		}
	});

	test('single-engine evidence is labelled unverified', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [hit('https://a.example/', 'A', { engineRanks: [{ engine: 'exa', rank: 3 }] })],
			enginesUsed: ['exa'],
			errored: [],
		});
		expect(text).toContain('⇐ exa only (single-engine: unverified)');
	});

	test('unparseable URL: no dangling separator', () => {
		const text = buildSearchText({ query: 'q', hits: [hit('not a url', 'Weird')], enginesUsed: ['a'], errored: [] });
		expect(text).toContain('\n 1. Weird\n');
		expect(text).not.toContain(' · ');
	});

	test('snippet junk is scrubbed: escapes, headings, pipes, timecodes, counts', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [
				hit('https://a.example/', 'A', {
					snippet: '## Oh-My-Pi: Harness?! 32:39\\ Live ()Mix (50+) | Dev | 30K • 1mo ago',
				}),
			],
			enginesUsed: ['a'],
			errored: [],
		});
		expect(text).not.toContain('\\');
		expect(text).not.toContain('32:39');
		expect(text).not.toContain('(50+)');
		expect(text).not.toContain('•');
		expect(text).not.toContain('|');
		expect(text).not.toContain('\n   ##');
		expect(text).toContain('Harness?! Live Mix Dev');
	});

	test('titles lose space-before-punctuation and wiki citation links', () => {
		const text = buildSearchText({
			query: 'q',
			hits: [
				hit('https://en.wikipedia.org/wiki/Pi_(AI_agent)', 'Pi (AI agent)', {
					snippet: '| Pi | |-| | Written in | TypeScript | [[11]](https://en.wikipedia.org/wiki/Pi_(AI_agent))',
				}),
				hit('https://reddit.com/r/x', 'Any thoughts about oh-my-pi coding agent ? : r/OnlyAICoding'),
			],
			enginesUsed: ['a'],
			errored: [],
		});
		expect(text).toContain('\n## 2. Any thoughts about oh-my-pi coding agent?: r/OnlyAICoding\n');
		expect(text).toContain('Pi Written in TypeScript');
		expect(text).not.toContain('[[11]]');
	});
});
