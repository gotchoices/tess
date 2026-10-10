/**
 * Git operations: tess version stamp, per-ticket commit, migration commit, and the
 * clean-working-tree invariant the runner enforces before it starts any ticket.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, needsMigration, FORMAT_VERSION } from '../migrate.mjs';
import { bypassesReview } from './tickets.mjs';

/** Short sha of the tess submodule's HEAD, for the run banner. */
export function getTessVersion(tessRoot) {
	try {
		const hash = execSync('git log -1 --format=%h', { cwd: tessRoot, encoding: 'utf-8' }).trim();
		return hash;
	} catch {
		return 'unknown';
	}
}

/** Default ceiling on file deletions a single ticket commit may capture.  A transient or
 *  partial working tree (the cause of the engine-wipe incident) surfaces as a mass deletion
 *  far above any legitimate single-ticket change.  Override with TESS_MAX_DELETIONS. */
const DEFAULT_MAX_DELETIONS = 100;

/** Valid `--dirty-tree` modes, in help order. */
export const DIRTY_TREE_MODES = ['salvage', 'abort', 'ignore'];

/** Cap on how many dirty paths the reconcile notice lists before summarizing. */
const MAX_NOTICE_ENTRIES = 50;

/** Parse `git status --porcelain` output into `{ code, path }` entries.  `code` is the raw
 *  two-character XY status; `path` is the destination path for renames and copies.  Lines are
 *  NOT trimmed — the leading space of a worktree-only status (` M`, ` D`) is load-bearing, and
 *  trimming the whole blob would shift the first line's columns by one. */
function parsePorcelain(raw) {
	const entries = [];
	for (let line of String(raw ?? '').split('\n')) {
		if (line.endsWith('\r')) line = line.slice(0, -1);
		if (line.length < 4) continue;
		const code = line.slice(0, 2);
		let path = line.slice(3);
		// Rename/copy entries read `old -> new`; the destination is the path that exists now.
		if (code[0] === 'R' || code[0] === 'C') {
			const arrow = path.indexOf(' -> ');
			if (arrow !== -1) path = path.slice(arrow + 4);
		}
		entries.push({ code, path: unquotePath(path) });
	}
	return entries;
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Undo the C-style quoting porcelain applies to a path holding a space, a quote, a backslash or
 *  a non-ASCII byte (`"vendor lib"`, `"caf\303\251"`).  Load-bearing for submodule paths: the
 *  pin guard matches entries against `.gitmodules`, which holds the path unquoted. */
function unquotePath(path) {
	if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path;
	const bytes = [];
	// By code point, not code unit: with `core.quotePath=false` git leaves non-ASCII unescaped,
	// and splitting a surrogate pair would turn it into two replacement characters.
	const chars = [...path.slice(1, -1)];
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== '\\') {
			bytes.push(...Buffer.from(chars[i]));
		} else if (/[0-7]/.test(chars[i + 1])) {
			bytes.push(parseInt(chars.slice(i + 1, i + 4).join(''), 8));
			i += 3;
		} else {
			const escaped = chars[++i];
			bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0));
		}
	}
	return Buffer.from(bytes).toString('utf-8');
}

/**
 * Probe the working tree.  Submodule *content* changes are excluded — the parent repo cannot
 * commit them, so they are not "dirt the runner can clean".  (A submodule whose HEAD moved
 * still shows up, because that gitlink bump IS committable.)  Without that exclusion, a repo
 * with a dirty submodule reads as permanently dirty and every salvage attempt stages nothing
 * and then fails with "nothing to commit", on every run.
 *
 * `exec` is injectable so tests can assert the command shape without a nested-repo fixture.
 *
 * NOTE: the exclusion also hides *uncommitted* submodule edits from `commitAll`, which used to
 * notice them by failing loudly with "nothing to commit".  `inspectSubmodules` below is the
 * second probe this NOTE used to ask for; it stays a *separate* probe rather than a relaxation
 * of this flag, because relaxing the flag would reintroduce the no-op-salvage failure above.
 *
 * A moved gitlink is committable, but not always committed: one whose new pin does not descend
 * from HEAD's is the one thing the runner's sweep refuses (`refusedPinMoves`).  Such an entry is
 * reported in `refusedPins` and left out of `entries` and `dirty` for the same no-op-salvage
 * reason — it stays modified in `git status`, and counting it would make every later reconcile
 * salvage it, stage nothing and stop the run.  Its git calls do not go through `exec`, and they
 * run only when the tree is dirty: a clean tree still costs one `git status`.
 */
