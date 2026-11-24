/**
 * Types for scripts/lib/inbox.mjs and scripts/lib/state.mjs, as much of each
 * as the API calls.
 *
 * The .mjs files are authoritative.  Their sibling search-tools.mjs carries its
 * types beside it (search-tools.d.mts); until these do the same, the pattern
 * declarations here are what type the relative imports in api-plugin.ts.  A
 * real `.d.mts` beside a module takes precedence over its declaration here —
 * delete that declaration then.
 */
declare module '*/scripts/lib/state.mjs' {
	/** The runner's marker for the ticket it is working in this checkout (`tickets/.in-progress`), or null. */
	export function readInProgress(ticketsDir: string): Promise<{ stage?: string; slug?: string } | null>;
}

declare module '*/scripts/lib/inbox.mjs' {
	type InboxEntry = import('../lib/types.js').InboxEntry;
	type InboxWriteResult = import('../lib/types.js').InboxWriteResult;

	/** An entry as the library lists it: `path` is the ticket's absolute path. */
	type ListedEntry = InboxEntry & { path: string };
	/** The outcome of one write: `path` is where the ticket now is, absolute. */
	type WriteResult = InboxWriteResult & { path: string };

	/** Every ticket in `blocked/`. */
	export function readInbox(ticketsDir: string): Promise<ListedEntry[]>;
	/** The answered tickets that have left `blocked/` and can still be withdrawn (lane `decided`). */
	export function readDecided(ticketsDir: string): Promise<ListedEntry[]>;
	/** The destinations an answer can be sent to: the stages, plus `backlog/<CODE>` per later release. */
	export function availableDestinations(ticketsDir: string): Promise<string[]>;
	export function currentUserName(repoRoot: string): string;
	/** Throws `code: 'EINVAL'` for a key the ticket has no option for, a bad `to`, or a name clash at the destination. */
	export function recordDecision(
		ticketsDir: string,
		file: string,
		answer: { decision: string; note?: string | null; who: string; date?: string; to?: string | null; commit?: boolean },
	): Promise<WriteResult>;
	/** Finds the ticket by slug wherever its answer sent it; `EINVAL` once an agent has applied the answer. */
	export function withdrawDecision(ticketsDir: string, file: string, options?: { commit?: boolean }): Promise<WriteResult>;
	export function recordAsk(ticketsDir: string, file: string, ask: { question: string; commit?: boolean }): Promise<WriteResult>;

	/**
	 * The tickets the distill pass would work now, in the order it works them:
	 * what `node scripts/distill.mjs` with the same options starts one agent for.
	 * One `git log` per ticket, so not for every poll.
	 */
	export function dueForDistill(
		ticketsDir: string,
		options?: { only?: Set<string> | null; all?: boolean },
	): Promise<{ entry: ListedEntry; reasons: string[]; difficulty: string | null }[]>;
	/** Ask a running pass to stop once the ticket it is on has finished. */
	export function requestDistillStop(ticketsDir: string): Promise<void>;
}
