/** Entry: registers web.search + web.fetch (wiring lives in tools.ts). */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerWebTools, registerWebCommand } from './src/tools';

export default function (pi: ExtensionAPI) {
	registerWebTools(pi);
	registerWebCommand(pi);
}
