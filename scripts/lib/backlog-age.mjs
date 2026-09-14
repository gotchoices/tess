/**
 * How long each top-level backlog ticket has waited, read from git history.
 *
 * A ticket's age is the time since it **arrived at the top level of
 * `backlog/`**, which is narrower than when it was filed.  A ticket the
 * gardener re-sequences (`foo.md` → `3-foo.md`) has not arrived again, so it
 * keeps its age.  A ticket that reaches the top level from a release folder
 * (a ship) or from another stage (parked back from `plan/`) has arrived, so
 * its age restarts: until then, nobody had chosen to leave it in the current
 * queue.
 *
 * One `git log` over `tickets/backlog` walks every commit once, oldest first.
 * The pathspec hides paths outside `backlog/`, so a move in from another stage
 * reads as an addition, which is exactly the reset wanted.
 */

import { execFileSync } from 'node:child_process';
import { parseSlug } from './tickets.mjs';

/** Days at the top level of `backlog/` after which the gardener proposes declining a ticket. */
export const DEFAULT_DECLINE_AFTER_DAYS = 60;

/** Starts each commit's block in the log; a name-status line always holds a tab, so it cannot collide. */
const COMMIT_MARKER = '--tess-commit ';
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Arrival times from `git log --reverse -M --name-status` text: `slug →
 * epoch seconds` for each slug at the top level of `<ticketsRel>/backlog/`
 * after the last commit.  Exported so rename shapes git only produces under
 * particular settings (copies) can be tested without them.
 *
 * Per commit, all removals apply before all arrivals, so the order of lines
 * within a commit does not matter:
 *
 *   - `A` or `C` at top level: arrives now — unless the same slug left the top
 *     level in this same commit.  That is a re-sequence whose edit was big
 *     enough that git saw a delete and an add instead of a rename, and the
 *     slug keeps its arrival.
 *   - `R` from top level to top level (same slug or not): the new slug takes
 *     the old slug's arrival.
 *   - `R` from a sub-folder to top level: arrives now.
 *   - `R` from top level into a sub-folder, or `D` at top level: gone.
 *   - `M`, `T`, and anything below top level: ignored.
 */
export function arrivalsFromLog(log, ticketsRel = 'tickets') {
	const prefix = `${ticketsRel.replace(/\/+$/, '')}/backlog/`;
	const isTop = path => path != null && path.startsWith(prefix) && path.endsWith('.md') && !path.slice(prefix.length).includes('/');
	const slugOf = path => parseSlug(path.slice(prefix.length));

	const arrival = new Map();
	let commit = null;  // { time, changes: [[status, ...paths]] }
	const apply = () => {
		if (!commit) return;
		const gone = new Map();  // slug → its arrival before this commit (undefined when it had none)
		const came = [];         // [slug, slug whose arrival it inherits if that slug left in this commit, or null]
		const leave = path => gone.set(slugOf(path), arrival.get(slugOf(path)));
		for (const [status, from, to] of commit.changes) {
			switch (status[0]) {
				case 'A':
					if (isTop(from)) came.push([slugOf(from), slugOf(from)]);
					break;
				case 'C':
					if (isTop(to)) came.push([slugOf(to), slugOf(to)]);
					break;
				case 'D':
					if (isTop(from)) leave(from);
					break;
				case 'R':
					if (isTop(from)) leave(from);
					if (isTop(to)) came.push([slugOf(to), isTop(from) ? slugOf(from) : null]);
					break;
			}
		}
		for (const slug of gone.keys()) arrival.delete(slug);
		for (const [slug, source] of came) {
			arrival.set(slug, (source == null ? undefined : gone.get(source)) ?? commit.time);
		}
		commit = null;
	};

	for (const line of log.split(/\r?\n/)) {
		if (line.startsWith(COMMIT_MARKER)) {
			apply();
			commit = { time: parseInt(line.slice(COMMIT_MARKER.length), 10), changes: [] };
		} else if (commit && line.includes('\t')) {
			commit.changes.push(line.split('\t'));
		}
	}
	apply();
	return arrival;
}

/**
 * Arrival times for every slug at the top level of `<ticketsRel>/backlog/`, as
 * `slug → epoch seconds`, read with one `git log` run in `repoRoot`.
 * `ticketsRel` is relative to `repoRoot`, with forward slashes; `--relative`
 * keeps git's printed paths in that same form when `repoRoot` is below the
 * repository's top level.
 *
 * A slug with no record — an uncommitted ticket — is absent.  When git fails
 * (not a repository, no commits yet, git missing) the map is empty and `warn`
 * is called once: every age then reads as new, and the caller carries on.
 */
export function topLevelArrivals(repoRoot, ticketsRel = 'tickets', { warn = console.warn } = {}) {
	let log;
	try {
		// NOTE: one process for the whole backlog, its output held in memory.  SiteCAD's history (930 commits
		// touching tickets/backlog, 2026-09) printed 175 KB in 0.3 s; if a board's log ever nears the 64 MB
		// maxBuffer, stream it instead.
		log = execFileSync('git', [
			'-c', 'core.quotePath=false',
			'log', '--reverse', '-M', '--relative', '--name-status', `--format=${COMMIT_MARKER}%ct`,
			'--', `${ticketsRel}/backlog`,
		], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (err) {
		const reason = String(err.stderr ?? '').split(/\r?\n/).find(line => line.trim()) ?? err.message;
		warn(`could not read backlog history from git (${reason.trim()}) — every backlog ticket's age reads new, so none is proposed for decline`);
		return new Map();
	}
	return arrivalsFromLog(log, ticketsRel);
}

/** Whole days from an arrival (epoch seconds) to `nowSeconds`; never negative. */
export function ageInDays(arrival, nowSeconds) {
	return Math.max(0, Math.floor((nowSeconds - arrival) / SECONDS_PER_DAY));
}
