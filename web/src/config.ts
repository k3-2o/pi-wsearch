/**
 * Config & secrets.
 *
 * Key resolution order (first source that has the key wins):
 *   1. process.env                   : the live environment pi inherited
 *   2. ~/.pi/agent/wsearch/env       : dedicated key file, created/managed by
 *                                       the /websearch login command (0600)
 *   3. the user's actual shell config: detected from $SHELL, never hardcoded:
 *                                       bash → .bashrc/.bash_profile/.profile,
 *                                       zsh → .zshrc/.zprofile, fish →
 *                                       .config/fish/config.fish, nushell →
 *                                       .config/nushell/env.nu
 *
 * Any value from any source may be a `!command`: the leading bang runs the
 * command and uses its stdout as the key (pi's own secret-manager pattern -
 * macOS Keychain, 1Password `op`, etc.). Empty output, timeout, or nonzero
 * exit leaves the key unresolved.
 *
 * The key VALUES are never logged, never returned in tool output, and never
 * serialized. Only presence is disclosed (e.g. "serper: ok"). The `!` command
 * runs once per process (the config is cached).
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WebConfig {
	serperKey?: string;
	tavilyKey?: string;
	exaKey?: string;
	firecrawlKey?: string;
	/** Brave Web Search API key */
	braveKey?: string;
	/** Jina Reader/Search API key (optional for r.jina.ai; required for s.jina.ai) */
	jinaKey?: string;
	/** Kagi v1 Search API key */
	kagiKey?: string;
	/** You.com Web Search API key (env: YDC_API_KEY) */
	youKey?: string;
	/** TinyFish Search API key (free at any balance, but requires X-API-Key) */
	tinyfishKey?: string;
	/** cache dir for web tools (TTL cache json) */
	cacheDir: string;
	/** allow scraping private/loopback addresses (tests only) */
	allowPrivate?: boolean;
	/** WSEARCH_ENGINES: comma list pinning order/subset of search engines */
	searchEngines?: string;
	/** WSEARCH_FETCH_CHAIN: comma list reordering/subsetting the reader backends */
	fetchChain?: string;
}

interface KeySpec {
	id: string;
	key:
		| 'serperKey'
		| 'tavilyKey'
		| 'exaKey'
		| 'firecrawlKey'
		| 'braveKey'
		| 'jinaKey'
		| 'kagiKey'
		| 'youKey'
		| 'tinyfishKey';
	envNames: string[];
}

const SPECS: KeySpec[] = [
	{ id: 'serper', key: 'serperKey', envNames: ['SERPER_API_KEY', 'SERPER_KEY'] },
	{ id: 'tavily', key: 'tavilyKey', envNames: ['TAVILY_API_KEY', 'TAVILY_KEY'] },
	{ id: 'exa', key: 'exaKey', envNames: ['EXA_API_KEY', 'EXA_KEY'] },
	{ id: 'firecrawl', key: 'firecrawlKey', envNames: ['FIRECRAWL_API_KEY', 'FIRECRAWL_KEY'] },
	{ id: 'brave', key: 'braveKey', envNames: ['BRAVE_API_KEY', 'BRAVE_KEY'] },
	{ id: 'jina', key: 'jinaKey', envNames: ['JINA_API_KEY', 'JINA_KEY'] },
	{ id: 'kagi', key: 'kagiKey', envNames: ['KAGI_API_KEY', 'KAGI_KEY'] },
	{ id: 'you', key: 'youKey', envNames: ['YOUCOM_API_KEY', 'YDC_API_KEY'] },
	{ id: 'tinyfish', key: 'tinyfishKey', envNames: ['TINYFISH_API_KEY', 'TINYFISH_KEY'] },
];

/** Known provider pockets (id, display label, canonical env name + aliases) for the UI. */
export interface ProviderInfo {
	id: string;
	label: string;
	envName: string;
	aliases: string[];
}

