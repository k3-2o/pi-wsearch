import type { EngineOutcome, SearchHit } from './engines';
import { isJunk, normalizeUrl, hostOf } from './urls';

export interface FusedHit extends SearchHit {
	engines: string[];
	rrfScore: number;
	finalScore: number;
	junk: boolean;
}

export interface FuseOptions {
	query?: string;
}

const RRF_K = 60;
// Tiny on purpose: RRF already rewards multi-engine agreement, and the bonus
// must never scale with how many engines happen to be configured.
const CONSENSUS_TIEBREAK = 0.003;

// Dense/semantic ranking dilutes rare technical tokens (CVE-2026-…, pgvector,
// error codes): a verbatim title/snippet hit gets a bounded nudge, never total.
const STOPWORDS = new Set([
	'a',
	'an',
	'the',
	'and',
	'or',
	'but',
	'nor',
	'for',
	'so',
	'yet',
	'of',
	'to',
	'in',
	'on',
	'at',
	'by',
	'with',
	'from',
	'as',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'being',
	'it',
	'its',
	'this',
	'that',
	'these',
	'those',
	'how',
	'what',
	'why',
	'when',
	'where',
	'which',
	'who',
	'whom',
	'do',
	'does',
	'did',
	'can',
	'could',
	'should',
	'would',
	'may',
	'might',
	'must',
	'not',
	'no',
	'yes',
	'about',
	'into',
	'over',
	'up',
	'down',
	'out',
	'off',
	'than',
	'then',
	'now',
	'too',
	'very',
	'get',
	'use',
	'using',
	'vs',
	'versus',
	'best',
	'top',
	'list',
	'your',
	'our',
	'their',
	'they',
	'he',
	'she',
	'we',
	'you',
	'i',
	'have',
	'has',
	'had',
	'there',
	'here',
	'all',
	'any',
	'each',
	'some',
	'more',
	'most',
	'only',
	'also',
	'just',
	's',
	't',
]);

function queryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const w of query.toLowerCase().split(/[^a-z0-9]+/)) {
		if (w.length < 3 || STOPWORDS.has(w)) continue;
		terms.push(w);
	}
	return [...new Set(terms)].slice(0, 6);
}

function termIn(term: string, text: string): boolean {
	return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(text);
}

function exactMatchBoost(hit: { title: string; snippet: string }, query: string | undefined): number {
	if (!query) return 0;
	const terms = queryTerms(query);
	if (!terms.length) return 0;
	const title = hit.title.toLowerCase();
	const snip = hit.snippet.toLowerCase();
	let matched = 0;
	for (const t of terms) {
		if (termIn(t, title)) matched += 1;
		else if (termIn(t, snip)) matched += 0.5;
	}
	if (!matched) return 0;
	return 0.3 * Math.min(1, matched / terms.length);
}

function normTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\b(a|an|the|and|or|for|of|to|in|on|at|with|by|from|is|are|was|were|this|that|these|those)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function isNearDuplicate(a: FusedHit, b: FusedHit): boolean {
	const A = normTitle(a.title);
	const B = normTitle(b.title);
	// dedupe both sides so a repeated word can't inflate the ratio past 1.0
	const ta = [...new Set(A.split(' ').filter(Boolean))];
	const tb = [...new Set(B.split(' ').filter(Boolean))];
	if (ta.length < 3 || tb.length < 3) return false;
	if (A === B) return true;
	const inter = ta.filter((w) => tb.includes(w)).length;
	const jacc = inter / Math.max(new Set([...ta, ...tb]).size, 1);
	if (jacc >= 0.85) return true;
	return (A.startsWith(B) || B.startsWith(A)) && Math.abs(ta.length - tb.length) <= 1;
}

function collapseNearDuplicates(fused: FusedHit[]): FusedHit[] {
	const kept: FusedHit[] = [];
	for (const h of fused) {
		const twin = kept.find((k) => isNearDuplicate(k, h));
		if (twin) {
			twin.engines = [...new Set([...twin.engines, ...h.engines])];
			if (h.snippet.length > twin.snippet.length) twin.snippet = h.snippet;
			if (h.title.length > twin.title.length && !twin.title.includes(h.title)) twin.title = h.title;
			continue;
		}
		kept.push(h);
	}
	return kept;
}

export function fuse(outcomes: EngineOutcome[], opts: FuseOptions = {}): FusedHit[] {
	const { query } = opts;
	const rank: Record<string, { hit: SearchHit; ranks: { engine: string; rank: number }[] }> = {};
	let answering = 0;
	for (const oc of outcomes) {
		if (oc.error || !oc.hits.length) continue;
		answering++;
		oc.hits.forEach((h, i) => {
			const key = normalizeUrl(h.url);
			const slot = (rank[key] ??= { hit: { ...h }, ranks: [] });
			slot.ranks.push({ engine: oc.engine, rank: i + 1 });
			if (h.snippet.length > slot.hit.snippet.length) slot.hit.snippet = h.snippet;
			if (!slot.hit.title && h.title) slot.hit.title = h.title;
			slot.hit.date ??= h.date;
		});
	}
	const fused: FusedHit[] = [];
	for (const [, { hit, ranks }] of Object.entries(rank)) {
		let rrf = 0;
		for (const r of ranks) rrf += 1 / (RRF_K + r.rank);
		const junk = isJunk(hit.url);
		// agreement breaks only near-ties and is normalized by engines answered,
		// so adding pockets never inflates scores
		const consensus = answering > 0 ? ranks.length / answering : 0;
		let score = rrf + CONSENSUS_TIEBREAK * consensus;
		score *= 1 + exactMatchBoost(hit, query);
		if (hit.snippet.trim().length < 30) score *= 0.92;
		if (junk) score *= 0.25;
		fused.push({
			...hit,
			engines: ranks.map((r) => r.engine),
			rrfScore: rrf,
			finalScore: Math.round(score * 1e5) / 1e5,
			junk,
		});
	}
	const sorted = fused.toSorted((a, b) => b.finalScore - a.finalScore);
	return collapseNearDuplicates(sorted);
}

export function diversifyByHost(hits: FusedHit[], maxPerHost = 2): FusedHit[] {
	const perHost = new Map<string, number>();
	const out: FusedHit[] = [];
	for (const h of hits) {
		const host = hostOf(h.url);
		const n = perHost.get(host) ?? 0;
		if (n >= maxPerHost) continue;
		perHost.set(host, n + 1);
		out.push(h);
	}
	return out;
}
