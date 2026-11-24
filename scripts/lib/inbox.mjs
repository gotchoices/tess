/**
 * The human's inbox: every `blocked/` ticket with its decision brief
 * (lib/brief.mjs), plus the two facts about it that are derived rather than
 * stored — which tickets wait on it, and how long it has sat there — and the
 * writes a human's answer makes.
 *
 * Read side: `readInbox` is what the dashboard's Decisions page and the distill
 * pass (scripts/distill.mjs) both list from, so the two never disagree about
 * which tickets have a usable brief.
 *
 * Write side: `recordDecision` writes a human's answer into the ticket and
 * moves it out of `blocked/`, to the stage the answer names; `withdrawDecision`
 * brings it back; `recordAsk` leaves it where it is with a question for the
 * distill pass.  So `blocked/` only ever holds what still waits on a human, and
 * an answered ticket is an ordinary ticket in an ordinary stage: whatever
 * decides which runner works which ticket decides it for this one too, and the
 * runner needs no notion of an answered blocked ticket.
 *
 * Each write commits only the ticket it touched.  The runner's own commits
 * stage the whole tree (lib/git.mjs `commitAll`), so an answer left
 * uncommitted would be swept into whichever ticket finished next, under that
 * ticket's name; a path-scoped commit per answer keeps the tree clean and
 * gives each decision its own line in the history.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { ANSWER_FIELDS, ASK_FIELD, DECISION_DONE, DECISION_OTHER, DESTINATION_STAGES, briefProblems, destinationFor, laneOf, optionFor, otherHeaderFields, parseBrief, parseDestination, setHeaderFields } from './brief.mjs';
import { doneFieldOf, readProjectRules } from './project-rules.mjs';
import { rankOf, readReleases } from './releases.mjs';
import { stageArrivals } from './stage-arrivals.mjs';
import { readInProgress } from './state.mjs';
import { headerField, indexAllTickets, parseListField, parsePrereqs, parseSequence, parseSlug, readTicketFile, stageFiles } from './tickets.mjs';

const BLOCKED = 'blocked';
const SECONDS_PER_DAY = 86400;
/** How long an answered ticket sent to `complete/` or `backlog/` stays listed as decided, so a wrong click can still be withdrawn. */
const DECIDED_VISIBLE_DAYS = 7;
/** The stages an agent works: an answered ticket there is listed until the agent applies the answer and drops the field. */
const WORKING_STAGES = ['fix', 'plan', 'implement', 'review'];

const invalid = message => Object.assign(new Error(message), { code: 'EINVAL' });
const missing = message => Object.assign(new Error(message), { code: 'ENOENT' });
const pathExists = async path => access(path).then(() => true, () => false);

/**
 * For each slug parked in `blocked/`, the live tickets whose prereq chain
 * reaches it, as `slug → [{ slug, stage }]` in index order.  `index` is
 * `indexAllTickets(ticketsDir, { withPrereqs: true })`.  Tickets in `complete/`
 * wait on nothing; a blocked ticket waiting on another blocked ticket is
 * listed, since answering the second is what makes the first answerable.
 */
export function waitingOnBlocked(index) {
	const waiting = new Map();
	for (const [slug, record] of index) {
		if (record.pruned || record.stage === 'complete' || !record.prereqs?.length) continue;
		const visited = new Set([slug]);
		const stack = [...record.prereqs];
		while (stack.length > 0) {
			const prereq = stack.pop();
			if (visited.has(prereq)) continue;
			visited.add(prereq);
			const found = index.get(prereq);
			if (!found || found.pruned) continue;
			if (found.stage === BLOCKED) {
				if (!waiting.has(prereq)) waiting.set(prereq, []);
				waiting.get(prereq).push({ slug, stage: record.stage });
			}
			for (const next of found.prereqs ?? []) stack.push(next);
		}
	}
	return waiting;
}