const PROVIDER_LABELS: Record<string, string> = {
	serper: 'Serper (Google)',
	tavily: 'Tavily',
	exa: 'Exa',
	firecrawl: 'Firecrawl',
	brave: 'Brave',
	jina: 'Jina',
	kagi: 'Kagi',
	you: 'You.com',
	tinyfish: 'TinyFish',
};

export const PROVIDERS: ProviderInfo[] = SPECS.map((s) => ({
	id: s.id,
	label: PROVIDER_LABELS[s.id] ?? s.id,
	envName: s.envNames[0],
	aliases: s.envNames.slice(1),
}));

/** Shell-config files per shell binary name (exact match on $SHELL basename). */
export const SHELL_FILES: Record<string, string[]> = {
	zsh: ['.zshrc', '.zprofile'],
	bash: ['.bashrc', '.bash_profile', '.profile'],
	sh: ['.profile'],
	dash: ['.profile'],
	fish: ['.config/fish/config.fish'],
	nu: ['.config/nushell/env.nu'],
	nushell: ['.config/nushell/env.nu'],
};
const DEFAULT_SHELL_FILES = SHELL_FILES.bash;

/** Which shell config files to try, from $SHELL (falls back to bash). */
export function shellConfigFiles(shell = process.env.SHELL): string[] {
	if (!shell) return DEFAULT_SHELL_FILES;
	const base = shell.split('/').pop()?.toLowerCase() ?? '';
	return SHELL_FILES[base] ?? DEFAULT_SHELL_FILES;
}

function unquote(v: string): string {
	let s = v.trim();
	if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
		s = s.slice(1, -1);
	}
	return s;
}

/**
 * Parse one `KEY=VALUE`-style line from any common shell format:
 *   bash/zsh  `export KEY="v"` or `KEY=v`
 *   fish      `set -gx KEY v`
 *   nushell   `$env.KEY = "v"`
 */
export function parseEnvLine(line: string): [string, string] | null {
	const t = line.trim();
	if (!t || t.startsWith('#')) return null;
	let m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
	if (m) return [m[1], unquote(m[2])];
	m = /^\s*set\s+-gx\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(t);
	if (m) return [m[1], unquote(m[2])];
	m = /^\s*\$env\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
	if (m) return [m[1], unquote(m[2])];
	return null;
}

/** Parse a KEY=VALUE file into a map (first occurrence wins). */
export function parseEnvText(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const pair = parseEnvLine(raw);
		if (pair && !(pair[0] in out)) out[pair[0]] = pair[1];
	}
	return out;
}

function readEnvText(path: string): Record<string, string> {
	try {
		if (!existsSync(path)) return {};
		return parseEnvText(readFileSync(path, 'utf8'));
	} catch {
		return {};
	}
}

/**
 * Resolve a stored value. A leading `!` runs the rest as a shell command and
 * uses its stdout (pi's secret-manager pattern). Runs once per process because
 * the config is cached.
 */
export function resolveStoredValue(raw: string): string | undefined {
	const v = raw.trim();
	if (!v.startsWith('!')) return v.length > 4 ? v : undefined;
	const cmd = v.slice(1).trim();
	if (!cmd) return undefined;
	try {
		const r = spawnSync('sh', ['-c', cmd], {
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 5_000,
			killSignal: 'SIGTERM',
		});
		if (r.status !== 0 || r.signal || !r.stdout) return undefined;
		const out = r.stdout.toString().trim();
		return out.length > 4 ? out : undefined;
	} catch {
		return undefined;
	}
}

// Path to the dedicated key file (alongside the cache, in the wsearch dir).
export function keyFilePath(): string {
	const base = process.env.WSEARCH_CACHE_DIR ?? join(homedir(), '.pi', 'agent', 'wsearch');
	return join(base, 'env');
}

let cached: WebConfig | undefined;
/** Where each provider's key resolved from (for the status UI). */
let origins: Record<string, 'env' | 'wsearch' | 'shell'> = {};
/** Test hook: clear the cached config so the next getConfig() re-reads. */
export function resetConfigCache(): void {
	cached = undefined;
	origins = {};
}

