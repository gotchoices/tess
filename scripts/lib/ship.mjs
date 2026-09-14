/**
 * Shipping a release — `node tess/scripts/release.mjs ship`.
 *
 * Shipping is the one operation that changes which release is current.  It
 * removes the first entry of `tickets/releases.md`, moves the tickets deferred
 * to the next release (`backlog/<NEXT>/`) up to the top level of `backlog/`,
 * and removes every ticket header line `target: <SHIPPED>`.  Past releases
 * exist only in version history.
 *
 * `planShip` only reads, and collects every error instead of stopping at the
 * first; `applyShip` carries out a plan that has none.  The list is rewritten
 * last, so a ship interrupted part-way still names the shipped release as
 * current, and planning again finds only the work left: moved tickets are no
 * longer in the folder and stripped lines are gone.
 *
 * Tess strips only its own board.  Other tools that tag files with release
 * codes find the shipped code in the commit subject, `shipCommitMessage`.
 */

import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { commitAll, reconcileWorkingTree } from './git.mjs';
import { RELEASES_FILE, currentRelease, readReleases, serializeReleases } from './releases.mjs';
import { KNOWN_STAGES, boardLocation, byName, headerFieldLines, parseSlug, readBacklogLayout, readTicketFile, stageFiles } from './tickets.mjs';

const RELEASES_PATH = `tickets/${RELEASES_FILE}`;

/** Every stage whose tickets lose `target: <SHIPPED>`.  `complete/` is an archive and keeps what it says. */
const STRIP_STAGES = KNOWN_STAGES.filter(stage => stage !== 'complete');

/** Sources per `git mv`, which keeps each command line far inside Windows' 32,767-character limit. */
const GIT_MV_BATCH = 100;

/** The subject of the commit a ship makes. */
export function shipCommitMessage(code) {
	return `tess: ship release ${code}`;
}

/** The 1-based numbers of `content`'s header lines `target: <code>`. */
function targetLinesNaming(content, code) {
	return headerFieldLines(content, 'target').filter(field => field.value === code).map(field => field.line);
}

/**
 * Work out a ship from the board, reading only.  Returns `{ ticketsDir,
 * shipped, next, moves, removeFolder, strips, errors }`:
 *
 *   - `shipped`, `next` — the first and second listed codes, or null;
 *   - `moves` — `{ from, to }` for each ticket directly inside `backlog/<next>/`,
 *     in filename order;
 *   - `removeFolder` — `backlog/<next>` when that folder exists, otherwise null;
 *   - `strips` — `{ path, line }` for each header line `target: <shipped>`
 *     outside `complete/`, `line` 1-based, in path order;
 *   - `errors` — every reason not to ship.
 *
 * Paths are relative to `ticketsDir`, with forward slashes.
 */
export async function planShip(ticketsDir) {
	const plan = { ticketsDir, shipped: null, next: null, moves: [], removeFolder: null, strips: [], errors: [] };
	const releases = await readReleases(ticketsDir);
	plan.errors.push(...releases.errors);
	if (!releases.present) {
		plan.errors.push(`no ${RELEASES_PATH} — without a release list there is no current release to ship`);
		return plan;
	}
	if (releases.entries.length === 0) {
		plan.errors.push(`nothing to ship — ${RELEASES_PATH} lists no releases`);
		return plan;
	}
	plan.shipped = currentRelease(releases);
	plan.next = releases.entries[1]?.code ?? null;

	// Folder names straight from readdir, not a stat of `backlog/<code>`: a case-insensitive
	// filesystem would find `backlog/beta/` under that name, and codes are case-sensitive.
	const layout = await readBacklogLayout(ticketsDir);
	if (layout.folders.some(folder => folder.name === plan.shipped)) {
		plan.errors.push(`backlog/${plan.shipped}/ is named after the release being shipped — current tickets live directly in backlog/, so move them there first`);
	}
	const nextFolder = layout.folders.find(folder => folder.name === plan.next);
	if (nextFolder) await planMoves(plan, layout.top, nextFolder);
	await planStrips(plan);
	return plan;
}

/**
 * Plan moving `folder`'s tickets up to `backlog/`, then removing the folder.  A
 * ticket collides with the top level when its filename is already taken there,
 * or a top-level ticket has its slug under another sequence prefix.  Both
 * compare ignoring case: on a case-insensitive filesystem a rename onto
 * `Notes.md` replaces `notes.md`.
 *
 * Any other entry in the folder is an error too.  Left in place, it would keep
 * a folder named after the release that has just become current, which the
 * runner's startup board check rejects; a person decides where it goes.
 */
async function planMoves(plan, topTickets, folder) {
	const backlogDir = join(plan.ticketsDir, 'backlog');
	const byFilename = new Map((await readdir(backlogDir)).map(name => [name.toLowerCase(), name]));
	const bySlug = new Map(topTickets.map(name => [parseSlug(name).toLowerCase(), name]));

	for (const name of [...folder.files].sort(byName)) {
		const from = `backlog/${folder.name}/${name}`;
		const taken = byFilename.get(name.toLowerCase()) ?? bySlug.get(parseSlug(name).toLowerCase());
		if (taken) plan.errors.push(`${from} would collide with backlog/${taken} — keep one copy, or rename one, before shipping`);
		else plan.moves.push({ from, to: `backlog/${name}` });
	}

	const tickets = new Set(folder.files);
	const others = (await readdir(join(backlogDir, folder.name), { withFileTypes: true }))
		.filter(entry => !tickets.has(entry.name))
		.map(entry => `backlog/${folder.name}/${entry.name}${entry.isDirectory() ? '/' : ''}`)
		.sort(byName);
	for (const other of others) {
		plan.errors.push(`${other} is not a ticket, so backlog/${folder.name}/ could not be removed — move or delete it before shipping`);
	}
	plan.removeFolder = `backlog/${folder.name}`;
}

