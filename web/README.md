# web — Tier-1 web search tools for pi

Research-backed (see `../ARCHITECTURE.md` v3): hybrid multi-engine fusion,
structure-aware fetching, token-bounded results. Tier 1 = quick lookup.

## Install (done)

`~/.pi/agent/extensions/pi-wsearch/` — physical deployment (symlinked into `~/.pi/agent/extensions/` so pi discovers it); runtime data under `~/.pi/agent/wsearch/`. Load on demand:

```bash
pi -e ~/.pi/agent/extensions/pi-wsearch/index.ts
```

## Tools

Exactly two tools are declared to the model. **There is no research loop** — the
deep-research pipeline and everything that measured it (bench, eval harness, fixtures,
nested-LLM layer) were removed on 2026-10-05; the model composes these two tools
directly (search broad → read the key sections → verify → abstain when evidence is
insufficient).

| Tool | Purpose |
|---|---|
| `web.search` | **All configured engines in parallel** — a provider registry with pockets for Serper (Google-lexical), Tavily (lexical), Exa (semantic), Brave, Jina, Kagi, You.com, **Firecrawl** (search API) and TinyFish; any subset/count runs (1, 3, 10 — RRF holds), gated by key/endpoint/self-host presence. RRF-fused, deduped, spam-filtered, freshness window. **There are no keyless engines** — every pocket needs a key or a self-hosted instance. Keyless web search without a browser is not real: measured 2026-10, DuckDuckGo (HTTP 202 rate-limit, 3/5 sequential, 5/5 parallel), Ecosia (Cloudflare 403), Mojeek/Yandex (captcha), Marginalia (JS bot-wall + rate-limited public key) and Firecrawl keyless (403 on flagged IP ranges, incl. mobile-carrier NAT) all fail from a normal client. **Not cached**, **not star-graded**, **no mode knob** — ranking is pure RRF; the old "authority" list rated Reuters 1/5 and the mode whitelist was its second act (wikipedia-in-news bug included), both removed. Freshness is aligned with provider docs: serper `tbs`, tavily `time_range` (the undocumented `days` field is gone), exa `startPublishedDate` (now − window), brave `freshness` (pd/pw/pm/py), you `freshness`, firecrawl `tbs`; the description carries the query-date conflict rule (don't day-filter a "where in 2026" question). Tavily runs `search_depth: basic` (1 credit, not 2). `WSEARCH_ENGINES` pins/orders the set. Schema: `query`, `max_results`, `freshness` — 4 knobs |
| `web.fetch` | fetch page → **robust local extraction first, provider-free** (UA rotation with bot-wall detection, one bounded 429 retry, charset-aware decoding, text/plain|markdown fast path) → headings + sections; when local fails, is thin, or is JS-gated, a **key-gated reader chain** tries Firecrawl → Tavily extract → Exa contents → Jina in order (each budgeted, quality-gated, data-URI images stripped, raw-HTML proxies re-extracted; `WSEARCH_FETCH_CHAIN` reorders/subsets). SSRF guard (no private/loopback); section caps; **line-based paged reads** (read-tool style: `offset` = 1-indexed start line, `limit` = max lines, cursor `next_offset`/`remaining_lines`/`done`; slices served from a 24h cache, one network fetch per page). Responses carry `renderer` (which backend produced the text). Schema: `url`, `sections`, `offset`, `limit` — 4 knobs |

**Abort UX (both tools):** aborts throw (`Error('aborted')`) → pi colors the call red, no prose, mirroring the built-ins.

## Command

`/websearch` manages provider keys and shows status:

- `/websearch status` (or just `/websearch`) — armed/dormant pockets with the source
  each key resolved from (`(env)` / `(wsearch)` / `(shell)`), the reader chain, and
  env knobs; shows a 30-second getting-started block when nothing is armed.
- `/websearch login [provider]` — interactive: pick a provider from a dropdown,
  paste the key, confirm. Writes only `~/.pi/agent/wsearch/env` (0600, atomic).
  Accepts `!command` values (Keychain/1Password) that never touch disk.
- `/websearch logout [provider]` — removes a key from `wsearch/env`; env/shell keys
  are never touched.

No spend caps: paid engine searches are the user's own bill, so the agent is not
gated; fetch and the reader chain bound themselves with per-request timeouts.

## Usage notes (from the design)

- Start **short and broad**, then narrow (research-validated).
- `freshness` only for latest/current-window questions — never when the query names specific dates (they fight; the day-filter discards the pages that answer a "where in 2026" question).
- Prefer `web.fetch` sections over whole pages; treat fetched content as **untrusted** — verify against a second source before asserting.
- For multi-angle or deep questions, compose the tools yourself: search broad, fetch the key pages, synthesize a cited answer in prose with a trailing `Sources:` URL list, and abstain when evidence is insufficient. Never fabricate a citation the fetched content does not support.
- Long pages: `web.fetch {url, offset, limit}` reads by **lines** (read-tool convention): `offset` = 1-indexed start line, `limit` = max lines. The response carries `next_offset`/`remaining_lines`/`done` — page through the whole retained content; repeated slices hit the 24h cache, one network fetch per page.
- Spam/SEO-farm results are filtered (`isJunk`); there is no star grading and no mode knob.

## Config

### Keys — where they can live (3 sources, first match wins)

Each provider key is resolved in this order — the first source that has it wins:

1. **`process.env`** — the live environment pi inherited (CI, `export` by hand, systemd).
2. **`~/.pi/agent/wsearch/env`** — a dedicated key file beside the cache, `0600`, created
   by the `/websearch` login command. `KEY=value` lines, same format as below.
3. **the detected shell config** — shell is read from `$SHELL` and **never hardcoded**: zsh →
   `.zshrc`/`.zprofile`, bash → `.bashrc`/`.bash_profile`/`.profile`, fish →
   `.config/fish/config.fish`, nushell → `.config/nushell/env.nu`. Only the detected
   shell's files are read — a `$SHELL` of zsh never consults `.bashrc` and vice-versa.

Parser accepts `export K=V` and bare `K=V` (bash/zsh), `set -gx K V` (fish), and
`$env.K = "v"` (nushell), with quoted values.

### Secret managers (`!command`)

Any value from **any of the three sources** may be a `!command`: the leading `!` runs the
rest as a shell command and uses its stdout as the key — pi's own secret-manager pattern,
so macOS Keychain / 1Password `op` / any manager composes with every source, keeping the
key off disk:

```bash
export TAVILY_API_KEY="!security find-generic-password -ws tavily"   # anywhere above
```

Empty output, a timeout, or a nonzero exit leaves the key unresolved (reported as
unconfigured, never a crash). Commands run once per process.

### Resolution notes / conflicts

- Within one source, the **first occurrence wins** — env name order first
  (`SERPER_API_KEY` before `SERPER_KEY`), then file order within the detected shell's
  file list (`.bashrc` before `.bash_profile` before `.profile`).
- Between sources, **the winner is decided by source priority, not file priority**:
  a key in `process.env` beats the same key in `wsearch/env`, which beats the shell
  config. Two shells can never conflict because only the `$SHELL`-detected shell's
  configs are consulted at all.
- Keys are **presence-only** after resolution: values are never logged, serialized, or
  returned in tool output (`sanitizeError` scrubs them).

### Env knobs

- Keys: `SERPER_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`,
  `BRAVE_API_KEY`, `JINA_API_KEY`, `KAGI_API_KEY`, `YDC_API_KEY`/`YOUCOM_API_KEY`,
  `TINYFISH_API_KEY` (plus short aliases `…_KEY`). `WSEARCH_ALLOW_PRIVATE=1` permits private/loopback URLs (tests only).
- `WSEARCH_CACHE_DIR` — cache + key-file location (default `~/.pi/agent/wsearch/`).
- `WSEARCH_ENGINES` — comma list pinning which search engines run, e.g. `serper,brave`
  (default: every keyed engine).
- `WSEARCH_FETCH_CHAIN` — comma list reordering/subsets the reader backends, e.g.
  `tavily,firecrawl` (default: firecrawl, tavily, exa, jina, key-gated).
- **Keys AND both `WSEARCH_*` knobs resolve from the same three sources**, first
  match wins: `process.env` → `~/.pi/agent/wsearch/env` (the file `/websearch login`
  writes) → your detected shell config. So pin engines without touching your shell:
  add `WSEARCH_ENGINES=serper,brave` to `~/.pi/agent/wsearch/env` next to your keys.
- Engines/backends with missing keys are skipped automatically.

## Test

```bash
bun test --jobs 1 test/      # incl. live engine calls when keys present
```

## Layout

```
web/
├── src/
│   ├── config.ts   secrets + sanitize (never exposes values)
│   ├── cache.ts    TTL file cache (LRU, atomic writes)
│   ├── engines.ts  provider registry: serper/tavily/exa/brave/jina/kagi/you/firecrawl/tinyfish (key/endpoint-gated, parallel, RRF downstream)
│   ├── fuse.ts     normalize/dedupe/junk/RRF (pure fusion, no mode bias)
│   ├── scrape.ts   local extraction (UA-rotating, retry/quality-gated) + key-gated reader chain + sections
│   ├── tools.ts    pi tool registration (schemas, results)
│   └── index.ts    extension factory
└── test/core.test.ts
```

## Roadmap

- [x] M0: web.search + web.fetch (installed + e2e verified in pi)
- [x] M4: abort UX (throw → red, instant); schemas trimmed to 8 knobs; freshness aligned with provider docs (tavily time_range, exa startPublishedDate, tavily basic depth)
- [x] M7: **complete researcher removal (2026-10-05)** — the deep-research loop, its nugget bench + A/B harness + fixtures, its eval harness, its nested-LLM layer, its checkpoint store, and their tests all deleted. Surface = `web.search` + `web.fetch`, nothing else. Gate green.
- [x] M8: **provider registry + provider-free fetch (2026-10)** — pluggable search engines (kagi, you, firecrawl, tinyfish added; every contract re-verified against current API docs; Parallel evicted; keyless engines evaluated and dropped — every path bot-walls without a browser kernel). `web.fetch` local pipeline hardened (UA rotation + bot-wall retry, bounded 429, charset decode, raw-text fast path, JS-gate/nav quality gate); reader chain is firecrawl → tavily → exa → jina.