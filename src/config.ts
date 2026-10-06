/**
 * Key sources, in order (first hit wins): process.env → the dedicated
 * ~/.pi/agent/wsearch/env file → the user's detected shell config. Any value
 * may be `!command` (runs once per process; stdout = key). Values are never
 * logged, returned, or serialized.
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
	braveKey?: string;
	jinaKey?: string;
	kagiKey?: string;
	youKey?: string;
	tinyfishKey?: string;
	cacheDir: string;
	allowPrivate?: boolean;
	searchEngines?: string;
	fetchChain?: string;
}

export type ProviderKey =
	| 'serperKey'
	| 'tavilyKey'
	| 'exaKey'
	| 'firecrawlKey'
	| 'braveKey'
	| 'jinaKey'
	| 'kagiKey'
	| 'youKey'
	| 'tinyfishKey';

interface KeySpec {
	id: string;
	key: ProviderKey;
	envNames: string[];
}

export const SPECS: KeySpec[] = [
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

const SHELL_FILES: Record<string, string[]> = {
	zsh: ['.zshrc', '.zprofile'],
	bash: ['.bashrc', '.bash_profile', '.profile'],
	sh: ['.profile'],
	dash: ['.profile'],
	fish: ['.config/fish/config.fish'],
	nu: ['.config/nushell/env.nu'],
	nushell: ['.config/nushell/env.nu'],
};
const DEFAULT_SHELL_FILES = SHELL_FILES.bash;

export function shellConfigFiles(shell = process.env.SHELL): string[] {
	if (!shell) return DEFAULT_SHELL_FILES;
	const base = shell.split('/').pop()?.toLowerCase() ?? '';
	return SHELL_FILES[base] ?? DEFAULT_SHELL_FILES;
}

// A '#' starts a comment only at a word boundary, outside quotes: 'K=a#b'
// keeps the hash; 'K=a # comment' drops it (runs before unquoting).
function stripComment(v: string): string {
	let inS = false;
	let inD = false;
	for (let i = 0; i < v.length; i++) {
		const c = v[i];
		if (c === '\\' && (inS || inD)) i++;
		else if (c === "'" && !inD) inS = !inS;
		else if (c === '"' && !inS) inD = !inD;
		else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(v[i - 1] as string))) return v.slice(0, i);
	}
	return v;
}

function unquote(v: string): string {
	let s = stripComment(v).trim();
	if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
		s = s.slice(1, -1);
	}
	return s;
}

export function parseEnvLine(line: string): [string, string] | null {
	const t = line.trim();
	if (!t || t.startsWith('#')) return null;
	let m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
	if (m) return [m[1], unquote(m[2])];
	m = /^\s*set\s+(?:-gx|-x)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(t);
	if (m) return [m[1], unquote(m[2])];
	m = /^\s*\$env\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
	if (m) return [m[1], unquote(m[2])];
	return null;
}

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

export function keyFilePath(): string {
	return join(wsearchDir(), 'env');
}

export function disabledFlagPath(): string {
	return join(wsearchDir(), 'off');
}

function wsearchDir(): string {
	return process.env.WSEARCH_CACHE_DIR ?? join(homedir(), '.pi', 'agent', 'wsearch');
}

let cached: WebConfig | undefined;
let origins: Record<string, 'env' | 'wsearch' | 'shell'> = {};
export function resetConfigCache(): void {
	cached = undefined;
	origins = {};
}

// !command resolution is synchronous (spawnSync, 5s each, once per process).
export function getConfig(): WebConfig {
	if (cached) return cached;
	const env = process.env;

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
		cacheDir: process.env.WSEARCH_CACHE_DIR ?? join(homedir(), '.pi', 'agent', 'wsearch'),
		allowPrivate: process.env.WSEARCH_ALLOW_PRIVATE === '1',
		searchEngines: (env.WSEARCH_ENGINES ?? keysFile.WSEARCH_ENGINES ?? shell.WSEARCH_ENGINES)?.trim() || undefined,
		fetchChain:
			(env.WSEARCH_FETCH_CHAIN ?? keysFile.WSEARCH_FETCH_CHAIN ?? shell.WSEARCH_FETCH_CHAIN)?.trim() || undefined,
	};
	// iterate the catalog keyed on spec.key: a SPECS reorder can never mis-map keys
	for (const spec of SPECS) cached[spec.key] = find(spec);
	return cached;
}

export function keyStatus(): Record<string, boolean> {
	const c = getConfig();
	const out: Record<string, boolean> = {};
	for (const spec of SPECS) out[spec.id] = !!c[spec.key];
	return out;
}

export function keyOrigins(): Record<string, 'env' | 'wsearch' | 'shell'> {
	getConfig();
	return { ...origins };
}

export function sanitizeError(e: unknown): string {
	let msg = e instanceof Error ? e.message : String(e);
	const cfg = getConfig();
	for (const spec of SPECS) {
		const secret = cfg[spec.key];
		if (secret && secret.length > 8) msg = msg.split(secret).join('***');
	}
	msg = msg.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|X-API-KEY[^\n]*)\b/gi, '***');
	return msg.slice(0, 240);
}
