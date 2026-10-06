# Web Search Architecture for Coding Agents — v3 (search + fetch only)

### Triangulated from peer-reviewed research and empirical benchmarks, Oct 2026

> **v3.** v2's deep-research pipeline (decompose → gates → delegate → reflect →
> attribute) and its benchmark were **evicted on 2026-10-05**: the frozen-corpus A/B
> against flat search+fetch composition tied (0.97 vs 0.97, flat baseline 1.6× faster)
> and a live two-session replication agreed the loop added nothing measurable.
> The product is two tools — `web.search` + `web.fetch` — and every trace of the
> loop, its eval harness, and its fixture corpus has been removed. This document
> grades the evidence behind the two tools only. Grading legend:

- **[P]** — peer-reviewed paper with empirical evaluation (arxiv/ACL/NeurIPS/EMNLP/ICLR venues)
- **[B]** — benchmark / large-scale empirical study (data with numbers, not anecdote)
- **[V]** — vendor operational report (no peer review; **kept only as tuning hypotheses**, never as requirements)

---

## 0. The design in one paragraph

A coding agent's web need is a **lookup**, not a thesis: an API's default port, the
current LTS version, whether an option exists. Two primitives serve it:

1. `web.search` — **hybrid multi-engine retrieval**: every configured engine runs in
   parallel (a registry of provider pockets — Serper, Tavily, Exa, Brave, Jina,
   Kagi, You.com, Firecrawl, TinyFish — gated by key/endpoint presence, so
   any count from 1 to N coexists) and is
   merged with **Reciprocal Rank Fusion**, URL-deduped, and junk-filtered.
2. `web.fetch` — **structure-aware page reading**: extract headings + sections locally
   (a key-gated reader chain — Firecrawl, Tavily extract, Exa contents, Jina —
   renders JavaScript-heavy or failed pages; no single fallback), serve an
   outline, and page through by **line ranges** so the agent reads only what it needs
   (read-tool semantics).

Everything else is agent skill, composed at the model level: search broad → read the
key sections → verify against a second source → decline to answer when evidence is
insufficient. The empirical anchors:

| Finding | Source | Grade |
|---|---|---|
| API/web-search agents beat browser-navigation agents (+24% hybrid over browser-only) — engines first, scrape last | Beyond Browsing (ACL Findings'25) | [P] |
| Hybrid (lexical+dense) retrieval beats any single stage; RRF is the standard merge; BM25 can beat dense on some corpora | From BM25 to CRAG (arXiv 2604.01733, 23k queries) | [B] |
| Field-structured search + fetch-only-selected-sections = −20.7–50.6% tokens at higher accuracy | Sieve (arXiv 2608.02751) | [P] |
| LLM search engines cite more diverse domains (37% unique) but do **not** beat Google on credibility/neutrality/safety | Source Coverage & Citation Bias (arXiv 2512.09483, 55,936 queries) | [B] |
| Generative-SEO source influence is real, measurable, and gameable (Exposure / Faithful Credit / Causal Impact) | CC-GSEO-Bench (arXiv 2509.05607) | [B] |
| For code: **sliding-window/AST chunking beats function-chunking** (−3.6–5.6 pts); cross-file context length is the dominant parameter (+4.2 pts at 8k) | Chunking & RAG code completion (arXiv 2605.04763, 864 settings) | [P] |

---

## 1. Pillars

### Pillar 1 — Hybrid retrieval core
- **Hybrid + two-stage rerank is the measured winner** [B]: 10 strategies × 23k queries —
  hybrid (lexical+dense) → neural rerank gives Recall@5 0.816 vs ~0.5 single-stage; BM25
  can beat dense (don't over-trust embeddings); contextual retrieval gives consistent
  gains.
- **Engines first, scrape last** [P] (Beyond Browsing): API/web agents beat browser
  orchestration — the tool should buy *ranked results*, not chewed pages.
- **The rerank stage is a deliberate non-investment here.** RRF alone (+ dedupe + junk
  filter) scores at parity with the full loop in our own measurements; a neural rerank
  pass costs an extra model call per candidate for a gain the lookup workload does not
  measurably cash. If the workload ever justifies it, it is **CANDIDATE**, not a
  requirement (per the [P]/[B] gate below).

→ **Implemented:** a provider registry (`engines.ts` — one def per engine: how it is
  configured, how it searches) runs every configured-and-wanted engine in parallel;
  pure RRF merge + URL dedupe + junk downranking (`fuse.ts`). `WSEARCH_ENGINES` pins
  the set to any subset (1 engine works — RRF degenerates cleanly). No mode knob, no
  region, no authority lists — the authority list rated Reuters 1/5 and the mode
  whitelist was its second act (wikipedia-in-news bug included); both were removed
  after measuring as noise.

### Pillar 2 — Structure-aware fetch
- **Sieve [P]**: outline-guided section selection cuts tokens −20.7–50.6% at higher
  accuracy — fetch an outline, then read only the sections that matter.
- **Code chunking [P]**: sliding-window/AST over functions; multi-source (docs +
  StackOverflow + repos) mitigates lexical-overlap retrieval failure [P CodeRAG-Bench].

→ **Implemented:** local extraction (headings + sections) first; when it fails or is
  thin, a **key-gated reader chain** tries Firecrawl → Tavily extract →
  Exa contents → Jina in order (each budgeted ~20–45s, quality-gated ≥100 non-ws
  chars, `WSEARCH_FETCH_CHAIN` reorders/subsets at runtime), then outline-first
  responses, `offset`/`limit` line paging with cursor semantics, 24h page cache.

### Pillar 3 — Source integrity (the web is hostile)
- **Credibility is not diversity** [B]: LLM-search engines cite 37% unique domains yet
  lose to Google on credibility/neutrality/safety — diffusion of sources is *not* a
  quality signal.
- **Generative SEO is an engineered threat** [B]: content influence on generative
  engines can be measured and amplified. Scraped page text is therefore **untrusted
  input**: quoted, sectioned, never favored for being "found first".

→ **Implemented:** cross-engine triangulation (a hit must survive the RRF merge of
  independent engines), junk/spam downranking, SSRF guard (private/loopback rejected),
  and fetched content is surfaced to the agent as data to verify, not truth.

---

## 2. Coding-agent deltas

- **Sliding-window/AST chunking over function-based**; multi-source retrieval for code
  questions (docs, StackOverflow, repos).
- **Evidence = runnable reproduction, not prose**: citations resolve to a URL + section;
  code claims carry a version stamp where possible (SWE-agent's ACI principle [P]).
- **Never assert what you can't verify**: a version/API claim with no fetched source is
  an abstention, not a guess — the agent is told to decline rather than fabricate.

---

## 3. Concrete design (porting to pi)

Pi extension (TypeScript, `pi.registerTool`, in-process), `web` namespace:

| Tool | Role | Evidence |
|---|---|---|
| `web.search` | N-engine fused search (key/endpoint-gated registry: serper, tavily, exa, brave, jina, kagi, you, firecrawl, tinyfish) + freshness window + junk filter | [B] hybrid benchmark, [B] citation-bias study |
| `web.fetch` | structure-aware, outline-first, line-paged page reading (key-gated reader chain: Firecrawl → Tavily extract → Exa contents → Jina) | [P] Sieve, [P] code-chunking study |

- **Surface = exactly these two tools.** No loop, no deferred tools, no eval harness.
  Multi-hop questions are composed at the model level (search → read → verify).
- **Provider pockets are key-gated**: an engine (serper/tavily/exa/brave/jina/kagi/you/firecrawl/tinyfish)
  runs only when its key/endpoint/self-host is configured; a reader backend
  (firecrawl/tavily/exa/jina extract) only when its key is. Adding a provider
  = one registry entry (`engines.ts` / `scrape.ts`) + one key spec (`config.ts`); the
  tools never hardcode a count. `WSEARCH_ENGINES` and `WSEARCH_FETCH_CHAIN` subset/
  reorder at runtime. Search keys double as reader keys where the provider offers both
  (Tavily, Exa). **There are no keyless engines** — every pocket needs a key or a
  self-hosted instance: measured 2026-10, DuckDuckGo (HTTP 202 rate-limit, 3/5
  sequential, 5/5 parallel), Ecosia (Cloudflare 403), Mojeek/Yandex (captcha),
  Marginalia (JS bot-wall + rate-limited public key) and Firecrawl keyless (403 on
  flagged IP ranges, incl. mobile-carrier NAT) all fail without a browser kernel,
  which we do not ship.
- **No spend caps.** Paid engine searches are the user's own bill — the agent is
  not gated. Fetch and the reader chain bound themselves with per-request timeouts;
  there is no session budget, hook, or cap anywhere.
- **Abort UX:** both tools throw on abort → red, terse, like pi's built-ins; an
  already-aborted signal is pre-checked at every request site (engines/scrape) so a
  stale abort never pays for a fetch.
- **Freshness** is provider-doc-aligned: serper `tbs`, tavily `time_range` (not the
  legacy undocumented `days`), exa `startPublishedDate` (now − window), brave
  `freshness` (pd/pw/pm/py), you `freshness`, firecrawl `tbs`;
  the schema description carries the query-date conflict rule (don't day-filter a
  "where in 2026" question). Tavily runs `search_depth: basic` (1 credit, not 2).

---

## 4. Where vendor operational reports sit (explicitly non-evidentiary)

Kept out of the requirements. Listed only as tuning hypotheses for the defaults
(timeouts, cache TTLs, parallelism degrees, snippet sizes); nothing vendor-sourced is a
requirement. Anything needing justification with no [P]/[B] backing is **CANDIDATE**.

---

## 5. Evidence ledger (remaining, above only)

Beyond Browsing · From BM25 to CRAG · Sieve · Source Coverage & Citation Bias ·
CC-GSEO-Bench · Code-chunking study · CodeRAG-Bench (multi-source for code) ·
SWE-agent (ACI principles).

Raw data for the sweep: `research/web_search/corpus.json` (595), `corpus_academic.json`
(228), `sources/arxiv_abstracts.json` (28), `sources/arxiv_academic_v2.json` (21).

---

## 6. Build status

- [x] **M0** — `web.search` + `web.fetch` (hybrid fusion, junk filter, cache,
  section-sliced + line-paged fetch). Shipped, installed, e2e-verified in pi.
- [x] **M4** — abort UX (throw → red, instant); schemas trimmed to 8 knobs total;
  freshness aligned with provider docs (tavily `time_range`, exa `startPublishedDate`,
  tavily `basic` depth); authority + mode-noise removed (pure RRF).
- [x] **M7 — complete researcher removal (2026-10-05)** — the deep-research loop, its
  benchmark (nugget bench + fixtures + A/B harness), its eval harness, its nested-LLM
  layer, its checkpoint store, and its tests were all deleted after the A/B eviction.
  Surface: `web.search` + `web.fetch`, nothing else.
- [x] **M8 — provider expansion + provider-free fetch (2026-10)** — search became a
  pluggable registry: kagi, you, firecrawl, tinyfish pockets added; **every** provider
  contract re-verified against its current API reference (tavily auth moved to
  `Authorization: Bearer`, exa `/contents` has no `contents` wrapper, jina search is
  `s.jina.ai/?q=` + key); Parallel evicted (omp-specific scraping, not a provider);
  keyless engines (ddg/ecosia/mojeek/yandex/marginalia/firecrawl-keyless) evaluated and
  **dropped** — none survive without a browser kernel; `web.fetch` gained the
  loadPage-style local pipeline (UA rotation + bot-wall retry, bounded 429, charset
  decode, raw-text fast path, JS-gate/nav quality gate) so the common case never needs
  a provider.