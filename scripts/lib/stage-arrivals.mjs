/**
 * When each ticket at the top level of a stage folder arrived there, read from
 * git history.  Backlog aging (lib/garden-inventory.mjs) measures a ticket's
 * age from it; discovery (lib/tickets.mjs `discoverTickets`) orders
 * same-sequence tickets by it, oldest first.
 *
 * A ticket's arrival is narrower than when it was filed.  A ticket that is
 * re-sequenced in place (`foo.md` → `3-foo.md`) has not arrived again, so it
 * keeps its arrival.  A ticket that reaches the top level from a backlog
 * release folder (a ship) or from another stage (a promotion, or a ticket
 * parked back from `plan/`) has arrived, so its arrival restarts.
 *
 * One `git log` over the stage folder walks every commit once, oldest first.
 * The pathspec hides paths outside the stage, so a move in from another stage
 * reads as an addition, which is exactly the reset wanted.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSlug } from './tickets.mjs';

const execFileAsync = promisify(execFile);

/** Starts each commit's block in the log; a name-status line always holds a tab, so it cannot collide. */
const COMMIT_MARKER = '--tess-commit ';

/**
 * Arrival times from `git log --reverse -M --name-status` text: `slug →
 * epoch seconds` for each slug at the top level of `<stage>/` after the last
 * commit, with paths in the log relative to the tickets directory.  Exported
 * so rename shapes git only produces under particular settings (copies) can be
 * tested without them.
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
export function arrivalsFromLog(log, stage) {
	const prefix = `${stage}/`;
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
 * Arrival times for every slug at the top level of `<ticketsDir>/<stage>/`, as
 * `slug → epoch seconds`, read with one `git log` run in `ticketsDir`.
 * `--relative` prints paths relative to `ticketsDir` (`<stage>/foo.md`) even
 * when it sits below the repository's top level.
 *
 * A slug with no record — an uncommitted ticket — is absent.  When git fails
 * (not a repository, no commits yet, git missing) the map is empty and `warn`
 * is called once with what failed; the caller's message says what that costs.
 */
export async function stageArrivals(ticketsDir, stage, { warn = console.warn } = {}) {
	let log;
	try {
		// NOTE: one process per stage, its output held in memory.  SiteCAD's history (2026-10-31) printed
		// 682 KB in 0.19 s for implement/, its busiest stage; if a board's log ever nears the 64 MB
		// maxBuffer, stream it instead.
		// NOTE: a merge prints no changes of its own, so both branches' commits replay in date order and a
		// merged branch's tickets arrive at their own commits.  When both sides changed the same ticket (one
		// re-sequenced it, the other deleted it), the replay can misread its arrival; if that is ever seen,
		// walk `--first-parent --diff-merges=first-parent`, which dates a merged branch's arrivals at the
		// merge (on SiteCAD's backlog/, 2026-09-14: 16 of 222 arrivals moved to their merge date, nothing
		// else changed).
		// NOTE: the stamp is committer time, which a rebase resets.  Per-ticket sync pushes minutes after
		// each commit, so the shift is small going forward; on SiteCAD's history (2026-10-31, mostly from
		// before per-ticket sync) author time (`%at`) orders 37 of 903 unnumbered implement/ pairs the
		// other way, by up to 41 h.  If a ticket is seen losing ties after sitting unpushed, stamp `%at`.
		({ stdout: log } = await execFileAsync('git', [
			'-c', 'core.quotePath=false',
			'log', '--reverse', '-M', '--relative', '--name-status', `--format=${COMMIT_MARKER}%ct`,
			'--', stage,
		], { cwd: ticketsDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }));
	} catch (err) {
		const reason = String(err.stderr ?? '').split(/\r?\n/).find(line => line.trim()) ?? err.message;
		warn(`could not read ${stage}/ history from git (${reason.trim()})`);
		return new Map();
	}
	return arrivalsFromLog(log, stage);
}
