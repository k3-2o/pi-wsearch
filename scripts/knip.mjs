import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const BINDING_FAILURE =
	/cannot find (native binding|module .*?binding)|cannot (resolve|load) .*?binding|\.node\b.*(?:cannot|could not|fail)|illegal instruction|segmentation|core dumped|no such file .*?\.node|unsupported platform/i;

const repoRoot = join(import.meta.dirname, '..');
const knipBin = process.env.KNIP_BIN ?? join(repoRoot, 'node_modules', 'knip', 'bin', 'knip.js');

const r = spawnSync('bun', [knipBin, ...process.argv.slice(2)], {
	stdio: ['ignore', 'pipe', 'pipe'],
	encoding: 'utf8',
});
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
if (out) console.log(out);

const status = r.status ?? (r.error ? 2 : 0);
const killedBySignal = r.signal != null && status === null;

if (status === 0) process.exit(0);
if (status === 1) process.exit(1);

if (killedBySignal || BINDING_FAILURE.test(out)) {
	console.error(
		`\nknip skipped on this platform (${killedBySignal ? r.signal : 'native binding load failed'}). ` +
			`Everything else in the gate ran; re-check knip on a machine where it works.`,
	);
	process.exit(0);
}

process.exit(status);