export function getConfig(): WebConfig {
	if (cached) return cached;
	const env = process.env;

	// dedicated key file first, then the user's detected shell config
	// (first occurrence wins within each; file order respected)
	const keysFile = readEnvText(keyFilePath());
	const shell = {} as Record<string, string>;
	for (const f of shellConfigFiles()) {
		const map = readEnvText(join(homedir(), f));
		for (const [k, v] of Object.entries(map)) if (!(k in shell)) shell[k] = v;
	}

	const find = (spec: KeySpec): string | undefined => {
		for (const name of spec.envNames) {
			if (env[name] && env[name].length > 4) {
				const v = resolveStoredValue(env[name]);
				if (v) {
					origins[spec.id] = 'env';
					return v;
				}
			}
			if (keysFile[name]) {
				const v = resolveStoredValue(keysFile[name]);
				if (v) {
					origins[spec.id] = 'wsearch';
					return v;
				}
			}
			if (shell[name]) {
				const v = resolveStoredValue(shell[name]);
				if (v) {
					origins[spec.id] = 'shell';
					return v;
				}
			}
		}
		return undefined;
	};

	cached = {
		serperKey: find(SPECS[0]),
		tavilyKey: find(SPECS[1]),
		exaKey: find(SPECS[2]),
		firecrawlKey: find(SPECS[3]),
		braveKey: find(SPECS[4]),
		jinaKey: find(SPECS[5]),
		kagiKey: find(SPECS[6]),
		youKey: find(SPECS[7]),
		tinyfishKey: find(SPECS[8]),
		cacheDir: process.env.WSEARCH_CACHE_DIR ?? join(homedir(), '.pi', 'agent', 'wsearch'),
		allowPrivate: process.env.WSEARCH_ALLOW_PRIVATE === '1',
		// knobs resolve from the same 3 sources as keys: env → wsearch/env → shell
		searchEngines: (env.WSEARCH_ENGINES ?? keysFile.WSEARCH_ENGINES ?? shell.WSEARCH_ENGINES)?.trim() || undefined,
		fetchChain:
			(env.WSEARCH_FETCH_CHAIN ?? keysFile.WSEARCH_FETCH_CHAIN ?? shell.WSEARCH_FETCH_CHAIN)?.trim() || undefined,
	};
	return cached;
}

/** Which of the recognized secret names are present (values never exposed). */
export function keyStatus(): Record<string, boolean> {
	const c = getConfig();
	return {
		serper: !!c.serperKey,
		tavily: !!c.tavilyKey,
		exa: !!c.exaKey,
		firecrawl: !!c.firecrawlKey,
		brave: !!c.braveKey,
		jina: !!c.jinaKey,
		kagi: !!c.kagiKey,
		you: !!c.youKey,
		tinyfish: !!c.tinyfishKey,
	};
}

/** Where each provider's key resolved from (values never exposed). */
export function keyOrigins(): Record<string, 'env' | 'wsearch' | 'shell'> {
	getConfig();
	return { ...origins };
}

/** Sanitize an error message so it can never leak credentials/headers. */
export function sanitizeError(e: unknown): string {
	let msg = e instanceof Error ? e.message : String(e);
	const cfg = getConfig();
	for (const c of [
		cfg.serperKey,
		cfg.tavilyKey,
		cfg.exaKey,
		cfg.firecrawlKey,
		cfg.braveKey,
		cfg.jinaKey,
		cfg.kagiKey,
		cfg.youKey,
		cfg.tinyfishKey,
	]) {
		if (c && c.length > 8) msg = msg.split(c).join('***');
	}
	// also scrub anything that looks like a bearer/sk- key
	msg = msg.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|X-API-KEY[^\n]*)\b/gi, '***');
	return msg.slice(0, 240);
}
