/** URL facts leaf: normalization (dedupe + cache keys), junk classification. */

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

/** Keeps scheme+port deliberately (http vs https twins are different pages). */
export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw);
		const host = u.hostname.toLowerCase().replace(/^www\./, '');
		for (const p of Array.from(u.searchParams.keys())) {
			if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
		}
		u.hash = '';
		const pairs = Array.from(u.searchParams.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const q = pairs.map(([k, v]) => `${k}=${v}`).join('&');
		const port = u.port ? `:${u.port}` : '';
		return `${u.protocol}//${host}${port}${u.pathname.replace(/\/+$/, '')}${q ? '?' + q : ''}`;
	} catch {
		return raw.toLowerCase();
	}
}

export function isJunk(raw: string): boolean {
	const host = hostOf(raw);
	if (JUNK_HOSTS.some((j) => host === j || host.endsWith('.' + j))) return true;
	const tld = host.split('.').pop() ?? '';
	if (JUNK_TLDS.has(tld)) return true;
	return false;
}
