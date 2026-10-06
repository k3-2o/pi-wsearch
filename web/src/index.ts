/**
 * web search extension: Tier 1 (quick lookup): web.search + web.fetch.
 * Research-backed design (see ARCHITECTURE.md v2): hybrid multi-engine fusion,
 * structure-aware fetching, token-bounded results.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerWebTools, registerWebCommand } from './tools';

export default function (pi: ExtensionAPI) {
	registerWebTools(pi);
	registerWebCommand(pi);
}