export function inspectWorkingTree(cwd, { exec = execSync } = {}) {
	const raw = exec('git status --porcelain --ignore-submodules=dirty', { cwd, encoding: 'utf-8' });
	const all = parsePorcelain(raw);
	const refusedPins = all.length > 0 ? refusedPinMoves(cwd, all) : [];
	const entries = all.filter(e => !refusedPins.some(pin => pin.path === e.path));
	const deletions = entries.filter(e => e.code[0] === 'D' || e.code[1] === 'D').length;
	return { dirty: entries.length > 0, entries, deletions, refusedPins };
}

/** Run git with an argv array, never a shell string: the arguments below carry submodule paths
 *  read out of `.gitmodules`, which may contain a space or a shell metacharacter. */
function runGit(cwd, args) {
	return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Every submodule path `.gitmodules` declares, checked out or not.  Read from there rather than
 *  a list in this file: tess is itself a submodule of several different host projects, and each
 *  has its own set.  A repo with no `.gitmodules` declares none. */
function declaredSubmodulePaths(cwd) {
	let declared;
	try {
		// `-z` is load-bearing rather than tidiness.  Without it a record reads
		// `submodule.<name>.path <path>` on one line, and the name `git submodule add` derives from
		// a path containing a space contains that space too — so splitting on the first space yields
		// a non-path, the submodule is skipped, and the probe silently misses exactly the state it
		// exists to catch.  Under `-z` records are NUL-separated and the key/value split is an
		// unambiguous newline; git has already stripped CR and surrounding whitespace from the value.
		declared = runGit(cwd, ['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
	} catch {
		return [];
	}
	const paths = [];
	for (const record of String(declared ?? '').split('\0')) {
		const newline = record.indexOf('\n');
		if (newline === -1) continue;
		const path = record.slice(newline + 1);
		if (path) paths.push(path);
	}
	return paths;
}

/** Whether a declared submodule is checked out.  Test this before any `git -C <path>`, rather than
 *  catching its failure: `git -C` on an *empty* directory — what `git submodule init` without
 *  `update` leaves behind — walks up and answers for the PARENT repo instead.  A checked-out
 *  submodule always has a `.git` (a file pointing into `.git/modules/`, or a real directory in an
 *  older or converted checkout). */
function isCheckedOut(cwd, path) {
	return existsSync(resolve(cwd, path, '.git'));
}

/** Gitlinks (mode 160000) in `git ls-tree -z` or `git ls-files -s -z` output, as `path → sha`.
 *  The formats differ in one field: ls-tree puts the object type before the sha, ls-files the
 *  stage number after it. */
function readGitlinks(cwd, args) {
	let raw;
	try {
		raw = runGit(cwd, args);
	} catch {
		return new Map(); // an unborn HEAD records nothing to compare against
	}
	const links = new Map();
	for (const record of raw.split('\0')) {
		const match = /^160000 (?:commit )?([0-9a-f]+)(?: \d+)?\t([^]+)$/.exec(record);
		if (match) links.set(match[2], match[1]);
	}
	return links;
}

/** Whether commit `a` is an ancestor of commit `b` in the submodule at `path`; null when git
 *  cannot say, which is what a commit missing from the submodule's object store looks like. */
function isAncestor(cwd, path, a, b) {
	try {
		runGit(cwd, ['-C', path, 'merge-base', '--is-ancestor', a, b]);
		return true;
	} catch (err) {
		return err.status === 1 ? false : null;
	}
}

/** How a candidate pin relates to the one HEAD records, in a checked-out submodule: 'forward' |
 *  'behind' | 'diverged' | 'unknown'.  The same descent question the host's CI pin checks ask. */
function pinRelation(cwd, path, recorded, actual) {
	const forward = isAncestor(cwd, path, recorded, actual);
	if (forward === true) return 'forward';
	const behind = forward === null ? null : isAncestor(cwd, path, actual, recorded);
	if (behind === null) return 'unknown';
	return behind ? 'behind' : 'diverged';
}

function checkoutHead(cwd, path) {
	try {
		return runGit(cwd, ['-C', path, 'rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
	} catch {
		return null; // a submodule repo with no commits yet
	}
}

/**
 * The submodule pins among the dirty `entries` that a runner commit must not record: each one
 * whose new pin does not descend from the pin in HEAD.  Returns
 * `[{ path, recorded, actual, relation, checkedOut }]` with `relation` one of 'behind' |
 * 'diverged' | 'unknown'; forward moves, and submodules HEAD does not record yet, are absent
 * because they commit as any other change does.  Why diverged and unprovable moves are refused
 * along with backward ones: `docs/DESIGN.md` § *The Clean-Tree Invariant*.
 *
 * `actual` is what `git add -A` would record: the checkout's HEAD, or — for a submodule that is
 * not checked out, which `git add -A` leaves alone — whatever gitlink is already staged.  The
 * second case is a gitlink staged by hand; nothing in that empty directory can prove its
 * ancestry, so it reads as 'unknown'.
 */
function refusedPinMoves(cwd, entries) {
	const dirty = new Set(entries.map(e => e.path));
	const paths = declaredSubmodulePaths(cwd).filter(path => dirty.has(path));
	if (paths.length === 0) return [];

	const recorded = readGitlinks(cwd, ['ls-tree', '-z', 'HEAD', '--', ...paths]);
	const staged = readGitlinks(cwd, ['ls-files', '-s', '-z', '--', ...paths]);
	const refused = [];
	for (const path of paths) {
		const was = recorded.get(path);
		if (!was) continue;
		const checkedOut = isCheckedOut(cwd, path);
		const now = checkedOut ? checkoutHead(cwd, path) : staged.get(path);
		if (!now || now === was) continue;
		const relation = checkedOut ? pinRelation(cwd, path, was, now) : 'unknown';
		if (relation !== 'forward') refused.push({ path, recorded: was, actual: now, relation, checkedOut });
	}
	return refused;
}

/**
 * Probe every submodule this repo declares for uncommitted *content* — the half of the working
 * tree `inspectWorkingTree` deliberately cannot see.
 *
 * Returns `[{ path, entries }]`, one element per submodule that has uncommitted content, with
 * `entries` in `inspectWorkingTree`'s shape.  An empty array means there is nothing to strand.
 *
 * Two states deliberately read as clean rather than as errors — a repo with no `.gitmodules` at
 * all, and a submodule that is declared but not checked out.  Neither holds work that could be
 * stranded, and neither is a reason to fail the commit that is about to save the stage's actual
 * work.
 */
function inspectSubmodules(cwd) {
	const dirty = [];
	for (const path of declaredSubmodulePaths(cwd)) {
		// Without the checked-out test the parent's own dirt would read as stranded submodule work
		// on every ticket (see `isCheckedOut`).
		if (!isCheckedOut(cwd, path)) continue;

		let raw;
		try {
			raw = runGit(cwd, ['-C', path, 'status', '--porcelain']);
		} catch {
			continue; // a `.git` whose gitdir is gone, or an otherwise unreadable repo
		}
		const entries = parsePorcelain(raw);
		if (entries.length > 0) dirty.push({ path, entries });
	}
	return dirty;
}

/** Stage and commit all working-tree changes under one message.  Returns true if a commit
 *  was created.  `context` labels the abort message when the deletion guard trips, and the
 *  refused-pin notice.  `probe` is one the caller already took and whose refused pins it already
 *  announced — reconcile's salvage — so the notice is not printed twice.
 *
 *  NOTE: accepted tradeoff — this stages with `git add -A`, so it captures whatever is in the
 *  tree rather than only what the current ticket changed.  Per-ticket path tracking was weighed
 *  and declined: ticket agents touch arbitrary paths and the runner has no way to enumerate
 *  them.  What makes the unscoped sweep safe is the clean-tree invariant enforced by
 *  `reconcileWorkingTree` before any ticket agent starts — there is nothing foreign left for
 *  this to sweep.  Revisit if the runner ever learns which paths a ticket touched.
 *
 *  The one thing the sweep refuses is a submodule pin that does not move forward.  The invariant
 *  cannot cover it: a checkout left behind HEAD's gitlink (a rebase or pull with no
 *  `git submodule update`) is not residue anyone can salvage, and the runner never has a reason
 *  to record a rewind — so it is left out of every commit, with a warning, until a human sorts
 *  the checkout out. */
export function commitAll(cwd, message, { context = message, probe: announced = null } = {}) {
	try {
		const probe = announced ?? inspectWorkingTree(cwd);
		if (!announced) printRefusedPinNotice(probe.refusedPins, context);
		if (!probe.dirty) return false;

		// Safety guard: refuse to capture a spurious mass deletion (e.g. a transient/partial
		// working tree that drops a whole package).  Checked before `git add -A`, so on abort
		// nothing is staged and the working tree is left untouched for inspection.
		const maxDeletions = Number(process.env.TESS_MAX_DELETIONS ?? DEFAULT_MAX_DELETIONS);
		if (probe.deletions > maxDeletions) {
			console.error(`[runner] ABORTING commit for ${context}: ${probe.deletions} deletions exceed the safety threshold (${maxDeletions}).`);
			console.error('[runner] This looks like a spurious mass-deletion (transient/partial working tree), not an intended change.');
			console.error('[runner] Nothing was staged or committed; inspect with `git status` and re-run once the tree is intact.');
			console.error('[runner] If the deletion is genuinely intended, raise TESS_MAX_DELETIONS and re-run.');
			return false;
		}

		stageAllButRefusedPins(cwd, probe.refusedPins);
		// execFileSync, not execSync: the message carries the ticket slug, which comes from a
		// filename an agent wrote.  Interpolating that into a shell string let a slug containing
		// a quote, `$(…)` or a backtick corrupt the commit — or run.
		execFileSync('git', ['commit', '-m', message], { cwd, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Git commit failed: ${err.message}`);
		return false;
	}
}

/** `git add -A`, minus the refused pins.  The exclude pathspec only stops this call from staging
 *  them, so a refused gitlink that was already staged — by hand, or by an earlier `git add` — is
 *  then put back to HEAD's pin in the index.  Index-only throughout: nothing inside a submodule is
 *  checked out, reset or updated, because the older checkout may be there on purpose. */
function stageAllButRefusedPins(cwd, refusedPins) {
	if (refusedPins.length === 0) {
		runGit(cwd, ['add', '-A']);
		return;
	}
	const paths = refusedPins.map(pin => pin.path);
	runGit(cwd, ['add', '-A', '--', ':/', ...paths.map(path => `:(exclude,literal)${path}`)]);
	const staged = readGitlinks(cwd, ['ls-files', '-s', '-z', '--', ...paths]);
	const restore = refusedPins.filter(pin => staged.get(pin.path) !== pin.recorded);
	// `literal`, unlike the read above: a glob character in a path would widen a reset, not a lookup.
	if (restore.length > 0) runGit(cwd, ['reset', '-q', '--', ...restore.map(pin => `:(literal)${pin.path}`)]);
}

/** Print the dirty-tree notice.  Every reconcile branch except the clean one prints this — the
 *  mis-attribution this whole mechanism exists to prevent happened silently, and a run that
 *  says nothing about a dirty tree is how it stayed invisible.
 *
 *  NOTE: `git status --porcelain` collapses a wholly-untracked directory into one `?? dir/`
 *  entry, so the count is a signal that something is there, not an inventory of what gets
 *  committed.  Fine while the notice exists to make a salvage visible; if it ever has to
 *  enumerate exactly what was swept, the probe needs `-uall` — which also makes it walk every
 *  file under a large untracked tree, on every ticket. */
function printDirtyNotice(entries, label, owner) {
	console.log(`[runner] Working tree dirty before ${label} — ${entries.length} uncommitted path(s):`);
	for (const e of entries.slice(0, MAX_NOTICE_ENTRIES)) {
		console.log(`[runner]     ${e.code} ${e.path}`);
	}
	if (entries.length > MAX_NOTICE_ENTRIES) {
		console.log(`[runner]     … +${entries.length - MAX_NOTICE_ENTRIES} more`);
	}
	if (owner) {
		console.log(`[runner]   Attributing to interrupted ticket: ${owner.stage}/${owner.slug}`);
	} else {
		console.log(`[runner]   No ticket in progress — cannot attribute this to a ticket.`);
	}
}

/** Print the stranded-submodule notice.  Deliberately as loud as `printDirtyNotice`, and for
 *  the same reason: the failure this exists to prevent was silent (the incident is in
 *  `docs/DESIGN.md` § *The Clean-Tree Invariant*). */
function printStrandedSubmoduleNotice(stranded, label) {
	const total = stranded.reduce((n, sub) => n + sub.entries.length, 0);
	console.error(`[runner] WARNING: ${total} uncommitted path(s) in ${stranded.length} submodule(s) at ${label}:`);
	for (const sub of stranded) {
		console.error(`[runner]   ${sub.path}/`);
		for (const e of sub.entries.slice(0, MAX_NOTICE_ENTRIES)) {
			console.error(`[runner]     ${e.code} ${e.path}`);
		}
		if (sub.entries.length > MAX_NOTICE_ENTRIES) {
			console.error(`[runner]     … +${sub.entries.length - MAX_NOTICE_ENTRIES} more`);
		}
	}
	console.error('[runner]   A parent commit cannot capture a submodule\'s working tree, so the commit below');
	console.error('[runner]   does NOT contain any of this.  If it is part of the work this stage just claimed,');
	console.error('[runner]   the change is half-landed until it is committed where it lives:');
	for (const sub of stranded) {
		console.error(`[runner]     git -C ${sub.path} commit -a -m "<what this work was>" && git -C ${sub.path} push`);
	}
	console.error('[runner]   then commit the moved pin in the parent.');
}

const RELATION_TEXT = {
	behind: 'behind: an ancestor of the recorded pin',
	diverged: 'diverged: neither commit descends from the other',
	unknown: 'unknown: ancestry cannot be shown (a commit is missing from the submodule, or it is not checked out)',
};

/** Print the refused-pin notice, as loud as `printStrandedSubmoduleNotice` and for the same
 *  reason: the commits it replaces were silent, and rewound lamina's pin six times under
 *  unrelated subjects before CI caught one (`docs/DESIGN.md` § *The Clean-Tree Invariant*).
 *  A no-op when nothing was refused. */
function printRefusedPinNotice(refusedPins, label) {
	if (refusedPins.length === 0) return;
	console.error(`[runner] WARNING: not committing ${refusedPins.length} submodule pin(s) that would move backwards or sideways (${label}):`);
	for (const pin of refusedPins) {
		const where = pin.checkedOut ? 'checked out' : 'staged';
		console.error(`[runner]   ${pin.path}: HEAD records ${pin.recorded.slice(0, 9)}, ${where} is ${pin.actual.slice(0, 9)} — ${RELATION_TEXT[pin.relation]}`);
	}
	console.error('[runner]   Recording that would drop submodule commits the parent already points at, so the pin');
	console.error('[runner]   stays as HEAD has it and `git status` keeps showing the path modified.  If the checkout');
	console.error('[runner]   is simply stale, bring it up to the recorded pin:');
	for (const pin of refusedPins) {
		console.error(`[runner]     git submodule update ${pin.path}`);
	}
	console.error('[runner]   If the rewind is intended, commit it by hand with the trailer your CI\'s pin check');
	console.error('[runner]   accepts (e.g. `Lamina-rewind: <reason>`).');
}

function salvageMessage(owner) {
	return owner
		? `ticket(${owner.stage}): ${owner.slug} (partial — salvaged from interrupted run)`
		: 'tess: salvage uncommitted working tree (no ticket in progress)';
}

/**
 * Enforce "the working tree is clean before a ticket runs".
 *
 * The runner cannot know which paths belong to the ticket it is about to start, but it does
 * know that anything already dirty belongs to something *else* — an interrupted agent, an
 * earlier ticket that committed nothing, or a human.  Committing that residue under its own
 * honest message is what keeps every unscoped `git add -A` in the runner from silently
 * mis-attributing it to the next ticket that happens to finish.
 *
 *   owner    — { stage, slug } the residue most plausibly belongs to, or null
 *   mode     — 'salvage' (default) | 'abort' | 'ignore'
 *   refusal  — why `abort` refuses, shown in the notice; defaults to the runner's flag
 *
 * Returns `{ action: 'clean' | 'salvaged' | 'ignored' | 'abort', entries }`.
 */
export function reconcileWorkingTree(cwd, { owner = null, mode = 'salvage', noCommit = false, dryRun = false, label = 'the next ticket', refusal = '--dirty-tree abort' } = {}) {
	// NOTE: this probe is deliberately NOT wrapped — a `git status` that throws (git missing, the
	// cwd not a repo, an `index.lock` held by a concurrent git command) fails the run at its first
	// step rather than letting it proceed over a tree whose state is unknown.  If lock contention
	// with a human working the same checkout ever makes startup flaky, retry the probe here; do
	// not degrade it into "assume clean".
	const probe = inspectWorkingTree(cwd);
	// Before the clean return, not after: a tree whose only change is a refused pin reads as clean,
	// and a stale checkout must not sit through a whole run unmentioned.
	printRefusedPinNotice(probe.refusedPins, label);
	if (!probe.dirty) return { action: 'clean', entries: [] };

	printDirtyNotice(probe.entries, label, owner);

	// `--dry-run` never changes what happens or what the process exits with — it reports what a
	// real run would have done and leaves the tree exactly as it found it.
	if (dryRun) {
		const would = mode === 'abort'
			? `a real run would refuse to start (${refusal})`
			: mode === 'ignore'
				? 'a real run would leave it in place (--dirty-tree ignore)'
				: `a real run would salvage it as: ${salvageMessage(owner)}`;
		console.log(`[runner]   Left in place (--dry-run) — ${would}.`);
		return { action: 'ignored', entries: probe.entries };
	}

	// `abort` is a refusal to run, not a commit, so it outranks `--no-commit`: an operator who
	// asked the runner not to start on a dirty tree means it whether or not commits are enabled.
	if (mode === 'abort') {
		console.error(`[runner]   Refusing to start with a dirty tree (${refusal}).  Commit or park it, then re-run:`);
		console.error(`[runner]     git commit -a -m "<what this work actually was>"`);
		console.error(`[runner]     git stash push -u -m "tess: pre-run working tree"`);
		return { action: 'abort', entries: probe.entries };
	}

	if (noCommit || mode === 'ignore') {
		const why = noCommit ? '--no-commit' : '--dirty-tree ignore';
		console.log(`[runner]   Left in place (${why}) — it will be swept into the next commit the runner makes.`);
		return { action: 'ignored', entries: probe.entries };
	}

	const message = salvageMessage(owner);
	if (commitAll(cwd, message, { context: owner ? owner.slug : 'working-tree salvage', probe })) {
		console.log(`[runner]   Salvaged as: ${message}`);
		console.log('[runner]   If that attribution is wrong, `git reset --soft HEAD~1` puts it back.');
		return { action: 'salvaged', entries: probe.entries };
	}

	// commitAll returned false: the deletion guard tripped, git failed, or the tree went clean
	// underneath us.  Re-probe to tell the benign race from the two real failures — proceeding
	// with a still-dirty tree is exactly the mis-attribution this function exists to prevent.
	const after = inspectWorkingTree(cwd);
	if (after.dirty) {
		console.error('[runner]   Salvage commit failed — refusing to continue with a dirty working tree.');
		return { action: 'abort', entries: after.entries };
	}
	console.log('[runner]   Tree went clean during salvage — continuing.');
	return { action: 'salvaged', entries: probe.entries };
}

/** Stage and commit all changes for a completed ticket.  Returns true if a commit was created.
 *
 *  A ticket that skipped its review stage says so here, after the `ticket(<stage>): <slug>`
 *  prefix the review rules grep for (`git log --grep="ticket(implement): <slug>"`), so the
 *  history still answers "why is there no review commit for this slug?" long after the run's
 *  console output is gone. */
export function commitTicket(ticket, cwd) {
	const skipped = bypassesReview(ticket) ? ' — review skipped (review: skip)' : '';
	const subject = `ticket(${ticket.stage}): ${ticket.slug}${skipped}`;
	return commitAll(cwd, subject + strandedSubmoduleTrailer(cwd, subject), { context: ticket.slug });
}

/** The stranded-submodule check, run at the one moment it is about to matter: a ticket's stage
 *  is finished and its commit is about to claim so.  Prints the notice and returns the commit
 *  trailer that records it, or '' when every submodule is clean.  Why only `commitTicket` calls
 *  it, and why the trailer rather than the notice alone is the durable half, are in
 *  `docs/DESIGN.md` § *The Clean-Tree Invariant*.
 *
 *  NOTE: accepted tradeoff — this warns and lets the commit proceed; refusing was weighed and
 *  declined, because a refusal cannot stop the strand (the agent has already moved the ticket
 *  file, so the board move would just be mis-attributed to the next ticket's salvage) and stale
 *  submodule dirt would wedge every later ticket with nothing in the runner able to clear it.
 *  Revisit if the runner ever learns to commit inside a submodule on a ticket's behalf, which
 *  would make refusal recoverable.  Full argument in the DESIGN.md section above. */
function strandedSubmoduleTrailer(cwd, subject) {
	const stranded = inspectSubmodules(cwd);
	if (stranded.length === 0) return '';
	printStrandedSubmoduleNotice(stranded, subject);
	return `\n\nStranded-submodule: ${stranded.map(sub => sub.path).join(', ')}\n`
		+ 'Those submodule working trees had uncommitted content when this commit was made, and a\n'
		+ 'parent commit cannot carry it.  If this stage claimed work in them, that half is not here.';
}

/** Run migration if needed and commit the result.  Returns whether a commit was made. */
export async function runMigrationIfNeeded(ticketsDir, repoRoot, { noCommit, dryRun }) {
	if (!await needsMigration(ticketsDir)) return false;
	console.log('\n  Legacy ticket format detected — running migration to v' + FORMAT_VERSION + '...');
	const result = await migrate(ticketsDir, { dryRun });
	if (dryRun) {
		console.log(`    [dry-run] Would migrate ${result.migrated} ticket(s), rewrite ${result.rewrites} body/bodies.`);
		console.log('    Note: schedule below uses current (pre-migration) filenames and new ascending-seq');
		console.log('          ordering — it is REVERSED from what a real run will actually execute. To');
		console.log('          preview accurately: run `node tess/scripts/migrate.mjs`, commit, then re-dry-run.');
		return false;
	}
	console.log(`    Renamed ${result.renamed} ticket(s); rewrote ${result.rewrites} body/bodies; stamped .version=${FORMAT_VERSION}.`);
	if (noCommit) return false;
	// Through commitAll like every other commit the runner makes: same mass-deletion guard, and
	// the same `--ignore-submodules=dirty` probe (a plain `git status` reads a repo whose
	// submodule content is dirty as non-empty, then fails the commit with "nothing to commit").
	if (!commitAll(repoRoot, `tess: migrate ticket format to v${FORMAT_VERSION}`, { context: 'ticket-format migration' })) return false;
	console.log('    Committed migration.');
	return true;
}
