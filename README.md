# pi-wsearch: web tools for pi

## Not the web tools you've used

### web.search

**One search, many judges.** Most web tools hand you a single engine's
ranking. `web.search` runs every engine you've configured in parallel and
merges their results by reciprocal rank fusion (RRF). A hit only earns its
place by surviving several independent judgments. The response shows how
many: `← 3 engines agree` means three separate indexes ranked that page.
Agreement is the spam defense; generative-SEO can stuff one index, not three.

**Pick your engines.** Nine are supported; three or four is plenty. Use
whatever keys you have, even one, because what follows doesn't depend on how
many engines answer:

- **Rare strings match literally.** `pgvector`, CVE numbers, error codes match
  as exact words, not fuzzy prose.
- **Junk is downranked, not censored.** Known junk domains and thin snippets
  lose points at scoring time.
- **Same page, one entry.** Tracking-param variants and near-duplicate titles
  collapse into one row.
- **Two results per domain, max.** One site's SEO army can't flood the
  answers.

**Supported providers:** Serper, Tavily, Exa, Brave, Jina, Kagi, You.com,
Firecrawl, TinyFish

### web.fetch

**Fetch reads a map, not a dump.** Most web tools hand you raw HTML and tell
you to find the signal. `web.fetch` breaks any page into an outline of every
section and answers by number: `{url, sections: [0, 3]}` fetches just two
sections of the fetched page. The agent surveys the map, picks what matters,
and reads only those. No
full reads, no 40 KB dumps. Sections over 3,000 characters split into
addressable continuation entries (`Section (cont. 1)`), so no tail is ever
unreachable; pages that overflow are capped; the final response is clipped.
Every cut is marked — nothing is silently lost.

**Reads are free.** Page parsing is built in, nothing billed per read, no key
required. Real headings become the map, TOC echoes get dropped, so reads come
back as clean as a paid one at zero cost. Paid readers only step in for
JavaScript heavy pages or when the local read fails.

**Tracking links cache as one page.** `?utm_source=…` variants of the same URL
share one 24 hour cache entry. Faster repeats, smaller disk.

**Guarded against your localhost.** A fetched page can't aim the agent at
your own machine: private and loopback addresses (hex encoded, shorthand, and
mapped IPv6 forms included) are rejected before any request is made.

**Distrust is the default.** The agent is prompted to treat fetched content
as untrusted input: a claim only becomes a verdict after a second source
corroborates it.

**Optional readers:** Firecrawl, Tavily, Exa, Jina, fallback only

## Install

From npm:

```
pi install npm:pi-wsearch
```

Or from git:

```
pi install git:github.com/k3-2o/pi-wsearch
```

Either way pi picks up the package on next start and registers `web.search`,
`web.fetch`, and the `/websearch` command. To try it once without installing:

```
pi -e npm:pi-wsearch
```

## Keys

Search needs at least one provider key; fetch needs none. Two ways to set one:

- **In your shell.** Export it in the terminal session running pi, or park it
  in your shell config. The extension reads `.zshrc`, `.zprofile`, `.bashrc`,
  `.profile`, fish config, and nushell env based on your `$SHELL` at startup,
  so a key in any of those is discovered on its own.
- **Via `/websearch`.** Pick a provider from the list, paste the key. It's
  written to `~/.pi/agent/wsearch/env` with 0600 permissions.

Either place accepts a `!command` value, so the key can come from Keychain or
1Password at use time and never sit on disk. Session env wins over the file,
the file over shell config. `/websearch` shows which providers are armed and
which are dormant. No keys yet? Tavily, Exa, Firecrawl, and TinyFish all have
free tiers.

## Commands


One command, five subcommands:

| Command | Does |
|---|---|
| `/websearch` | Status: what's armed, what's dormant, where each key lives. |
| `/websearch login [provider]` | Store a key: pick from the provider list, paste it, confirm. Accepts `!command` values. |
| `/websearch logout [provider]` | Remove a key from `wsearch/env`. Keys set in your shell or env are reported, but can't be removed from here. |
| `/websearch off` | Hide both tools from the agent until you turn them back on. |
| `/websearch on` | Bring them back. |

> [!NOTE]
> Two knobs also live in `wsearch/env` (or your shell env, same precedence as
> keys). `WSEARCH_ENGINES=tavily,exa` makes search use only Tavily and Exa,
> with Tavily consulted first. `WSEARCH_FETCH_CHAIN=tavily,jina` makes failed
> reads try Tavily first, then Jina, skipping the rest.

## Quick start

1. Get a key from any provider: Tavily, Exa, and Firecrawl have free tiers.
2. Set it one of three ways:

   ```
   /websearch login            # pick a provider, paste the key
   /websearch login tavily     # or name it directly
   export TAVILY_API_KEY=...   # or just the terminal session
   ```

   Shell config works too (.zshrc, .bashrc, fish config): park the export
   there and the extension finds it on startup.
3. Verify:

   ```
   /websearch
   ```

   Your provider should appear under `armed:`.
4. Ask the agent something current:

   > What's the current Node.js LTS version?

   It will `web.search` it, `web.fetch` the answer's page by section, and
   cite where each claim came from.

## License

MIT

