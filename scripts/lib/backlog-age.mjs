/**
 * How long each top-level backlog ticket has waited, for the gardener.
 *
 * A ticket's age is the time since it **arrived at the top level of
 * `backlog/`** — lib/stage-arrivals.mjs `stageArrivals(ticketsDir,
 * 'backlog')`, read from git history — which is narrower than when it was
 * filed: a re-sequence keeps it, a ship from a release folder or a park back
 * from another stage restarts it.
 */

/** Days at the top level of `backlog/` after which the gardener proposes declining a ticket. */
export const DEFAULT_DECLINE_AFTER_DAYS = 60;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Whole days from an arrival (epoch seconds) to `nowSeconds`; never negative. */
export function ageInDays(arrival, nowSeconds) {
	return Math.max(0, Math.floor((nowSeconds - arrival) / SECONDS_PER_DAY));
}
