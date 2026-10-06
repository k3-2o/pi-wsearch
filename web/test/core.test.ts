/**
 * Core tests for web search Tier-1. Run with: bun test web/
 * Live engine tests run only when the keys are present in ~/.zshrc / env.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	getConfig,
	keyStatus,
	sanitizeError,
	parseEnvLine,
	parseEnvText,
	shellConfigFiles,
	resolveStoredValue,
	resetConfigCache,
	keyFilePath,
	keyOrigins,
	PROVIDERS,
} from '../src/config';
import { writeKey, removeKey, statusText } from '../src/keys';
import { cacheKey, openCache } from '../src/cache';
import { postJson, runEngines } from '../src/engines';
import { fuse, diversifyByHost, normalizeUrl, type FusedHit } from '../src/fuse';
import { decodeHtmlEntities, extractHtml, pageSlice, sliceSections, scrape, validateUrl } from '../src/scrape';

let server: Server;
let allowPrivate = false;

beforeAll(async () => {
	server = createServer((req, res) => {
		const u = new URL(req.url ?? '/', 'http://localhost');
		if (u.pathname === '/docs') {
			res.setHeader('content-type', 'text/html');
			res.end(
				`<!doctype html><html><head><title>Test Docs</title></head><body>
         <nav>nav junk nav junk nav junk</nav>
         <h1>Reciprocal Rank Fusion</h1>
         <p>RRF combines ranked lists from multiple retrieval systems by reciprocal rank scoring.</p>
         <h2>Formula</h2>
         <p>score(d) = sum over systems of 1/(k + rank).</p>
         <script>document.title = 'evil';</script>
         <style>.x{display:none}</style>
         <h2>Application</h2><p>Used in hybrid search fusion pipelines for coding agents.</p>
         </body></html>`,
			);
		} else if (u.pathname === '/thin') {
			res.setHeader('content-type', 'text/html');
			res.end('<html><body><h1>x</h1><p>minimum content to read</p></body></html>');
		} else if (u.pathname === '/slow') {
			// hangs until the abort (or 15s) kills it; used to test mid-flight abort
			const t = setTimeout(() => {
				if (!res.writableEnded) res.end('<html><body><h1>slow</h1></body></html>');
			}, 15_000);
			res.setHeader('content-type', 'text/html');
			res.on('close', () => clearTimeout(t));
		} else {
			res.statusCode = 404;
			res.end('not found');
		}
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	allowPrivate = true;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
});

const port = () => (server.address() as { port: number }).port;

describe('config / secrets', () => {
	test('key presence reported as booleans; loaded keys match env without printing', () => {
		const st = keyStatus();
		expect(typeof st.serper).toBe('boolean');
		const cfg = getConfig();
		// identity check: if env has the key, the config must have loaded exactly it
		for (const [envName, field] of [
			['SERPER_API_KEY', 'serperKey'],
			['TAVILY_API_KEY', 'tavilyKey'],
			['EXA_API_KEY', 'exaKey'],
			['FIRECRAWL_API_KEY', 'firecrawlKey'],
			['BRAVE_API_KEY', 'braveKey'],
			['JINA_API_KEY', 'jinaKey'],
			['KAGI_API_KEY', 'kagiKey'],
			['YDC_API_KEY', 'youKey'],
			['TINYFISH_API_KEY', 'tinyfishKey'],
		] as const) {
			const env = process.env[envName];
			if (env && env.length > 4) expect((cfg as any)[field]).toBe(env);
		}
		// serialized output surfaces no key values
		const serialized = JSON.stringify(st);
		expect(serialized).not.toMatch(/[A-Za-z0-9]{20,}/);
	});
	test('parseEnvLine handles bash/zsh, fish, and nushell syntax', () => {
		expect(parseEnvLine('export TAVILY_API_KEY=abc123')).toEqual(['TAVILY_API_KEY', 'abc123']);
		expect(parseEnvLine('TAVILY_API_KEY="abc123"')).toEqual(['TAVILY_API_KEY', 'abc123']);
		expect(parseEnvLine("EXA_API_KEY='def456'")).toEqual(['EXA_API_KEY', 'def456']);
		expect(parseEnvLine('set -gx KAGI_API_KEY ghi789')).toEqual(['KAGI_API_KEY', 'ghi789']);
		expect(parseEnvLine('$env.YDC_API_KEY = "jkl012"')).toEqual(['YDC_API_KEY', 'jkl012']);
		expect(parseEnvLine('# a comment')).toBeNull();
		expect(parseEnvLine('ls -la')).toBeNull();
	});
	test('parseEnvText merges and keeps the first occurrence', () => {
		const map = parseEnvText(['A=1', 'A=2', 'export B="x y"', 'set -gx C z'].join('\n'));
		expect(map).toEqual({ A: '1', B: 'x y', C: 'z' });
	});
	test('shellConfigFiles detects the real shell, never hardcodes zsh', () => {
		expect(shellConfigFiles('/usr/bin/bash')).toEqual(['.bashrc', '.bash_profile', '.profile']);
		expect(shellConfigFiles('/opt/homebrew/bin/fish')).toEqual(['.config/fish/config.fish']);
		expect(shellConfigFiles('/usr/bin/zsh')).toEqual(['.zshrc', '.zprofile']);
		expect(shellConfigFiles('/usr/bin/nushell')).toEqual(['.config/nushell/env.nu']);
		expect(shellConfigFiles('/bin/nu')).toEqual(['.config/nushell/env.nu']);
		expect(shellConfigFiles('/usr/bin/nope')).toEqual(['.bashrc', '.bash_profile', '.profile']);
		// no explicit shell → falls back to the current env's $SHELL
		expect(shellConfigFiles(undefined)).toEqual(shellConfigFiles(process.env.SHELL));
	});
	test('resolveStoredValue: plain values pass, !command runs once, failures stay unresolved', () => {
		expect(resolveStoredValue('abc12345')).toBe('abc12345');
		expect(resolveStoredValue('!echo -n abc123')).toBe('abc123');
		expect(resolveStoredValue('!false')).toBeUndefined();
		expect(resolveStoredValue('!')).toBeUndefined();
		expect(resolveStoredValue('abc')).toBeUndefined(); // too short to be a key
	});
	test('dedicated wsearch/env file is read when present', () => {
		process.env.WSEARCH_CACHE_DIR = '/tmp/pi-wsearch-key-test';
		Bun.write('/tmp/pi-wsearch-key-test/env', ['TINYFISH_API_KEY=zzzz9999'].join('\n'));
		resetConfigCache();
		try {
			expect(getConfig().tinyfishKey).toBe('zzzz9999');
			expect(keyOrigins().tinyfish).toBe('wsearch');
		} finally {
			delete process.env.WSEARCH_CACHE_DIR;
			resetConfigCache();
		}
	});
	test('keyOrigins reports env when the env var wins', () => {
		process.env.TINYFISH_API_KEY = 'abcd12345';
		resetConfigCache();
		try {
			expect(getConfig().tinyfishKey).toBe('abcd12345');
			expect(keyOrigins().tinyfish).toBe('env');
		} finally {
			delete process.env.TINYFISH_API_KEY;
			resetConfigCache();
		}
	});
	test('writeKey writes atomically 0600, replaces aliases, preserves other lines', async () => {
		const dir = `/tmp/pi-wsearch-write-test-${process.pid}`;
		process.env.WSEARCH_CACHE_DIR = dir;
		resetConfigCache();
		try {
			const path = keyFilePath();
			writeKey(
				PROVIDERS.find((p) => p.id === 'tavily')!,
				'abc12345',
			);
			const content = await Bun.file(path).text();
			expect(content).toContain('TAVILY_API_KEY=abc12345');
			const mode = (await import('node:fs')).statSync(path).mode & 0o777;
			expect(mode.toString(8)).toBe('600');
			// replace with an alias variant, verify no duplicate lines
			writeKey(
				PROVIDERS.find((p) => p.id === 'tavily')!,
				'zzz99999',
			);
			const after = await Bun.file(path).text();
			expect(after.split('\n').filter((l: string) => l.startsWith('TAVILY')).length).toBe(1);
			expect(after).toContain('TAVILY_API_KEY=zzz99999');
			// remove
			removeKey(PROVIDERS.find((p) => p.id === 'tavily')!);
			expect(await Bun.file(path).text()).not.toContain('TAVILY');
		} finally {
			Bun.spawnSync(['rm', '-rf', dir]);
			delete process.env.WSEARCH_CACHE_DIR;
			resetConfigCache();
		}
	});
	test('statusText lists pockets and fetch chain', () => {
		const text = statusText();
		expect(text).toContain('web search:');
		expect(text).toContain('pockets');
		expect(text).toContain('armed:');
		expect(text).toContain('dormant:');
		expect(text).toMatch(/fetch:\s+local →/);
	});
	test('knobs resolve from the wsearch env file and env wins', () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-wsearch-knob-'));
		process.env.WSEARCH_CACHE_DIR = dir;
		resetConfigCache();
		try {
			writeFileSync(
				join(dir, 'env'),
				['WSEARCH_ENGINES=serper,tavily', 'WSEARCH_FETCH_CHAIN=tavily,firecrawl'].join('\n'),
			);
			resetConfigCache();
			const cfg = getConfig();
			expect(cfg.searchEngines).toBe('serper,tavily');
			expect(cfg.fetchChain).toBe('tavily,firecrawl');
			// env beats the file
			process.env.WSEARCH_ENGINES = 'exa';
			resetConfigCache();
			expect(getConfig().searchEngines).toBe('exa');
			delete process.env.WSEARCH_ENGINES;
		} finally {
			rmSync(dir, { recursive: true, force: true });
			delete process.env.WSEARCH_CACHE_DIR;
			resetConfigCache();
		}
	});
	test('sanitizeError scrubs key-shaped strings', () => {
		const cfg = getConfig();
		const fake = `boom with key ${cfg.serperKey ?? 'sk-AAAAAAAAAAAAAAAAAAAA'} and Bearer ${'b'.repeat(24)}`;
		const clean = sanitizeError(new Error(fake));
		expect(clean).not.toContain('Bearer');
		expect(clean).not.toContain(cfg.serperKey ?? 'sk-AAAAAAAAAAAAAAAAAAAA');
	});
});

describe('abort (cooperative signals)', () => {
	test('postJson with an already-aborted signal never starts the request', async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error('user interrupt'));
		const t0 = Date.now();
		await expect(postJson('http://127.0.0.1:1/never-reachable', { q: 'x' }, {}, ctrl.signal)).rejects.toThrow(
			/abort|interrupt/i,
		);
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	test('scrape with an already-aborted signal returns fast and does NOT hit the reader chain', async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error('user interrupt'));
		const t0 = Date.now();
		const res = await scrape('https://example.com/', { signal: ctrl.signal });
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(res.error).toMatch(/abort/i);
		expect(res.error).not.toMatch(/firecrawl|reader chain/i);
		expect(res.renderer).toBe('local');
		expect(res.sections).toHaveLength(0);
	});

	test('scrape aborts mid-flight and does not route the abort to a reader backend', async () => {
		const ctrl = new AbortController();
		const t0 = Date.now();
		const p = scrape(`http://127.0.0.1:${port()}/slow`, {
			allowPrivate: true,
			signal: ctrl.signal,
			maxChars: 1000,
		});
		setTimeout(() => ctrl.abort(new Error('user interrupt')), 100);
		const res = await p;
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(res.error).toMatch(/abort/i);
		expect(res.renderer).toBe('local');
	});
});

describe('engines (live)', () => {
	test('all configured engines return hits and never leak keys', async () => {
		const st = keyStatus();
		if (!st.serper && !st.tavily && !st.exa) {
			console.log('no engine keys configured; skipping live engine test');
			return;
		}
		const outcomes = await runEngines({
			query: 'reciprocal rank fusion definition',
			maxResults: 4,
		});
		const alive = outcomes.filter((o) => !o.error);
		expect(alive.length).toBeGreaterThan(0);
		for (const o of outcomes) {
			for (const h of o.hits) {
				expect(h.url).toMatch(/^https?:\/\//);
				expect(JSON.stringify(o)).not.toMatch(/sk-[A-Za-z0-9]{12,}|Bearer\s+\S{12,}/);
			}
		}
	}, 40000);
});

const mkHit = (url: string, engine: string, title = url, snippet = 's'): FusedHit => ({
	title,
	url,
	snippet,
	engine,
	engines: [engine],
	rrfScore: 0.1,
	finalScore: 0.5,
	junk: false,
});

describe('fuse', () => {
	test('dedupes normalized URLs across engines and merges engine lists', () => {
		const outcomes = [
			{
				engine: 'serper',
				hits: [mkHit('https://Example.com/a?utm_source=x', 'serper')],
				latencyMs: 1,
			},
			{ engine: 'tavily', hits: [mkHit('https://example.com/a', 'tavily')], latencyMs: 1 },
			{ engine: 'exa', hits: [mkHit('https://arxiv.org/abs/2401.15884', 'exa')], latencyMs: 1 },
		];
		const fused = fuse(outcomes as any);
		expect(fused.length).toBe(2);
		const merged = fused.find((r) => normalizeUrl(r.url) === 'example.com/a');
		expect(merged).toBeDefined();
		expect(merged!.engines.toSorted()).toEqual(['serper', 'tavily']);
	});
	test('strips tracking params in normalizeUrl', () => {
		expect(normalizeUrl('https://a.com/x?utm_source=1&id=2#frag')).toBe('a.com/x?id=2');
	});
	test('junk downranking sinks score', () => {
		const outcomes = [
			{ engine: 'serper', hits: [mkHit('https://example.com/real', 'serper')], latencyMs: 1 },
			{ engine: 'tavily', hits: [mkHit('https://quora.com/fake', 'tavily')], latencyMs: 1 },
			{ engine: 'exa', hits: [], latencyMs: 1 },
		];
		const fused = fuse(outcomes as any);
		expect(fused[0].url === 'https://example.com/real' || fused[0].url.includes('example.com')).toBe(true);
	});
	test('rank position dominates: a #1 hit beats a lower-ranked one at equal agreement', () => {
		// url A is #1 in engine a; url B is #1 in engines b,c — B may win (2 engines),
		// but within one engine, rank 1 must outrank rank 8
		const outcomes = [
			{
				engine: 'a',
				hits: [
					mkHit('https://top.com/a', 'a'),
					...Array.from({ length: 7 }, (_, i) => mkHit(`https://filler${i}.com/x`, 'a')),
					mkHit('https://low.com/z', 'a'),
				],
				latencyMs: 1,
			},
		];
		const fused = fuse(outcomes as any);
		expect(fused[0].url).toBe('https://top.com/a');
		expect(fused[fused.length - 1].url).toBe('https://low.com/z');
		expect(fused[0].finalScore).toBeGreaterThan(fused[fused.length - 1].finalScore);
	});
	test('consensus is a bounded tiebreak, not a multiplier', () => {
		// A URL ranked #1 by ONE engine should beat a URL ranked #9 by ONE engine,
		// and the per-engine agreement bonus must stay tiny (a nudge, not a swing).
		const outcomes = [
			{
				engine: 'a',
				hits: [
					mkHit('https://perfect.com/x', 'a'),
					...Array.from({ length: 7 }, (_, i) => mkHit(`https://f${i}.com/a`, 'a')),
					mkHit('https://low.com/z', 'a'),
				],
				latencyMs: 1,
			},
		];
		const fused = fuse(outcomes as any);
		const perfect = fused.find((r) => r.url.includes('perfect.com'))!;
		const low = fused.find((r) => r.url.includes('low.com'))!;
		expect(perfect.finalScore).toBeGreaterThan(low.finalScore);
		// the agreement term is a negligible share of the total (< 25%)
		const consensusPart = perfect.finalScore - perfect.rrfScore;
		expect(consensusPart / perfect.finalScore).toBeLessThan(0.25);
	});
	test('merges the most informative snippet across engines', () => {
		const outcomes = [
			{ engine: 'a', hits: [{ title: '', url: 'https://x.com/p', snippet: 'short', engine: 'a' }], latencyMs: 1 },
			{
				engine: 'b',
				hits: [
					{
						title: 'Real Title',
						url: 'https://x.com/p',
						snippet: 'a much longer and more useful snippet',
						engine: 'b',
					},
				],
				latencyMs: 1,
			},
		];
		const fused = fuse(outcomes as any);
		expect(fused[0].snippet).toBe('a much longer and more useful snippet');
		expect(fused[0].title).toBe('Real Title');
	});
	test('diversifyByHost caps results per host', () => {
		const hits = ['a', 'b', 'c', 'd'].map((p, i) => ({
			...mkHit(`https://same.com/${p}`, 'a'),
			engines: ['a'],
			rrfScore: 1 - i * 0.1,
			finalScore: 1 - i * 0.1,
			junk: false,
		}));
		const out = diversifyByHost(hits as any, 2);
		expect(out.length).toBe(2);
		// a second host gets through
		const mixed = [
			...hits,
			{ ...mkHit('https://other.com/x', 'a'), engines: ['a'], rrfScore: 0.1, finalScore: 0.1, junk: false },
		];
		expect(diversifyByHost(mixed as any, 2).some((h) => h.url.includes('other.com'))).toBe(true);
	});
	test('exact-match boost lifts a hit containing the rare query term', () => {
		const outcomes = [
			{
				engine: 'a',
				hits: [
					mkHit('https://a.com/generic', 'a', 'A generic post about databases', 's'),
					mkHit('https://b.com/exact', 'a', 'pgvector halfvec indexing guide', 's'),
				],
				latencyMs: 1,
			},
		];
		const fused = fuse(outcomes as any, { query: 'pgvector halfvec' });
		const exact = fused.find((r) => r.url.includes('b.com'))!;
		const generic = fused.find((r) => r.url.includes('a.com'))!;
		expect(exact.finalScore).toBeGreaterThan(generic.finalScore);
		// same inputs without a query: RRF order is preserved (rank 2 both => insertion)
		const noQuery = fuse(outcomes as any, {});
		expect(noQuery[0].url).toBe('https://a.com/generic');
	});
	test('recency boost lifts a fresh hit within the freshness window', () => {
		const outcomes = [
			{
				engine: 'a',
				hits: [
					mkHit('https://a.com/old', 'a', 'An older article about databases'),
					mkHit('https://b.com/fresh', 'a', 'The newest database guide'),
				],
				latencyMs: 1,
			},
		];
		(outcomes[0].hits[0] as any).date = '2019-01-01';
		(outcomes[0].hits[1] as any).date = new Date().toISOString();
		const withFresh = fuse(outcomes as any, { freshness: 'day' });
		const without = fuse(outcomes as any, {});
		const freshWith = withFresh.find((r) => r.url.includes('b.com'))!.finalScore;
		const oldWith = withFresh.find((r) => r.url.includes('a.com'))!.finalScore;
		const freshWithout = without.find((r) => r.url.includes('b.com'))!.finalScore;
		const oldWithout = without.find((r) => r.url.includes('a.com'))!.finalScore;
		expect(freshWith).toBeGreaterThan(oldWith);
		expect(freshWithout).not.toBeGreaterThan(oldWithout);
	});
	test('near-duplicate titles collapse into one result and merge engines', () => {
		const outcomes = [
			{
				engine: 'a',
				hits: [mkHit('https://news.example.com/sqlite-release', 'a', 'SQLite 3.49 Released with New Enhancements')],
				latencyMs: 1,
			},
			{
				engine: 'b',
				hits: [mkHit('https://mirror.example.org/sqlite-3.49', 'b', 'SQLite 3.49 Released with New Enhancements')],
				latencyMs: 1,
			},
			{
				engine: 'c',
				hits: [mkHit('https://distinct.example.com/unrelated', 'c', 'A Completely Different Post About Rust')],
				latencyMs: 1,
			},
		];
		const fused = fuse(outcomes as any, {});
		expect(fused.length).toBe(2);
		const twin = fused.find((r) => r.url.includes('news.example.com') || r.url.includes('mirror.example.org'))!;
		expect(twin.engines).toContain('a');
		expect(twin.engines).toContain('b');
		expect(fused.some((r) => r.url.includes('distinct.example.com'))).toBe(true);
	});
});

describe('cache', () => {
	test('round-trip and TTL expiry', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wsearch-test-'));
		const c = openCache(join(dir, 'c.json'));
		const k = cacheKey(['a', 'b']);
		expect(c.get(k)).toBeUndefined();
		c.set(k, { v: 1 }, 60_000);
		expect((c.get(k) as any).v).toBe(1);
		const c2 = openCache(join(dir, 'c.json')); // reload from disk
		expect((c2.get(k) as any).v).toBe(1);
		const k2 = cacheKey(['expired']);
		c.set(k2, { v: 2 }, -1_000);
		expect(c.get(k2)).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe('scrape', () => {
	test('extractHtml strips scripts and preserves headings', () => {
		const { title, text } = extractHtml(
			`<html><head><title>Doc</title></head><body>
       <nav>MENU</nav><h1>Reciprocal Rank Fusion</h1>
       <p>RRF combines ranked lists.</p>
       <script>document.title='evil'</script>
       <h2>Formula</h2><p>score = 1/(k+rank).</p></body></html>`,
		);
		expect(title).toBe('Doc');
		expect(text).toContain('# Reciprocal Rank Fusion');
		expect(text).toContain('## Formula');
		expect(text).not.toContain('MENU');
		expect(text).not.toContain('evil');
	});
	test('extractHtml decodes entities but preserves escaped markup as text', () => {
		expect(decodeHtmlEntities('a &lt; b &amp; c &#39;d&#39; &quot;e&quot; &#x27;f&#x27;')).toBe(
			`a < b & c 'd' "e" 'f'`,
		);
		// an entity that is not a known name or numeric code stays untouched
		expect(decodeHtmlEntities('50 &notareal; 60')).toBe('50 &notareal; 60');
		const { text } = extractHtml('<p>&lt;limit param=&#34;rank&#34; /&gt;</p><p>It&#39;s a &amp; b</p>');
		expect(text).toContain('<limit param="rank" />');
		expect(text).toContain("It's a & b");
		expect(text).not.toContain('&lt;');
		expect(text).not.toContain('&amp;');
	});
	test('sliceSections drops nav bullets that leak into body text', () => {
		const { text } = extractHtml(
			`<h1>Doc</h1><p>Real content here about the topic.</p><ul><li>Home</li><li>About</li><li>Download</li><li>License</li><li>Support</li><li>Purchase</li></ul><p>Another real paragraph of content.</p>`,
		);
		const { sections } = sliceSections(text, 3000);
		const body = sections.join('\n');
		expect(body).toContain('Real content here');
		expect(body).not.toMatch(/^•\s*Home$/m);
		expect(body).not.toMatch(/^•\s*Download$/m);
	});
	test('sliceSections drops an in-body table of contents that echoes the outline', () => {
		const doc = [
			'# Alpha',
			'Table Of Contents',
			'1. Alpha 2. Beta 3. Gamma',
			'## Beta',
			'beta body text',
			'## Gamma',
			'gamma body text',
		].join('\n\n');
		const { sections } = sliceSections(doc, 3000);
		const body = sections.join('\n');
		expect(body).not.toMatch(/table of contents/i);
		expect(body).not.toContain('1. Alpha 2. Beta 3. Gamma');
		expect(body).toContain('beta body text');
	});
	test('sliceSections produces outline + capped sections', () => {
		const { title, text } = extractHtml(
			`<h1>Alpha</h1><p>lot of text about alpha alpha alpha alpha alpha</p><h2>Beta</h2><p>beta text here</p>`,
		);
		const { outline, sections } = sliceSections(text, 3000);
		void title;
		expect(outline).toContain('Alpha');
		expect(sections.length).toBeGreaterThanOrEqual(2);
	});

	test('sliceSections collapses 3+ newline runs, drops boilerplate, caps at paragraph boundary', () => {
		const text =
			`# Real Heading\n\nSkip to content\n\nUseful paragraph one.\n\nRelated articles\n\nUseful paragraph two.\n\n[About](/about) [Docs](/docs) [Blog](/blog)\n\n` +
			'Paragraph three with a good amount of real content in it.\n\n\n\n' +
			'Paragraph four after a four-newline run.';
		const { sections } = sliceSections(text, 3000);
		const joined = sections.join('\n\n');
		// no run of 3+ newlines survives anywhere
		expect(joined.match(/\n{3,}/)).toBeNull();
		const all = sections.join('');
		expect(all).not.toContain('Skip to content');
		expect(all).not.toContain('Related articles');
		expect(all).not.toContain('[About](/about)');
		expect(all).toContain('Useful paragraph one');
		expect(all).toContain('Paragraph four');

		const long = `# H\n\n` + 'word '.repeat(1000);
		const { sections: cappedSections } = sliceSections(long, 200);
		const capped = cappedSections[0];
		expect(capped).toContain('[section truncated]');
		// never cuts mid-word: the cut lands on a space immediately before the marker
		expect(/\w…/.test(capped)).toBe(false);
	});

	test('extractHtml keeps list items on their own lines, not run-on', () => {
		const { text } = extractHtml(
			`<h2>Steps</h2><ul><li>Get the key</li><li>Install the package</li><li>Run the check</li></ul><p>Longer conclusion sentence follows after the list.</p>`,
		);
		expect(text).toContain('Get the key');
		const lines = new Set(
			text
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean),
		);
		expect(lines.has('• Get the key')).toBe(true);
		expect(lines.has('• Install the package')).toBe(true);
		expect(text).not.toContain('Get the key Install');
	});
	test('local fetch + extraction against local server', async () => {
		const res = await scrape(`http://127.0.0.1:${port()}/docs`, { allowPrivate, render: 'local' });
		expect(res.error).toBeUndefined();
		expect(res.title).toBe('Test Docs');
		expect(res.outline).toContain('Reciprocal Rank Fusion');
		expect(res.text).toContain('hybrid search fusion pipelines');
		expect(res.text).not.toContain('nav junk');
	});
	test('rejects private hosts by default and bad schemes', () => {
		expect(() => validateUrl(`http://127.0.0.1:${port()}/docs`, false)).toThrow(/private/);
		expect(() => validateUrl('file:///etc/passwd', true)).toThrow(/protocol/);
	});
	test('thin page: forced-local succeeds (thin is fine); auto falls to the reader chain (cannot reach localhost) → error', async () => {
		const forced = await scrape(`http://127.0.0.1:${port()}/thin`, {
			allowPrivate,
			render: 'local',
		});
		expect(forced.error).toBeUndefined();
		expect(forced.text.length).toBeGreaterThan(0);
		const auto = await scrape(`http://127.0.0.1:${port()}/thin`, { allowPrivate, render: 'auto' });
		expect(auto.error).toBeDefined();
	}, 90000);

	// ---- pageSlice: read-tool style line paging ----------------------------
	test('pageSlice pages across sections with cursor semantics', () => {
		const sections = ['# One\n' + 'a'.repeat(50), '# Two\n' + 'b'.repeat(50), '# Three\n' + 'c'.repeat(50)];
		// joined: # One / aaa / ∅ / # Two / bbb / ∅ / # Three / ccc → 8 lines
		const first = pageSlice(sections, 1, 3);
		expect(first.content.split('\n')).toHaveLength(3);
		expect(first.content.startsWith('# One')).toBe(true);
		expect(first.total).toBe(8);
		expect(first.nextOffset).toBe(4);
		expect(first.remaining).toBe(5);

		const mid = pageSlice(sections, 4, 5);
		expect(mid.content).toContain('# Two');
		expect(mid.nextOffset).toBeNull();
		expect(mid.remaining).toBe(0);
		expect(mid.content).toContain('ccc');

		const last = pageSlice(sections, 8, 10);
		expect(last.content).toBe('c'.repeat(50));
		expect(last.nextOffset).toBeNull();
	});

	test('pageSlice handles boundaries: offset past end, zero sections, chosen indices', () => {
		const sections = ['# A\ncontent a', '# B\ncontent b', '# C\ncontent c'];
		const pastEnd = pageSlice(sections, 99999, 1000);
		expect(pastEnd.content).toBe('');
		expect(pastEnd.nextOffset).toBeNull();
		expect(pastEnd.remaining).toBe(0);

		const clamped = pageSlice(sections, 0, 2); // offset 0 treated as line 1
		expect(clamped.content).toContain('# A');

		const empty = pageSlice([], 1, 1000);
		expect(empty.total).toBe(0);
		expect(empty.nextOffset).toBeNull();

		// sections restrict the stream; offsets refer to the chosen subset
		const chosen = pageSlice(sections, 1, 100, [1, 2]);
		expect(chosen.total).toBeLessThan(pageSlice(sections, 1, 1000).total);
		expect(chosen.content).toContain('# B');
		expect(chosen.content).not.toContain('# A');
	});

	test('pageSlice is deterministic for identical sections', () => {
		const sections = ['# X\n' + 'x'.repeat(900), '# Y\n' + 'y'.repeat(900)];
		const a = pageSlice(sections, 1, 5);
		const b = pageSlice(sections, 1, 5);
		expect(a).toEqual(b);
	});
});
