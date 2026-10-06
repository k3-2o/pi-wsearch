/**
 * Key-file management for /websearch. The dedicated wsearch/env file is the
 * only file this extension ever writes; writes are atomic and always 0600,
 * and only the target provider's lines are touched.
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
	disabledFlagPath,
	type ProviderInfo,
} from './config';

const PROVIDER_IDS = PROVIDER_LIST.map((p) => p.id);

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

function mutateFile(mutations: Map<string, string | undefined>): void {
	const path = keyFilePath();
	const lines = readFile(path).split('\n');
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

const allNamesRemoved = (p: ProviderInfo): Map<string, string | undefined> =>
	new Map(providerNames(p).map((n) => [n, undefined]));

/** Write or replace a provider's key in the dedicated env file. */
export function writeKey(p: ProviderInfo, value: string): void {
	const mutations = allNamesRemoved(p);
	mutations.set(p.envName, value.trim());
	mutateFile(mutations);
}

/** Remove a provider's key lines from the dedicated env file. */
export function removeKey(p: ProviderInfo): void {
	mutateFile(allNamesRemoved(p));
}

export function statusText(): string {
	const st = keyStatus();
	const origins = keyOrigins();
	const armed = PROVIDER_IDS.filter((id) => st[id]);
	const dormant = PROVIDER_IDS.filter((id) => !st[id]);
	const cfg = getConfig();
	const lines: string[] = [];
	lines.push(`web tools: ${existsSync(disabledFlagPath()) ? 'OFF' : 'ON'}`);
	lines.push(`web search: ${PROVIDER_IDS.length} pockets`);
	lines.push(
		armed.length ? `  armed:   ${armed.map((id) => `${id} ✓(${origins[id] ?? '?'})`).join(', ')}` : '  armed:   (none)',
	);
	lines.push(`  dormant: ${dormant.length ? dormant.join(', ') : '(none)'}`);
	const chain = cfg.fetchChain ? cfg.fetchChain.replace(/,/g, ', ') : 'firecrawl, tavily, exa, jina';
	lines.push(`  fetch:   local → ${chain}`);
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
