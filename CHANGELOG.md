# Changelog

## 0.4.0 (2026-10-17)

### Fetch

- Local extraction runs over a real tree (parse5 + htmlparser2) instead of
  regex over markup: malformed HTML recovers per spec, entities decode through
  text nodes, escaped markup survives as literal text, and pre/tables/lists/
  math keep their structure. Titles are entity-decoded and no longer echo into
  the body text; the published-date lookup walks JSON-LD properly.

### Fixes

- The collapsed-result hint (`… N more lines, ctrl+o to expand`) renders
  uniformly dim in both tools instead of half bold, half dim. The hint key
  follows user remaps and falls back to `ctrl+o` when the extension can't see
  pi's keybinding manager (no more phantom double-space).

## 0.3.2 (2026-10-17)

### Search

- Results are map-first: a compact engines line, a TOC of every hit, then one
  short entry per hit with the URL, date, and corroboration. The TOC is the
  collapsed default; entries expand on demand.
- Display cleanup: snippets and titles are scrubbed of escapes, headings,
  table pipes, timecodes, counts, and citation links; stray punctuation is
  normalized.

## 0.3.1 (2026-10-13)

### Search

- Per-hit corroboration detail replaces the bare agreement count:
  `⇐ serper#1, exa#2, you#4` shows where each engine placed the hit;
  single-engine hits render `⇐ engine only (single-engine: unverified)`.
  `engineRanks` is exposed in `structuredContent` results too.

### Fetch

- Reader-markdown cleanup for news pages: standalone photo credits
  (REUTERS/, AP Photo/, Getty Images), carousel “Item N of M” markers, video
  durations (0:48) and relative-time chips (`* 1 hour ago`) are stripped
  (whole-line rules only — prose mentioning a credit survives untouched).
- Reader output that is a 404/not-found template (≤500 chars + classic
  phrasing, e.g. firecrawl’s “We can’t find that page” on a walled URL) is
  rejected and the chain advances to the next backend instead of ending on a
  stub.

## 0.3.0 (2026-10-12)

### Security

- **SSRF via redirect: fixed.** Local fetch follows redirects by hand
  (`redirect: 'manual'`) and re-validates every hop against the
  private/loopback gates — a hostile page can no longer 302 the agent at its
  own machine (probe: public page → 302 → 127.0.0.1 used to return the
  internal body; vector incl. cloud metadata 169.254.169.254). Redirect loops
  cap at 8 hops; etag/last-modified conditionals travel with the first hop
  only.
- IPv4-compatible IPv6 shorthand now covered: `[::7f00:1]` (`::127.0.0.1`)
  and `[::a00:1]` (`10.0.0.1`) are rejected like their `::ffff:` mapped
  forms.

### Correctness

- `sliceSections` outline stays lockstep with sections: depth-5/6 headings no
  longer vanish from `outlineNames`, so `web.fetch` section indices never
  label the wrong content on deep-heading pages.
- `normalizeUrl` stops case-folding the path and stops re-serializing query
  encoding: `/README` vs `/readme` and `?q=a%2Fb` vs `?q=a/b` are distinct
  URLs again (fetch cache keys, fuse dedupe, fetchtrace attribution).
- `normalizeHitDate`: “X months ago” renders as months, not minutes.
- Cache: non-numeric `exp` entries (corrupt store) count as expired — never
  served fresh, never served stale with `~NaNh old`.
- Abort = throw: `web.fetch` pre-checks the signal at entry and re-checks
  after scraping, so an interrupt is never masked by the stale-if-error
  reserve.

### UX / hygiene

- `web.search` says why it returned nothing: keys exist but every engine is
  temp-banned (HTTP 401/402/403) is its own message, not “no keys
  configured”.
- `fb.watch` joins the junk list.
- Dead code removed (`ABORT_ERROR_LOCAL`, `fmtSize`); vacuous `completed`
  flag deleted from the abort test; `var snapTs` block-scoped.
- SSRF gates moved to `src/urls.ts` (import-free leaf) so transport shares
  them without a cycle.

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
