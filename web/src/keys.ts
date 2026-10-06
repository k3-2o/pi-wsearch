/**
 * Key-file management + status text for the /websearch command.
 * Pure logic, no pi imports: testable under bun.
 *
 * The dedicated key file (~/.pi/agent/wsearch/env) is the only file this
 * extension ever writes. Writes are atomic (temp + rename) and always 0600.
 * It only touches lines belonging to the target provider's env names -
 * other keys, comments, and unrelated lines are preserved byte-for-byte.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	getConfig,
	keyFilePath,
	keyOrigins,
	keyStatus,
	parseEnvLine,
	PROVIDERS as PROVIDER_LIST,
	type ProviderInfo,
} from './config';

const PROVIDER_IDS = PROVIDER_LIST.map((p) => p.id);

/** Which name(s) identify a provider in the file: canonical + aliases. */
function providerNames(p: ProviderInfo): string[] {
	return [p.envName, ...p.aliases];
}

function readFile(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, 'utf8') : '';
	} catch {
		return '';
	}
}

/**
 * Rewrite the file with a provider's lines replaced/removed, others preserved.
 * @param mutations map of env name -> new value | undefined (undefined = remove)
 */
function mutateFile(mutations: Map<string, string | undefined>): void {
	const path = keyFilePath();
	const lines = readFile(path).split('\n');
	// drop EVERY line whose env name is being mutated (old value, old alias)
	const out = lines.filter((raw) => {
		const pair = parseEnvLine(raw);
		return !pair || !mutations.has(pair[0]);
	});
	let text = out.join('\n');
	const incoming: string[] = [];
	for (const [name, val] of mutations) {
		if (val) incoming.push(`${name}=${val}`);
	}
	if (incoming.length) text = (text.trimEnd() ? text.trimEnd() + '\n' : '') + incoming.join('\n') + '\n';
	writeAtomic(path, text);
}

function writeAtomic(path: string, content: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content, 'utf8');
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** Write or replace a provider's key in the dedicated env file (0600, atomic). */
export function writeKey(p: ProviderInfo, value: string): void {
	const mutations = new Map<string, string | undefined>();
	for (const n of providerNames(p)) mutations.set(n, undefined); // clear all aliases
	mutations.set(p.envName, value.trim());
	mutateFile(mutations);
}

/** Remove a provider's key from the dedicated env file. */
export function removeKey(p: ProviderInfo): void {
	writeKey(p, '');
}

/** Human status block for /websearch status. */
export function statusText(): string {
	const st = keyStatus();
	const origins = keyOrigins();
	const armed = PROVIDER_IDS.filter((id) => st[id]);
	const dormant = PROVIDER_IDS.filter((id) => !st[id]);
	const cfg = getConfig();
	const lines: string[] = [];
	lines.push(`web search: ${PROVIDER_IDS.length} pockets`);
	lines.push(
		armed.length ? `  armed:   ${armed.map((id) => `${id} ✓(${origins[id] ?? '?'})`).join(', ')}` : '  armed:   (none)',
	);
	lines.push(`  dormant: ${dormant.length ? dormant.join(', ') : '(none)'}`);
	const chain = cfg.fetchChain ? cfg.fetchChain.replace(/,/g, ', ') : 'firecrawl, tavily, exa, jina';
	lines.push(`  fetch:   local → ${chain}`);
	// env knobs shown only when set (default: all configured engines / default chain)
	const knobs = [];
	if (cfg.searchEngines) knobs.push(`WSEARCH_ENGINES=${cfg.searchEngines}`);
	if (cfg.fetchChain) knobs.push(`WSEARCH_FETCH_CHAIN=${cfg.fetchChain}`);
	if (knobs.length) lines.push(`  knobs:   ${knobs.join(' · ')}`);
	if (armed.length === 0) {
		lines.push('');
		lines.push('Getting started (30 seconds):');
		lines.push('  1. get one free key; cheapest paths:');
		lines.push('     · tavily    → tavily.com    (1,000 free searches/mo)');
		lines.push('     · exa       → exa.ai        (1,000 free/mo)');
		lines.push('     · firecrawl → firecrawl.dev (1,000 free credits/mo)');
		lines.push('     · tinyfish  → tinyfish.ai   (free at any balance)');
		lines.push('  2. /websearch login, saved to wsearch/env');
		lines.push('  3. run /websearch again; it should appear under "armed"');
	}
	return lines.join('\n');
}