/** The first `# heading` of a ticket's body, or null: the title its author gave it. */
function bodyTitle(content) {
	const match = content.match(/^#[ \t]+(.+?)[ \t]*$/m);
	return match ? match[1] : null;
}

/**
 * The paths a ticket's `files:` header names, without the notes agents write
 * after them (`src/a.ts (the parser, ~l.40)` → `src/a.ts`).  Comma-separated
 * and list forms both; anything that does not look like a path is dropped.
 */
export function ticketFilePaths(content) {
	const inline = headerField(content, 'files');
	const items = inline ? splitOutsideParens(inline) : parseListField(content, 'files');
	return items
		.map(item => item.trim().split(/[\s(#,]/)[0])
		.filter(path => /^[\w.@-]+(\/[\w.@ -]+)+$/.test(path) || /^[\w.@-]+\.\w+$/.test(path));
}

/** Split on commas that are not inside parentheses, so a note's own commas do not start a new item. */
function splitOutsideParens(text) {
	const items = [];
	let depth = 0, current = '';
	for (const ch of text) {
		if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		if (ch === ',' && depth === 0) {
			items.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	items.push(current);
	return items;
}

/**
 * Every ticket in `blocked/`, as inbox entries in file-name order:
 *
 *   { file, slug, sequence, path, stage, folder, title, description, brief,
 *     problems, lane, defaultTo, waiting: [{ slug, stage }], ageDays, prereqs,
 *     fields }
 *
 * `problems` is what the brief lacks (`briefProblems`), `lane` where the
 * dashboard files it (`laneOf`), `defaultTo` where an answer sends the ticket
 * when the chosen option names no stage of its own (`destinationFor`),
 * `ageDays` whole days since it arrived in `blocked/` (null when no commit has
 * put it there), and `fields` the header fields the project keeps beside the
 * brief (`otherHeaderFields`).
 */
export async function readInbox(ticketsDir, { nowSeconds = Math.floor(Date.now() / 1000), warn = console.warn } = {}) {
	const [files, index, arrivals] = await Promise.all([
		stageFiles(ticketsDir, BLOCKED, false),
		indexAllTickets(ticketsDir, { withPrereqs: true }),
		stageArrivals(ticketsDir, BLOCKED, { warn: message => warn(`warning: ${message} — blocked ticket ages are unknown`) }),
	]);
	const waiting = waitingOnBlocked(index);

	const entries = [];
	for (const { entry, path } of files) {
		const content = await readTicketFile(path);
		if (content == null) continue;  // moved between listing and reading
		const slug = parseSlug(entry);
		const brief = parseBrief(content);
		const problems = briefProblems(brief);
		const arrival = arrivals.get(slug);
		entries.push({
			...entryOf({ entry, path, stage: BLOCKED, folder: null }, content, brief),
			problems,
			lane: laneOf(brief, problems),
			waiting: waiting.get(slug) ?? [],
			ageDays: arrival == null ? null : Math.max(0, Math.floor((nowSeconds - arrival) / SECONDS_PER_DAY)),
		});
	}
	return entries;
}

/** The part of an inbox entry read from the ticket alone, wherever it sits. */
function entryOf({ entry, path, stage, folder }, content, brief) {
	const slug = parseSlug(entry);
	return {
		file: entry,
		slug,
		sequence: parseSequence(entry),
		path,
		stage,
		folder,
		title: bodyTitle(content),
		description: headerField(content, 'description') || null,
		brief,
		problems: [],
		lane: 'decided',
		defaultTo: destinationFor(brief, null, slug),
		waiting: [],
		ageDays: null,
		prereqs: parsePrereqs(content),
		fields: otherHeaderFields(content, ['description', 'prereq', 'dependencies', 'files']),
	};
}

/** Whole days from the date in `decided: <who>, <YYYY-MM-DD>` to now, or null when the field holds no date. */
function daysSinceDecided(decided, nowSeconds) {
	const match = decided?.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (!match) return null;
	const then = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
	return Math.floor((nowSeconds - then) / SECONDS_PER_DAY);
}

/**
 * The answered tickets that are no longer in `blocked/`: every ticket outside
 * it whose header still carries `decision:`, as inbox entries with `lane:
 * 'decided'` and the `stage` (and backlog `folder`) the answer sent them to.
 *
 * In a working stage that means "answered, not yet applied": the agent that
 * picks the ticket up applies the answer and drops the field.  `complete/` and
 * `backlog/` are worked by nobody, so an answer sent there keeps its field for
 * good; those are listed for `DECIDED_VISIBLE_DAYS` after the answer, long
 * enough to withdraw a wrong one.
 *
 * NOTE: reads every ticket in six stages on each call (a few hundred small
 * files on a busy board).  If the dashboard's inbox load is ever felt, list
 * candidates with one `git grep -l '^decision:'` and read only those.
 */
export async function readDecided(ticketsDir, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
	const entries = [];
	for (const stage of [...WORKING_STAGES, 'backlog', 'complete']) {
		for (const file of await stageFiles(ticketsDir, stage, true)) {
			const content = await readTicketFile(file.path);
			if (content == null) continue;
			const brief = parseBrief(content);
			if (!brief.decision) continue;
			if (!WORKING_STAGES.includes(stage)) {
				const days = daysSinceDecided(brief.decided, nowSeconds);
				if (days == null || days > DECIDED_VISIBLE_DAYS) continue;
			}
			entries.push(entryOf({ ...file, stage }, content, brief));
		}
	}
	return entries;
}

/**
 * Every destination an answer can be sent to on this board, for the
 * dashboard's override control: the destination stages, plus one
 * `backlog/<CODE>` per later release in `tickets/releases.md`.
 */
export async function availableDestinations(ticketsDir) {
	const releases = await readReleases(ticketsDir);
	const later = releases.present ? releases.entries.slice(1).map(entry => `backlog/${entry.code}`) : [];
	return [...DESTINATION_STAGES, ...later];
}

/**
 * Resolve a destination to the directory it names, or throw `EINVAL`.  A
 * `backlog/<CODE>` must be a later release listed in `tickets/releases.md`:
 * agents and the dashboard never create a release folder the board would then
 * reject (lib/board-check.mjs).
 */
async function resolveDestination(ticketsDir, destination) {
	const parsed = parseDestination(destination);
	if (!parsed) throw invalid(`"${destination}" is not a stage an answered ticket can go to (${DESTINATION_STAGES.join(', ')}, or backlog/<CODE>)`);
	const [stage, folder] = parsed.split('/');
	if (folder) {
		const releases = await readReleases(ticketsDir);
		if (!releases.present || rankOf(releases, folder) < 1) throw invalid(`backlog/${folder} is not a later release listed in tickets/releases.md`);
	}
	return { destination: parsed, dir: folder ? join(ticketsDir, stage, folder) : join(ticketsDir, stage) };
}

/**
 * Which of `paths` (repo-relative files or directories) have a commit after
 * the end of `date` (`YYYY-MM-DD`), read with one `git log` in `repoRoot`.
 * Empty when nothing changed, when `date` is not a date, or when git fails —
 * a ticket is then simply not re-checked for this reason.
 *
 * NOTE: the cut is the end of the day, so a change landing later on the day a
 * ticket was checked is missed.  The start of the day would instead re-check
 * every ticket whose files changed earlier that same day, on every pass, for
 * good; if same-day drift is ever seen, have `checked:` carry a commit hash.
 */
export function pathsChangedSince(repoRoot, paths, date) {
	if (paths.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return [];
	let log;
	try {
		log = execFileSync('git', ['-c', 'core.quotePath=false', 'log', `--since=${date}T23:59:59`, '--name-only', '--format=', '--', ...paths],
			{ cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
	} catch {
		return [];
	}
	const touched = new Set(log.split(/\r?\n/).filter(Boolean));
	return paths.filter(path => [...touched].some(file => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`)));
}

/**
 * Why the distill pass should work an inbox entry now, as plain statements —
 * empty when it should be left alone.  A decided ticket is never due: its next
 * reader is the agent applying the answer.  `changedPaths` is
 * `pathsChangedSince` for the entry's `files:`; `all` asks for a re-check of
 * tickets nothing else marks.
 */
export function distillReasons(entry, { changedPaths = [], all = false } = {}) {
	if (entry.brief.decision) return [];
	const reasons = [];
	if (entry.problems.length > 0) reasons.push(`its brief is missing or incomplete: ${entry.problems.join('; ')}`);
	if (entry.brief.ask) reasons.push(`the human sent a question back instead of an answer: "${entry.brief.ask}"`);
	if (changedPaths.length > 0) reasons.push(`files it names changed after it was last checked (${entry.brief.checked}): ${changedPaths.join(', ')}`);
	if (reasons.length === 0 && all) reasons.push('a full re-check was requested (--all)');
	return reasons;
}

/**
 * The blocked tickets the distill pass would work now, as `{ entry, reasons,
 * difficulty }` in the order it works them: most tickets waiting first, then
 * longest in `blocked/`.  `only` (a set of slugs) names tickets outright, so a
 * named ticket is included even when nothing marks it due; `all` includes
 * every unanswered ticket.  Never one a human has answered.  `inbox` is
 * `readInbox`'s result when the caller already has it.
 *
 * The script and the dashboard's Distill button both list from this, so the
 * count on the button is the number of agent runs it starts.
 */
export async function dueForDistill(ticketsDir, { only = null, all = false, inbox = null } = {}) {
	const repoRoot = dirname(ticketsDir);
	const due = [];
	for (const entry of inbox ?? await readInbox(ticketsDir)) {
		if (only && !only.has(entry.slug)) continue;
		const content = await readTicketFile(entry.path);
		if (content == null) continue;
		const changedPaths = pathsChangedSince(repoRoot, ticketFilePaths(content), entry.brief.checked);
		const reasons = distillReasons(entry, { changedPaths, all: all || only != null });
		if (reasons.length > 0) due.push({ entry, reasons, difficulty: headerField(content, 'difficulty')?.toLowerCase() || null });
	}
	due.sort((a, b) =>
		b.entry.waiting.length - a.entry.waiting.length
		|| (b.entry.ageDays ?? -1) - (a.entry.ageDays ?? -1)
		|| (a.entry.slug < b.entry.slug ? -1 : 1));
	return due;
}

/**
 * The distill pass's own stop request: a file under `tickets/.logs/`, which is
 * git-ignored, so asking never dirties the tree.  Not `tickets/.stop`: that one
 * is the runner's, and a pass that honoured it would also consume it, leaving
 * a runner in the same checkout running after it was asked to halt.
 */
const distillStopPath = ticketsDir => join(ticketsDir, '.logs', 'distill.stop');

/** Ask a running distill pass to stop once the ticket it is on has finished. */
export async function requestDistillStop(ticketsDir) {
	await mkdir(join(ticketsDir, '.logs'), { recursive: true });
	await writeFile(distillStopPath(ticketsDir), new Date().toISOString(), 'utf-8');
}

/** True, removing the request, when a stop has been asked for.  Called at a pass's start to drop a stale one, and before each ticket. */
export async function takeDistillStop(ticketsDir) {
	return unlink(distillStopPath(ticketsDir)).then(() => true, () => false);
}

/** One inbox entry by file name, or null when `blocked/` holds no such ticket. */
export async function readInboxEntry(ticketsDir, file, options) {
	return (await readInbox(ticketsDir, options)).find(entry => entry.file === file) ?? null;
}

/** The name an answer is signed with: git's `user.name` for this checkout, else the OS account. */
export function currentUserName(repoRoot) {
	try {
		const name = execFileSync('git', ['config', 'user.name'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
		if (name) return name;
	} catch { /* no git, or no name configured */ }
	return userInfo().username;
}

/** Today as `YYYY-MM-DD` in local time — the date a human would write. */
export function today(date = new Date()) {
	const pad = n => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const LOCK_RETRIES = 5;
const LOCK_WAIT_MS = 400;

/**
 * Commit exactly these paths — one ticket's old and new place — whatever else
 * is modified or staged in the tree.  A path that exists is `git add`ed first,
 * so an untracked ticket can be committed; a path that is gone is committed as
 * a deletion; a path that neither exists nor was ever tracked (the old place of
 * a ticket nobody had committed) is left out, since naming it would fail the
 * commit.  `--only` then limits the commit to those paths.  A runner sharing
 * the checkout holds `index.lock` for moments at a time, so a lock failure is
 * retried briefly.  Returns `{ committed, error }` — never throws: the write
 * has already happened, and the caller reports a commit that did not follow it.
 */
export function commitPaths(repoRoot, paths, message) {
	const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' });
	const rels = [...new Set(paths.map(path => relative(repoRoot, path).replace(/\\/g, '/')))];
	for (let attempt = 0; ; attempt++) {
		try {
			const present = rels.filter(rel => existsSync(join(repoRoot, rel)));
			const known = rels.filter(rel => present.includes(rel) || git(['ls-files', '--', rel]).trim() !== '');
			if (known.length === 0) return { committed: false, error: null };
			if (present.length > 0) git(['add', '--', ...present]);
			git(['commit', '--only', '-m', message, '--', ...known]);
			return { committed: true, error: null };
		} catch (err) {
			const output = `${err.stderr ?? ''}${err.stdout ?? ''}` || err.message;
			if (/index\.lock/.test(output) && attempt < LOCK_RETRIES) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
				continue;
			}
			if (/nothing to commit|no changes added|nothing added to commit/.test(output)) return { committed: false, error: null };
			// git's first line names the cause (`fatal: Unable to create …/index.lock`); the rest is advice.
			const lines = output.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
			return { committed: false, error: (lines.find(line => /^(fatal|error):/.test(line)) ?? lines[0] ?? 'git commit failed').slice(0, 300) };
		}
	}
}

const NOT_COMMITTED = { committed: false, error: null };

/**
 * Absolute paths, outside `blocked/`, where git still tracks a ticket file of
 * this name that is gone from the working tree — the place a ticket left when
 * it was moved back to `blocked/` and the commit recording the move failed.
 * Empty when there is none, or when git cannot be asked.
 */
function deletedCopiesOf(repoRoot, ticketsDir, file) {
	const tickets = relative(repoRoot, ticketsDir).replace(/\\/g, '/');
	try {
		const listed = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--deleted', '--', `${tickets}/*/${file}`, `${tickets}/backlog/*/${file}`],
			{ cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' });
		return listed.split(/\r?\n/).filter(rel => rel && !rel.startsWith(`${tickets}/${BLOCKED}/`)).map(rel => join(repoRoot, rel));
	} catch {
		return [];
	}
}

/** `file` must be a bare ticket file name: the dashboard passes it from a URL, and it is joined onto a stage folder. */
function assertTicketName(file) {
	if (typeof file !== 'string' || file !== basename(file) || !file.endsWith('.md')) throw invalid(`not a ticket file name: ${file}`);
}

/** `stage` or `stage/folder`: where an index record sits, in the spelling a destination uses. */
const placeOf = record => (record.folder ? `${record.stage}/${record.folder}` : record.stage);

/** The project's `done-field:` when `decision` is `done`, else null: the field a performed step is also recorded in. */
async function doneFieldFor(ticketsDir, decision) {
	if (decision?.toLowerCase() !== DECISION_DONE) return null;
	return doneFieldOf((await readProjectRules(ticketsDir)).rules).doneField;
}

/**
 * Record a human's answer to a blocked ticket and send the ticket where the
 * answer says it goes.
 *
 * The header gets `decision:` (an option key, `other`, or `done`), an optional
 * `decision-note:` and `decided: <who>, <date>`; an open `ask:` is cleared,
 * since the answer supersedes the question.  The file then moves out of
 * `blocked/` to `to` when the caller names a destination, otherwise to the one
 * the brief gives for this answer (lib/brief.mjs `destinationFor`), and the
 * move is committed on its own.  From there it is an ordinary ticket: the agent
 * that picks it up applies the answer (agent-rules/tickets.md § *A ticket that
 * arrives with a decision*).  Sent to `complete/`, it is simply closed.
 *
 * Returns `{ path, changed, movedTo, committed, error }`.  Giving the same
 * answer again after its commit failed finds the ticket where the first try
 * put it and commits that; anything else about a ticket no longer in
 * `blocked/` is `ENOENT`.
 */
export async function recordDecision(ticketsDir, file, { decision, note = null, who, date = today(), to = null, commit = true }) {
	const value = String(decision ?? '').trim();
	if (!value) throw invalid('a decision needs a value: an option key, "other" or "done"');
	assertTicketName(file);
	const repoRoot = dirname(ticketsDir);
	const slug = parseSlug(file);
	const from = join(ticketsDir, BLOCKED, file);
	const subject = place => `decision: ${slug} — ${value} → ${place}`;
	const index = await indexAllTickets(ticketsDir);
	const found = index.get(slug);

	const content = await readTicketFile(from);
	if (content == null) {
		const moved = found && !found.pruned ? await readTicketFile(found.path) : null;
		if (moved == null || parseBrief(moved).decision?.toLowerCase() !== value.toLowerCase()) throw missing(`${file} is no longer in blocked/`);
		const retried = commit ? commitPaths(repoRoot, [from, found.path], subject(placeOf(found))) : NOT_COMMITTED;
		return { path: found.path, changed: false, movedTo: placeOf(found), ...retried };
	}
	// The index resolves a slug to its most advanced copy, so anything but blocked/ here is a second file.
	if (found && found.stage !== BLOCKED) throw invalid(`${slug} is also filed in ${placeOf(found)}/ — remove one copy before answering`);

	// A page left open while the distill pass rewrote the brief could send a key the ticket no
	// longer has, and an agent would then apply an answer nobody gave.  (A field written by hand in
	// an editor is not checked: the applying agent reads an unknown value with its note.)
	const brief = parseBrief(content);
	if (![DECISION_OTHER, DECISION_DONE].includes(value.toLowerCase()) && !optionFor(brief, value)) {
		const keys = brief.options.map(o => o.key).join(', ') || 'none';
		throw invalid(`"${value}" is not one of this ticket's options (${keys}) — reload, or answer "other" with a note`);
	}

	const { destination, dir } = await resolveDestination(ticketsDir, to ?? destinationFor(brief, value, slug));
	const target = join(dir, file);
	if (await pathExists(target)) throw invalid(`${destination}/ already holds a ${file}`);

	// A project that records a performed step in a field of its own (`done-field:` in
	// tickets/rules/) gets it written here, in the same one-ticket commit as the answer.
	const doneField = await doneFieldFor(ticketsDir, value);
	const updated = setHeaderFields(content, {
		decision: value,
		'decision-note': note?.trim() || null,
		decided: `${who}, ${date}`,
		[ASK_FIELD]: null,
		...(doneField ? { [doneField]: `${who}, ${date}` } : {}),
	});
	await mkdir(dir, { recursive: true });
	await writeFile(target, updated, 'utf-8');
	await unlink(from);
	const result = commit ? commitPaths(repoRoot, [from, target], subject(destination)) : NOT_COMMITTED;
	return { path: target, changed: true, movedTo: destination, ...result };
}

/**
 * Take an answer back: the ticket returns to `blocked/` without its three
 * answer fields — and, after a `done` answer, without the project's
 * `done-field:` that `recordDecision` wrote beside them.  `file` names the
 * ticket by the file name it had in `blocked/`; it is found by slug wherever
 * the answer sent it.
 *
 * Possible only while the ticket still carries `decision:`.  Once an agent has
 * applied the answer the field is gone and so is the question; that is undone
 * like any other work, not here.  A ticket this checkout's runner is working
 * right now is refused rather than pulled out from under its agent.
 */
export async function withdrawDecision(ticketsDir, file, { commit = true } = {}) {
	assertTicketName(file);
	const slug = parseSlug(file);
	const found = (await indexAllTickets(ticketsDir)).get(slug);
	const content = found && !found.pruned ? await readTicketFile(found.path) : null;
	if (content == null) throw missing(`no ticket "${slug}" on the board`);
	const brief = parseBrief(content);
	if (!brief.decision) {
		// Unanswered and in blocked/ is also what an earlier withdrawal looks like when its commit
		// failed: the file is back, the place it left is deleted but not committed.  Withdrawing
		// again is how that is retried, so commit that pair if it is there.
		const left = found.stage === BLOCKED && commit ? deletedCopiesOf(dirname(ticketsDir), ticketsDir, found.file) : [];
		if (left.length > 0) {
			const retried = commitPaths(dirname(ticketsDir), [...left, found.path], `decision: ${slug} — withdrawn`);
			if (retried.committed || retried.error) return { path: found.path, changed: false, movedTo: BLOCKED, ...retried };
		}
		throw invalid(`${slug} (${placeOf(found)}/) carries no decision: — it was never answered, or an agent has already applied the answer`);
	}
	if ((await readInProgress(ticketsDir))?.slug === slug) throw invalid(`${slug} is being worked by the runner right now — withdraw it once that ticket finishes`);

	const doneField = await doneFieldFor(ticketsDir, brief.decision);
	const updated = setHeaderFields(content, {
		...Object.fromEntries(ANSWER_FIELDS.map(name => [name, null])),
		...(doneField ? { [doneField]: null } : {}),
	});
	const back = join(ticketsDir, BLOCKED, found.file);
	if (found.stage !== BLOCKED && await pathExists(back)) throw invalid(`blocked/ already holds a ${found.file}`);
	await mkdir(dirname(back), { recursive: true });
	await writeFile(back, updated, 'utf-8');
	if (found.stage !== BLOCKED) await unlink(found.path);
	const result = commit ? commitPaths(dirname(ticketsDir), [found.path, back], `decision: ${slug} — withdrawn`) : NOT_COMMITTED;
	return { path: back, changed: true, movedTo: BLOCKED, ...result };
}

/**
 * Send a question back instead of an answer: `ask: <question>` on a ticket
 * that stays in `blocked/`.  The distill pass treats a ticket carrying one as
 * due, answers it by revising the brief and the body, and removes the field.
 * Asking the same question again after its commit failed commits it.
 */
export async function recordAsk(ticketsDir, file, { question, commit = true }) {
	const value = String(question ?? '').trim();
	if (!value) throw invalid('ask needs a question');
	assertTicketName(file);
	const path = join(ticketsDir, BLOCKED, file);
	const content = await readTicketFile(path);
	if (content == null) throw missing(`${file} is no longer in blocked/`);
	const updated = setHeaderFields(content, { [ASK_FIELD]: value });
	const changed = updated !== content;
	if (changed) await writeFile(path, updated, 'utf-8');
	const result = commit ? commitPaths(dirname(ticketsDir), [path], `ask: ${parseSlug(file)}`) : NOT_COMMITTED;
	return { path, changed, movedTo: null, ...result };
}
