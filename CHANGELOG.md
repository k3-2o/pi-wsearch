# Changelog

## 0.2.2 (2026-10-08)

### Fetch

- Outline renders as an indexed map: `indices - 0 - N sections` header with `- *N*` entries (slanted in the TUI); sections are addressed by these numbers.

### Fixed

- Private/loopback 404s skip the Wayback availability lookup: fail fast, no live call archive.org can never answer.

## 0.2.0 (2026-10-08)

### Search

- Junk list covers social-syndication mirrors; numeric `status|thread/<id>` paths junked on all hosts.
- BM25 lexical rescoring in fuse: single-engine hits reorder near-ties by query overlap.
- URL canonicalization: path case-folding and duplicate-slash collapse.
- `site:` routed to native domain filters (tavily, exa); verbatim for engines with operator support.
- Zero-result recovery: one retry with operators stripped or the rarest term dropped.
- Result titles strip the site-name suffix; dates display when engines provide them.
- `engines_errored` field plus diagnostics line; stable 401/402/403 engines skipped (memo cleared on login/logout).

### Fetch

- GitHub repo/blob URLs serve raw file content under the original URL.
- Tables convert to markdown pipe tables; MathML to TeX; KaTeX span soup dropped.
- Page-wide duplicate-paragraph removal.
- News-page cleanup: photo credits, relative-age fragments, browser nags, ALL-CAPS kickers, `<title>` echoes.
- Cookie-consent and newsletter-signup boilerplate filtered.
- Access-notice pages (HTTP 402 + HTML notice) treated as bot-walls.
- Mojibake detection and repair (UTF-8-as-CP1252).
- Conditional revalidation: ETag/Last-Modified stored; 304 re-marks cached copies fresh.
- Stale-if-error: expired cache entries serve marked `[STALE — ~Nh old]` when live fetch fails.
- Archive fallback: 404 tries the Wayback availability API, marked `[ARCHIVED copy <date>]`. 404-only, never 403-walls.
- Fail-fast on permanent local failures; `r.jina.ai` proxies never enter the reader chain.
- Accept header prefers `text/markdown`.
- Reader chain: jina (keyless opt-in) → tinyfish → firecrawl → tavily → exa → serper → you → kagi (last).
- New reader backends: kagi, tinyfish, serper, you (key-gated, docs-verified).

### Fixed

- Dead engines (401/402/403) no longer drag the search fan-out.
- `/websearch off|on` syncs the active tool set via `pi.setActiveTools()`.
- `splitSection` infinite loop on space-free runs.
- Reader chain no longer spent on dead URLs or proxy URLs.

### Measurement

- Fetch-through ledger (`wsearch/fetchtrace.jsonl`): query, rank, engines, url on first fetch of a search-surfaced URL. Observe-only.