/** Plan removing every header line `target: <shipped>` outside `complete/`. */
async function planStrips(plan) {
	for (const stage of STRIP_STAGES) {
		for (const { entry, folder, path } of await stageFiles(plan.ticketsDir, stage, true)) {
			const content = await readTicketFile(path);
			if (content == null) continue;
			for (const line of targetLinesNaming(content, plan.shipped)) {
				plan.strips.push({ path: `${boardLocation(stage, folder)}${entry}`, line });
			}
		}
	}
	plan.strips.sort((a, b) => byName(a.path, b.path) || a.line - b.line);
}

/**
 * The clean-tree check a committing ship runs first, in `abort` mode: the
 * commit stages everything, so residue would land under `tess: ship release
 * <CODE>`.  With `dryRun` it only reports what a real ship would find.
 */
export function reconcileForShip(repoRoot, { dryRun = false } = {}) {
	return reconcileWorkingTree(repoRoot, { mode: 'abort', dryRun, label: 'release ship', refusal: 'a ship commits the whole tree' });
}

/**
 * Carry out a plan from `planShip`, which must have no errors.  Returns
 * `{ applied, committed }`; `applied: false` means a dirty working tree refused
 * the ship before anything changed, and the refusal has been printed.
 *
 * Unless `noCommit`, the tree must pass `reconcileForShip` first, and the
 * result is committed.  `noCommit` skips both; tracked tickets still move with
 * `git mv`, so their renames are staged.
 *
 * Strips come first, at the paths the plan names, so a stripped ticket that
 * also moves is moved with its line already gone.  The list comes last.
 */
export async function applyShip(plan, { repoRoot, noCommit = false }) {
	if (plan.errors.length > 0) throw new Error(`refusing to apply a ship plan with errors: ${plan.errors.join('; ')}`);
	const { ticketsDir, shipped } = plan;

	if (!noCommit && reconcileForShip(repoRoot).action === 'abort') return { applied: false, committed: false };

	const releases = await readReleases(ticketsDir);
	if (currentRelease(releases) !== shipped) {
		throw new Error(`${RELEASES_PATH} changed since the ship was planned — its first entry is no longer ${shipped}; plan again`);
	}

	await applyStrips(plan);
	await applyMoves(plan);
	await writeFile(join(ticketsDir, RELEASES_FILE), serializeReleases({ ...releases, entries: releases.entries.slice(1) }), 'utf-8');

	const committed = !noCommit && commitAll(repoRoot, shipCommitMessage(shipped), { context: `release ship ${shipped}` });
	return { applied: true, committed };
}

async function applyStrips({ ticketsDir, shipped, strips }) {
	const linesByPath = new Map();
	for (const { path, line } of strips) linesByPath.set(path, [...(linesByPath.get(path) ?? []), line]);

	for (const [path, lines] of linesByPath) {
		const file = join(ticketsDir, path);
		const content = await readFile(file, 'utf-8');
		const naming = new Set(targetLinesNaming(content, shipped));
		const changed = lines.find(line => !naming.has(line));
		if (changed !== undefined) throw new Error(`${path}:${changed} no longer reads target: ${shipped} — the ticket changed since the ship was planned; plan again`);
		await writeFile(file, withoutLines(content, new Set(lines)), 'utf-8');
	}
}

async function applyMoves({ ticketsDir, next, moves, removeFolder }) {
	if (moves.length > 0) {
		const tracked = trackedFiles(ticketsDir, `backlog/${next}`);
		// NOTE: `git mv` keeps a big move under commitAll's deletion guard only while `git status`
		// detects renames, which is git's default.  In a repository with `status.renames=false` each
		// move reads as a deletion, and a folder of more than TESS_MAX_DELETIONS tickets refuses to
		// commit; if that ever bites, raise TESS_MAX_DELETIONS for the ship.
		const byGit = moves.filter(move => tracked.has(move.from)).map(move => move.from);
		for (let i = 0; i < byGit.length; i += GIT_MV_BATCH) {
			execFileSync('git', ['mv', '--', ...byGit.slice(i, i + GIT_MV_BATCH), 'backlog'], { cwd: ticketsDir, stdio: 'pipe' });
		}
		for (const { from, to } of moves.filter(move => !tracked.has(move.from))) {
			if (await exists(join(ticketsDir, to))) throw new Error(`${to} appeared since the ship was planned; plan again`);
			await rename(join(ticketsDir, from), join(ticketsDir, to));
		}
	}
	if (removeFolder) {
		try {
			await rmdir(join(ticketsDir, removeFolder));
		} catch (err) {
			if (err.code !== 'ENOENT') throw err;
		}
	}
}

/**
 * The tracked files under `dir`, as paths relative to `ticketsDir`.  Outside a
 * git repository — reachable only with `noCommit` — nothing is tracked, and
 * every move is a plain rename.
 */
function trackedFiles(ticketsDir, dir) {
	try {
		// LC_ALL=C: the fallback below matches git's English message, which a translated git would not print.
		const env = { ...process.env, LC_ALL: 'C' };
		const out = execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: ticketsDir, encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'] });
		return new Set(out.split('\0').filter(Boolean));
	} catch (err) {
		if (/not a git repository/i.test(String(err.stderr ?? ''))) return new Set();
		throw err;
	}
}

/** `text` without its 1-based `lineNumbers`, each removed with its own line ending, so every other byte is unchanged. */
function withoutLines(text, lineNumbers) {
	return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter((_, i) => !lineNumbers.has(i + 1)).join('');
}

async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch (err) {
		if (err.code === 'ENOENT') return false;
		throw err;
	}
}
