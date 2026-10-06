/**
 * Fusion layer: URL normalization, dedupe, junk downranking, Reciprocal Rank
 * Fusion across engines. Empirical basis: hybrid+rerank > any single retriever
 * (arXiv 2604.01733 [B]); RRF is the standard merge. Ranking is pure RRF plus a
 * bounded agreement tiebreak, never a consensus multiplier.
 */
import type { EngineOutcome, Freshness, SearchHit } from './engines';

export interface FusedHit extends SearchHit {
	engines: string[];
	rrfScore: number;
	finalScore: number;
	junk: boolean;
}

export interface FuseOptions {
	/** raw user query: used for the exact-match (rare-term) boost */
	query?: string;
	/** freshness window: used to re-rank survivors by recency */
	freshness?: Freshness;
}

const JUNK_HOSTS = [
	'quora.com',
	'fiverr.com',
	'freelancer.com',
	'tiktok.com',
	'pinterest.com',
	'instagram.com',
	'facebook.com',
	'twitter.com',
	'x.com',
	'twitch.tv',
	'9gag.com',
	'buzzfeed.com',
];
const JUNK_TLDS = new Set(['xyz', 'top', 'loan', 'click', 'work', 'gq', 'icu', 'rest', 'cyou']);

const TRACKING_PARAMS = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'fbclid',
	'gclid',
	'ref',
	'ref_src',
	'mc_cid',
	'mc_eid',
	'igshid',
	'spm',
	'scm',
]);

export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw);
		const host = u.hostname.toLowerCase().replace(/^www\./, '');
		for (const p of Array.from(u.searchParams.keys())) {
			if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
		}
		u.hash = '';
		const q = u.searchParams.toString();
		return host + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '');
	} catch {
		return raw.toLowerCase();
	}
}

export function isJunk(raw: string): boolean {
	const host = normalizeUrl(raw).split('/')[0];
	if (JUNK_HOSTS.some((j) => host === j || host.endsWith('.' + j))) return true;
	const tld = host.split('.').pop() ?? '';
	if (JUNK_TLDS.has(tld)) return true;
	return false;
}

const RRF_K = 60;
/**
 * Bounded bonus for cross-engine agreement, used only to break near-ties.
 * Deliberately tiny: RRF already rewards multi-engine agreement (a URL in k
 * lists scores k/(K+rank)), so a large additive term would drown the rank
 * signal: and must never scale with how many engines happen to be configured.
 */
const CONSENSUS_TIEBREAK = 0.003;

// ---------------------------------------------------------------------------
// Lexical exact-match boost (BM25-style signal, pure function, no LLM).
// Dense/semantic ranking dilutes rare technical tokens (CVE-2026-…, pgvector,
// error codes, version strings). A hit whose title/snippet contains those
// tokens verbatim is very likely the page the coder wants: worth a bounded
// multiplicative nudge that can flip a near-tie, never dominate the ordering.
// ---------------------------------------------------------------------------

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
	// cap the work; duplicates collapsed
	return [...new Set(terms)].slice(0, 6);
}

/** Technical tokens (digit/dash/underscore/dot/colon) match as substrings; word-boundary otherwise. */
function termIn(term: string, text: string): boolean {
	if (/[0-9\-_./:]/.test(term)) return text.includes(term);
	return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(text);
}

/** 0..1 coverage of the query's rare terms, title matches count double. */
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
	return 0.3 * Math.min(1, matched / terms.length); // max 1.3x
}

// ---------------------------------------------------------------------------
// Recency re-rank (pure function). Engines that take a freshness param already
// filter; this re-ranks the survivors and covers engines without a window
// param. A hit with no parseable date stays neutral.
// ---------------------------------------------------------------------------

const FRESH_WINDOW_MS: Record<Exclude<Freshness, 'none'>, number> = {
	day: 86_400_000,
	week: 604_800_000,
	month: 2_592_000_000,
	year: 31_536_000_000,
};

function dateToMs(date: string | undefined): number | null {
	if (!date) return null;
	const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(date);
	if (m) {
		const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
		return Number.isNaN(d) ? null : d;
	}
	const d = Date.parse(date);
	return Number.isNaN(d) ? null : d;
}

function recencyBoost(date: string | undefined, freshness: Freshness | undefined): number {
	if (!freshness || freshness === 'none') return 0;
	const windowMs = FRESH_WINDOW_MS[freshness];
	const ts = dateToMs(date);
	if (ts === null) return 0;
	const ratio = Math.min(1, Math.max(0, 1 - (Date.now() - ts) / windowMs));
	return 0.25 * ratio; // max 1.25x for within-window
}

// ---------------------------------------------------------------------------
// Near-duplicate collapse: the same article syndicated/mirrored on several
// hosts (same core title) folds into one result; engines merge so agreement
// still reflects the true coverage. Conservative on purpose.
// ---------------------------------------------------------------------------

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
	// never merge short/generic titles ("Contact", "Home", "t"): too many distinct
	// pages share them
	const ta = A.split(' ');
	const tb = B.split(' ');
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

/**
 * Fuse engine results: pure RRF over per-engine ranks, dedupe by normalized
 * URL, a bounded agreement tiebreak, junk downranking. When a URL appears in
 * several engines we keep the best-ranked title and the most informative
 * snippet (engines truncate differently).
 */
export function fuse(outcomes: EngineOutcome[], opts: FuseOptions = {}): FusedHit[] {
	const { query, freshness } = opts;
	const rank: Record<string, { hit: SearchHit; ranks: { engine: string; rank: number }[] }> = {};
	let answering = 0;
	for (const oc of outcomes) {
		if (oc.error || !oc.hits.length) continue;
		answering++;
		oc.hits.forEach((h, i) => {
			const key = normalizeUrl(h.url);
			const slot = (rank[key] ??= { hit: { ...h }, ranks: [] });
			slot.ranks.push({ engine: oc.engine, rank: i + 1 });
			// keep the most informative snippet and fill a missing title/date
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
		// RRF decides the ranking; agreement only breaks near-ties, normalized by
		// the engines that answered so adding pockets never inflates scores
		const consensus = answering > 0 ? ranks.length / answering : 0;
		let score = rrf + CONSENSUS_TIEBREAK * consensus;
		// exact-match (rare technical term) boost: flips near-ties for coders
		score *= 1 + exactMatchBoost(hit, query);
		// recency re-rank within the freshness window
		score *= 1 + recencyBoost(hit.date, freshness);
		// a hit with no usable snippet is lower-confidence
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
	// fold same-title mirrors into their best twin (engines merge)
	return collapseNearDuplicates(sorted);
}

/**
 * Cap results per host so a single site cannot dominate the list (three
 * sections of the same docs page are rarely three distinct answers).
 */
export function diversifyByHost(hits: FusedHit[], maxPerHost = 2): FusedHit[] {
	const perHost = new Map<string, number>();
	const out: FusedHit[] = [];
	for (const h of hits) {
		const host = normalizeUrl(h.url).split('/')[0];
		const n = perHost.get(host) ?? 0;
		if (n >= maxPerHost) continue;
		perHost.set(host, n + 1);
		out.push(h);
	}
	return out;
}

export function dedupeExtras(fused: FusedHit[]): FusedHit[] {
	// within already-normalized keys no dupes remain; this is a guard for tests
	const seen = new Set<string>();
	const out: FusedHit[] = [];
	for (const f of fused) {
		const k = normalizeUrl(f.url);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(f);
	}
	return out;
}
