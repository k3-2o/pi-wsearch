/** Shared constants: single home for facts that would otherwise drift across modules. */

export type Freshness = 'none' | 'day' | 'week' | 'month' | 'year';

export const FRESHNESS_DAYS: Record<Exclude<Freshness, 'none'>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

/** Same windows in ms (fuse re-rank); derived so the two cannot diverge. */
export const FRESH_WINDOW_MS: Record<Exclude<Freshness, 'none'>, number> = {
	day: FRESHNESS_DAYS.day * 86_400_000,
	week: FRESHNESS_DAYS.week * 86_400_000,
	month: FRESHNESS_DAYS.month * 86_400_000,
	year: FRESHNESS_DAYS.year * 86_400_000,
};

export const DEFAULT_MAX_RESULTS = 8;

/** The abort message: a UX contract (pi renders isError red), one home. */
export const ABORT_ERROR = 'aborted (user interrupt)';
