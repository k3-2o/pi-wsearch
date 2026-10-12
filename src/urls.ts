/** URL facts leaf: normalization (dedupe + cache keys), junk classification,
 * and the SSRF private-host gates (shared by scrape + transport). */

const JUNK_HOSTS = [
	'quora.com',
	'fiverr.com',
	'freelancer.com',
	'tiktok.com',
	'pinterest.com',
	'instagram.com',
	'facebook.com',
	'twitter.com',
	'x.com',
	'twitch.tv',
	'9gag.com',
	'buzzfeed.com',
	'twiscan.com',
	'twstalker.com',
	'unrollnow.com',
	'threadreaderapp.com',
	'nitter.net',
	'upd.dev',
	'fb.watch',
];
const JUNK_TLDS = new Set(['xyz', 'top', 'loan', 'click', 'work', 'gq', 'icu', 'rest', 'cyou']);

const TRACKING_PARAMS = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'fbclid',
	'gclid',
	'ref',
	'ref_src',
	'mc_cid',
	'mc_eid',
	'igshid',
	'spm',
	'scm',
]);

export function hostOf(raw: string): string {
	try {
		return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return '';
	}
}

/** Keeps scheme+port deliberately (http vs https twins are different pages).
 * Path CASE and query ENCODING are preserved verbatim: on case-sensitive hosts
 * `/README` and `/readme` are different resources, and `?q=a%2Fb` is not
 * `?q=a/b`. Folding them would collide fetch cache keys and merge distinct
 * hits in fuse, so the raw query pairs are only filtered and sorted, never
 * re-serialized (URLSearchParams would decode the encoding away). */
export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw);
		const host = u.hostname.toLowerCase().replace(/^www\./, '');
		u.hash = '';
		let q = '';
		if (u.search) {
			const kept = u.search
				.slice(1)
				.split('&')
				.filter(Boolean)
				.filter((pair) => !TRACKING_PARAMS.has(decodeKey(pair)));
			kept.sort((a, b) => (decodeKey(a) < decodeKey(b) ? -1 : decodeKey(a) > decodeKey(b) ? 1 : 0));
			q = kept.join('&');
		}
		const port = u.port ? `:${u.port}` : '';
		const path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
		return `${u.protocol}//${host}${port}${path}${q ? '?' + q : ''}`;
	} catch {
		return raw.toLowerCase();
	}
}

/** Decoded query KEY (for tracking-param matching); malformed stays raw. */
function decodeKey(pair: string): string {
	const key = (pair.split('=')[0] ?? '').trim();
	try {
		return decodeURIComponent(key).toLowerCase();
	} catch {
		return key.toLowerCase();
	}
}

export function isJunk(raw: string): boolean {
	const host = hostOf(raw);
	if (JUNK_HOSTS.some((j) => host === j || host.endsWith('.' + j))) return true;
	const tld = host.split('.').pop() ?? '';
	if (JUNK_TLDS.has(tld)) return true;
	if (/\/(?:status|thread)\/\d+(?:[/?#]|$)/i.test(pathOf(raw))) return true;
	return false;
}

function pathOf(raw: string): string {
	try {
		return new URL(raw).pathname;
	} catch {
		return '';
	}
}

// ── SSRF gates: shared by scrape.ts and transport.ts; this leaf imports ──────
// ── nothing, so both consumers stay cycle-free. ───────────────────────────────

function isPrivateIpv4(ipv4: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

function numericIpv4(host: string): string | null {
	if (!/^[0-9.]+$/.test(host) && !/^0[xX][0-9a-fA-F.]+$/.test(host)) return null;
	const fields = host.split('.');
	if (fields.length > 4) return null;
	const parts: number[] = [];
	for (const f of fields) {
		if (/^0[xX][0-9a-fA-F]+$/.test(f)) parts.push(parseInt(f, 16));
		else if (/^0[0-7]+$/.test(f)) parts.push(parseInt(f, 8));
		else if (/^\d+$/.test(f)) parts.push(Number(f));
		else return null;
	}
	const last = parts[parts.length - 1];
	if (parts.length === 1) {
		if (last >= 2 ** 32) return null;
		return [(last >>> 24) & 0xff, (last >>> 16) & 0xff, (last >>> 8) & 0xff, last & 0xff].join('.');
	}
	if (parts.slice(0, -1).some((n) => n > 255)) return null;
	if (last >= 2 ** (8 * (4 - parts.length + 1))) return null;
	if (parts.length === 2) return [parts[0], 0, 0, last].join('.');
	if (parts.length === 3) return [parts[0], parts[1], (last >>> 8) & 0xff, last & 0xff].join('.');
	return parts.join('.');
}

/** True for loopback/private/link-local numeric literals AND IPv6 forms that
 * embed them (`::ffff:a.b.c.d`, and the `::aabb:ccdd` IPv4-compatible
 * shorthand WHATWG serializes `::127.0.0.1` into). Scope is deliberate:
 * hostnames that merely RESOLVE into private space are out of the threat
 * model — the hostile web points the agent at literals, not at their DNS. */
export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
	if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
	const mapped = /:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
	if (mapped) {
		const [a, b] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
		if (isPrivateIpv4(`${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`)) return true;
	}
	const compat = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
	if (compat) {
		const [a, b] = [parseInt(compat[1], 16), parseInt(compat[2], 16)];
		if (isPrivateIpv4(`${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`)) return true;
	}
	const ipv4 = numericIpv4(h);
	if (ipv4 && isPrivateIpv4(ipv4)) return true;
	if (/^[0-9a-f:]+$/.test(h) && h.includes(':')) {
		if (h.startsWith('::1') || h === '0:0:0:0:0:0:0:1') return true;
		if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
	}
	return false;
}

export function validateUrl(raw: string, allowPrivate = false): URL {
	const u = new URL(raw);
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported protocol: ${u.protocol}`);
	if (!allowPrivate && isPrivateHost(u.hostname)) throw new Error('private/loopback address rejected');
	return u;
}
