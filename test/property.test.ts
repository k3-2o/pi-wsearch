/**
 * Property-based invariants for the pure layers (fast-check).
 * These hold for ANY input, not hand-picked cases — the same style as the
 * pi-shake pre-publish suite.
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import type { EngineOutcome } from '../src/engines';
import { fuse, diversifyByHost } from '../src/fuse';
import { isJunk, normalizeUrl } from '../src/urls';

const ENGINE_NAMES = ['serper', 'tavily', 'exa', 'brave', 'jina', 'kagi', 'you', 'firecrawl', 'tinyfish'] as const;

function hit(
	url: string,
	engine: string,
	title = 'page',
	snippet = 'description of the page content',
): {
	title: string;
	url: string;
	snippet: string;
	engine: string;
} {
	return { title, url, snippet, engine };
}

const fcUrl = fc.webUrl({ authoritySettings: { withIPv4: true } });
const fcHits = fc
	.array(fc.tuple(fcUrl, fc.constantFrom(...ENGINE_NAMES)), { minLength: 1, maxLength: 6 })
	.map((pairs) =>
		pairs.map(([url, engine], i) => hit(url, engine, `result ${i}`, `snippet ${i}: web page content here`)),
	);

function outcomesFor(engine: string, hits: ReturnType<typeof hit>[]): EngineOutcome {
	return { engine, hits, latencyMs: 1 };
}

describe('fuse properties', () => {
	test('results are non-increasing in finalScore', () => {
		fc.assert(
			fc.property(
				fc
					.array(fcHits, { minLength: 1, maxLength: 3 })
					.map((groups) => groups.map((hits, i) => outcomesFor(String(i) + 'e', hits))),
				(outcomes) => {
					const fused = fuse(outcomes);
					for (let i = 1; i < fused.length; i++) {
						expect(fused[i - 1].finalScore).toBeGreaterThanOrEqual(fused[i].finalScore);
					}
				},
			),
		);
	});

	test('a URL cited by more engines scores at least as high (RRF is additive)', () => {
		fc.assert(
			fc.property(fcHits, (hits) => {
				const one = fuse([outcomesFor('serper', hits)]);
				const two = fuse([outcomesFor('serper', hits), outcomesFor('tavily', hits)]);
				expect(two.length).toBe(one.length);
				for (const r of two) {
					const alone = one.find((o) => normalizeUrl(o.url) === normalizeUrl(r.url));
					expect(alone).toBeDefined();
					expect(r.rrfScore).toBeGreaterThan(alone!.rrfScore);
				}
			}),
		);
	});

	test('junk pages are downweighted to exactly 0.25 of the identical non-junk hit', () => {
		fc.assert(
			fc.property(fcUrl, (url) => {
				if (isJunk(url)) return; // never use a junk URL as the baseline
				const clean = fuse([outcomesFor('serper', [hit(url, 'serper')])])[0];
				fc.pre(clean !== undefined);
				const junk = fuse([outcomesFor('serper', [hit('https://www.facebook.com/somewhere', 'serper')])])[0];
				expect(junk.finalScore).toBeCloseTo(clean.finalScore * 0.25, 4);
			}),
		);
	});

	test('diversifyByHost never exceeds maxPerHost per host', () => {
		fc.assert(
			fc.property(fc.array(fcHits, { minLength: 1, maxLength: 4 }), (groups) => {
				const all = groups.flat();
				const fused = fuse(all.map((h, i) => outcomesFor(ENGINE_NAMES[i % ENGINE_NAMES.length], [h])));
				const out = diversifyByHost(fused, 2);
				const counts = new Map<string, number>();
				for (const r of out) {
					const host = r.url
						.split('/')[2]
						?.toLowerCase()
						.replace(/^www\./, '');
					if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
				}
				for (const n of counts.values()) expect(n).toBeLessThanOrEqual(2);
			}),
		);
	});
});

describe('urls properties', () => {
	const hostArb = fc.constantFrom(
		'example.com',
		'www.Example.com',
		'2001:db8::1',
		'127.0.0.1',
		'sub.example.co.uk',
		'xn--bcher-kva.example',
		'example.dev',
		'example.io',
	);
	const pathArb = fc.constantFrom('', '/', '/a/b/', '/a//b', '/deep/path/with/segments');
	const queryArb = fc.constantFrom('', 'utm_source=x', 'a=1&b=2', 'b=2&a=1&utm_medium=y', 'ref=z');
	const protocolArb = fc.constantFrom('https', 'http');

	test('normalizeUrl is idempotent; for parseable URLs it also strips junk', () => {
		fc.assert(
			fc.property(
				fc.record({ host: hostArb, path: pathArb, query: queryArb, protocol: protocolArb }),
				({ host, path, query, protocol }) => {
					const url = `${protocol}://${host}${path}${query ? '?' + query : ''}`;
					const once = normalizeUrl(url);
					expect(normalizeUrl(once)).toBe(once);
					// Unparseable inputs (e.g. unbracketed IPv6 hosts) fall back to raw.toLowerCase() by design.
					let parseable = true;
					try {
						new URL(url);
					} catch {
						parseable = false;
					}
					if (!parseable) return;
					expect(once).not.toMatch(/utm_|fbclid|gclid|ref(_src)?=|mc_|igshid|spm|scm/);
					expect(once).not.toMatch(/^https?:\/\/www\./);
					expect(once).not.toMatch(/\/$/);
					expect(once).not.toMatch(/#/);
				},
			),
		);
	});

	test('isJunk never fires on ordinary hosts and always on the junk list', () => {
		fc.assert(
			fc.property(hostArb, (host) => {
				expect(isJunk(`https://${host}/x`)).toBe(false);
			}),
		);
		for (const j of ['quora.com', 'x.com', 'tiktok.com', 'example.xyz', 'scam.top']) {
			expect(isJunk(`https://www.${j}/p?utm_source=a`)).toBe(true);
		}
	});
});
