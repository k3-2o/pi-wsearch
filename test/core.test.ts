/**
 * Core tests for web search Tier-1. Run with: bun test web/
 * Live engine tests run only when the keys are present in ~/.zshrc / env.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
	SPECS,
	disabledFlagPath,
} from '../src/config';
import { writeKey, removeKey, statusText } from '../src/keys';
import { registerWebTools, FETCH_PARAMS } from '../src/tools';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { cacheKey, openCache } from '../src/cache';
import { postJson, runEngines } from '../src/engines';
import { fuse, diversifyByHost, type FusedHit } from '../src/fuse';
import { normalizeUrl } from '../src/urls';
import {
	decodeHtmlEntities,
	extractHtml,
	isPrivateHost,
	joinSections,
	sliceSections,
	scrape,
	validateUrl,
} from '../src/scrape';
import { stubReader } from '../src/transport';

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
		} else if (u.pathname === '/big') {
			// 12 sections x ~3KB each: exceeds the composed 12KB cap, so the
			// joined text must be marked truncated (never silently cut)
			let html = '<!doctype html><html><head><title>Big</title></head><body>';
			for (let i = 0; i < 12; i++) html += `<h2>Section ${i}</h2><p>${'w'.repeat(3000)}</p>`;
			html += '</body></html>';
			res.setHeader('content-type', 'text/html');
			res.end(html);
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
		// (the pair list derives from the catalog so it cannot drift from SPECS)
		for (const [envName, field] of SPECS.map((s) => [s.envNames[0], s.key] as const)) {
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
		expect(parseEnvLine('set -x BRAVE_API_KEY ghi789')).toEqual(['BRAVE_API_KEY', 'ghi789']); // fish without -g
		expect(parseEnvLine('$env.YDC_API_KEY = "jkl012"')).toEqual(['YDC_API_KEY', 'jkl012']);
		expect(parseEnvLine('# a comment')).toBeNull();
		expect(parseEnvLine('ls -la')).toBeNull();
	});
	test('parseEnvLine strips trailing comments but keeps # inside values/quotes', () => {
		expect(parseEnvLine('export TAVILY_API_KEY=abc12345 # my key')).toEqual(['TAVILY_API_KEY', 'abc12345']);
		expect(parseEnvLine("export SERPER_API_KEY='abc12345' # my key")).toEqual(['SERPER_API_KEY', 'abc12345']);
		expect(parseEnvLine('set -gx EXA_API_KEY def45678 # comment')).toEqual(['EXA_API_KEY', 'def45678']);
		expect(parseEnvLine('$env.KAGI_API_KEY = "ghi78901" # comment')).toEqual(['KAGI_API_KEY', 'ghi78901']);
		// a # inside a quoted value, or mid-token, is content, not a comment
		expect(parseEnvLine('export FOO="a#b"')).toEqual(['FOO', 'a#b']);
		expect(parseEnvLine('export BAR=abc#def')).toEqual(['BAR', 'abc#def']);
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
	test('off flag toggles status and registerWebTools exposure', () => {
		const dir = mkdtempSync(join(tmpdir(), 'pi-wsearch-off-'));
		process.env.WSEARCH_CACHE_DIR = dir;
		resetConfigCache();
		try {
			expect(disabledFlagPath()).toBe(join(dir, 'off'));
			expect(existsSync(disabledFlagPath())).toBe(false);
			expect(statusText()).toContain('web tools: ON');

			const regs: Array<{ name: string; exposure?: string }> = [];
			const stub = {
				registerTool: (tool: { name: string; exposure?: string }) => void regs.push(tool),
			} as unknown as Parameters<typeof registerWebTools>[0];
			registerWebTools(stub);
			expect(regs.map((r) => r.exposure)).toEqual(['direct', 'direct']);

			writeFileSync(disabledFlagPath(), '');
			expect(statusText()).toContain('web tools: OFF');
			regs.length = 0;
			registerWebTools(stub);
			expect(regs.map((r) => r.exposure)).toEqual(['hidden', 'hidden']);
		} finally {
			delete process.env.WSEARCH_CACHE_DIR;
			resetConfigCache();
			rmSync(dir, { recursive: true, force: true });
		}
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

	test('abort landing INSIDE a reader attempt returns the abort message, never a raw TypeError', async () => {
		// /thin fails local extraction in auto mode -> the reader chain starts;
		// abort lands while the first backend is suspended. Stub all backends so
		// no real network is touched, and count rejects to prove no paid reader
		// ran to completion.
		let rejected = 0;
		let completed = false;
		const hanging = {
			available: () => true,
			// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signal drives the reject
			read: (_url: URL, signal?: AbortSignal) =>
				new Promise<{ title: string; markdown: string }>((resolve, reject) => {
					if (signal?.aborted) return reject(new Error('aborted'));
					signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
					void resolve; // never resolves: only the abort releases this attempt
				}),
		};
		const restore = [
			stubReader('firecrawl', hanging),
			stubReader('tavily', hanging),
			stubReader('exa', hanging),
			stubReader('jina', hanging),
		];
		try {
			const ctrl = new AbortController();
			const t0 = Date.now();
			const p = scrape(`http://127.0.0.1:${port()}/thin`, {
				allowPrivate,
				render: 'auto',
				signal: ctrl.signal,
			});
			setTimeout(() => ctrl.abort(new Error('user interrupt')), 60);
			const res = await p;
			expect(Date.now() - t0).toBeLessThan(5000);
			expect(res.error).toMatch(/abort/i);
			expect(res.error).not.toMatch(/cannot read|properties of null|typeerror/i);
			expect(res.renderer).toBe('local');
			expect(rejected).toBeLessThanOrEqual(1);
			expect(completed).toBe(false);
		} finally {
			for (const r of restore) r();
		}
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
	test('runEngines with an empty pin reports the real cause instead of masking it', async () => {
		// an empty engines pin never selects anything, deterministically: the
		// synthetic 'none' outcome must say WHY (no keys / bad pin), not vanish
		const outcomes = await runEngines({ query: 'x', engines: [] });
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].engine).toBe('none');
		expect(outcomes[0].error).toMatch(/no search engine keys configured|no configured engines/i);
	});
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
		const merged = fused.find((r) => normalizeUrl(r.url) === 'https://example.com/a');
		expect(merged).toBeDefined();
		expect(merged!.engines.toSorted()).toEqual(['serper', 'tavily']);
	});
	test('strips tracking params in normalizeUrl', () => {
		expect(normalizeUrl('https://a.com/x?utm_source=1&id=2#frag')).toBe('https://a.com/x?id=2');
	});
	test('normalizeUrl keeps scheme+port and sorts query keys', () => {
		expect(normalizeUrl('https://x.com/a?b=2&a=1')).toBe('https://x.com/a?a=1&b=2');
		expect(normalizeUrl('http://x.com/a')).not.toBe(normalizeUrl('https://x.com/a'));
		expect(normalizeUrl('https://x.com:8443/a')).toBe('https://x.com:8443/a');
		expect(normalizeUrl('https://www.x.com/a')).toBe('https://x.com/a');
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
	test('one shared word repeated many times does NOT merge distinct pages', () => {
		// only 'guide' overlaps; the old occurrence-count Jaccard merged these
		// at >= 1.0. Bag semantics (dedupe both titles) keep jacc < 0.85.
		const outcomes = [
			{ engine: 'a', hits: [mkHit('https://a.example.com/x', 'a', 'SQLite Guide Guide Guide')], latencyMs: 1 },
			{ engine: 'b', hits: [mkHit('https://b.example.com/y', 'b', 'Rust Guide Guide Guide Guide')], latencyMs: 1 },
		];
		const fused = fuse(outcomes as any, {});
		expect(fused.length).toBe(2);
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
	test('expired entries are purged on reload, not carried across restarts', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wsearch-purge-'));
		const path = join(dir, 'c.json');
		const stale = cacheKey(['stale']);
		const c = openCache(path);
		c.set(stale, { v: 1 }, -1_000);
		c.set(cacheKey(['fresh']), { v: 2 }, 60_000); // persists BOTH (stale still in store)
		const c2 = openCache(path); // load() must purge the expired entry in memory
		c2.set(cacheKey(['fresh2']), { v: 3 }, 60_000); // persists the purged store
		const raw = JSON.parse(await Bun.file(path).text()) as { entries: Record<string, unknown> };
		expect(Object.keys(raw.entries)).not.toContain(stale);
		expect(c2.get(stale)).toBeUndefined();
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

	test('sliceSections aligns outline[i] with sections[i] via a synthesized (lead) entry', () => {
		const doc = [
			'RePL Guide',
			'Intro paragraph before any heading — the page lead.',
			'## History',
			'history body',
			'## Overview',
			'overview body',
			'## Uses',
			'uses body',
		].join('\n\n');
		const { outline, sections } = sliceSections(doc, 3000);
		expect(outline[0]).toBe('(lead)');
		expect(outline).toEqual(['(lead)', 'History', 'Overview', 'Uses']);
		// body i must sit under its outline name: section[i] contains outline[i+0]'s heading
		expect(sections[0]).not.toMatch(/^#/); // lead is heading-less
		expect(sections[1]).toContain('## History');
		expect(sections[2]).toContain('## Overview');
		expect(sections[3]).toContain('## Uses');
	});

	test('search drops engines that error or return nothing useful', async () => {
		const { fuse } = await import('../src/fuse');
		const outcomes = [
			{ engine: 'dead', error: 'HTTP 500', hits: [], latencyMs: 10 },
			{ engine: 'empty', hits: [], latencyMs: 10 }, // exhausted: no error, nothing useful
			{
				engine: 'good',
				hits: [{ title: 'Hit', url: 'https://a.com/x', snippet: 'good', engine: 'good' }],
				latencyMs: 10,
			},
		];
		const f = fuse(outcomes as never, { query: 'q' });
		const engines = [...new Set(f.flatMap((r) => r.engines))];
		expect(engines).toEqual(['good']); // problem engines contribute nothing and are invisible
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
		expect(capped).toContain('[section truncated: capped at 200 chars');
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
	test('joinSections marks truncation and never exceeds maxChars', () => {
		const sections = ['# A\n' + 'x '.repeat(4000), '# B\n' + 'y '.repeat(4000)];
		const { text, truncated } = joinSections(['A', 'B'], sections, 600);
		expect(truncated).toBe(true);
		expect(text).toContain('[truncated]');
		expect(text.length).toBeLessThanOrEqual(600);
		// small content: no marker, no truncation
		const small = joinSections(['A'], ['# A\nbody'], 1000);
		expect(small.truncated).toBe(false);
		expect(small.text).not.toContain('[truncated]');
	});
	test('oversized page scrape reports truncated=true with the marker', async () => {
		const res = await scrape(`http://127.0.0.1:${port()}/big`, { allowPrivate, render: 'local' });
		expect(res.error).toBeUndefined();
		expect(res.truncated).toBe(true);
		expect(res.text).toContain('[truncated]');
		expect(res.text.length).toBeLessThanOrEqual(12000);
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
	test('SSRF guard canonicalizes IPv6, mapped, and obfuscated forms', () => {
		// bracketed IPv6 that URL keeps in brackets (the old gate never matched)
		expect(isPrivateHost('[::1]')).toBe(true);
		expect(isPrivateHost('[fd00::1]')).toBe(true);
		expect(isPrivateHost('[fe80::1]')).toBe(true);
		expect(isPrivateHost('[2001:db8::1]')).toBe(false);
		// full-form loopback normalizes to ::1 via URL in validateUrl, and here too
		expect(isPrivateHost('0:0:0:0:0:0:0:1')).toBe(true);
		expect(isPrivateHost('[0:0:0:0:0:0:0:1]')).toBe(true);
		// IPv4-mapped IPv6: hex-encoded v4 tail
		expect(isPrivateHost('[::ffff:7f00:1]')).toBe(true); // 127.0.0.1
		expect(isPrivateHost('[::ffff:a00:1]')).toBe(true); // 10.0.0.1
		expect(isPrivateHost('[::ffff:cb00:7107]')).toBe(false); // 203.0.113.7, public
		expect(isPrivateHost('[::1.2.3.4]')).toBe(false); // dotted form, public
		// dotted-shorthand/obfuscated IPv4 (WHATWG already normalizes; guard catches)
		expect(isPrivateHost('2130706433')).toBe(true); // 127.0.0.1 decimal
		expect(isPrivateHost('0x7f.0.0.1')).toBe(true);
		expect(isPrivateHost('127.1')).toBe(true);
		expect(isPrivateHost('169.254.5.5')).toBe(true);
		expect(isPrivateHost('8.8.8.8')).toBe(false);
		expect(isPrivateHost('example.com')).toBe(false);
	});
	test('validateUrl rejects the hostile-url classics end to end', () => {
		expect(() => validateUrl('http://[::1]/admin')).toThrow(/private/);
		expect(() => validateUrl('http://[::ffff:7f00:1]/')).toThrow(/private/);
		expect(() => validateUrl('http://2130706433/')).toThrow(/private/);
		expect(() => validateUrl('http://0x7f.0.0.1/')).toThrow(/private/);
		expect(() => validateUrl('http://127.1/')).toThrow(/private/);
		expect(() => validateUrl('https://8.8.8.8/')).not.toThrow();
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

	// ---- bonded fetch schema: sections is the only address ------------------
	test('FETCH_PARAMS accepts section reads and rejects everything else', () => {
		const tool = { name: 'web.fetch', parameters: FETCH_PARAMS } as never;
		const validate = (args: Record<string, unknown>) => {
			try {
				validateToolArguments(tool, { name: 'web.fetch', arguments: args } as never);
				return true;
			} catch {
				return false;
			}
		};
		expect(validate({ url: 'https://example.com/a', sections: [0] })).toBe(true);
		expect(validate({ url: 'https://example.com/a', sections: [0, 1, 2] })).toBe(true);
		expect(validate({ url: 'https://example.com/a' })).toBe(false); // bare url
		expect(validate({ url: 'https://example.com/a', sections: [] })).toBe(false);
		expect(validate({ url: 'https://example.com/a', sections: [0], offset: 5 })).toBe(false);
		expect(validate({ url: 'https://example.com/a', sections: [0], limit: 25 })).toBe(false);
		expect(validate({ sections: [0] })).toBe(false);
	});
});
