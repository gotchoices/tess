/**
 * Ticket discovery and parsing.
 *
 * Encapsulates the on-disk shape of a ticket: stage folder, optional backlog
 * sub-folder, optional sequence prefix, slug, and the header fields.  All
 * filesystem-touching reads for the snapshot live here.
 *
 * NOTE: 592 lines (`wc -l`, 2026-09-14; 405 before release folders) mixing discovery, prereq
 * resolution and header parsing; if it grows further, move header parsing (`headerBounds`,
 * `headerField*`, `parseListField`, the `parse*` fields) into its own module.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readTombstones } from './tombstones.mjs';
import { readReleases, releasePlacement } from './releases.mjs';

/** Default stages from which to pull tickets (backlog excluded — parked by design). */
export const PENDING_STAGES = ['review', 'implement', 'fix', 'plan'];

/** All valid stage names (for --stages validation). */
export const KNOWN_STAGES = ['backlog', 'fix', 'plan', 'implement', 'review', 'complete', 'blocked'];

/** Map from stage → next stage in the pipeline (for prompt context). */
export const NEXT_STAGE = {
	backlog: 'plan',
	fix: 'implement',
	plan: 'implement',
	implement: 'review',
	review: 'complete',
};

/**
 * Pipeline rank for cross-stage prereq satisfaction.  `fix` and `plan` share
 * rank 1 because they're peer feeders into `implement` — neither is "ahead"
 * of the other.  `blocked` is intentionally absent: a prereq parked in
 * `blocked/` is treated as unsatisfied regardless of the dependent's stage.
 */
export const STAGE_RANK = {
	backlog: 0,
	fix: 1,
	plan: 1,
	implement: 2,
	review: 3,
	complete: 4,
};

/**
 * Cross-stage prereq satisfaction.
 *
 * A prereq P satisfies a dependent T (cross-stage) when P sits in a strictly
 * later pipeline rank than T.  Same-stage edges return `true` here because
 * in-stage ordering is enforced separately by the topo sort.  Anything in
 * `blocked/`, in `backlog/` (rank 0 < anything), or in a peer-but-different
 * stage (e.g. T in plan, P in fix — both rank 1) returns `false`.
 *
 * Stage names not in `STAGE_RANK` (notably `blocked`) are treated as
 * unsatisfied.
 */
export function isPrereqSatisfied(prereqStage, ticketStage) {
	if (prereqStage === ticketStage) return true;  // in-stage handled by topo sort
	const pr = STAGE_RANK[prereqStage];
	const tr = STAGE_RANK[ticketStage];
	if (pr == null || tr == null) return false;
	return pr > tr;
}

/** `stage/` or `stage/folder/` — where a ticket sits, as the runner prints it. */
export function boardLocation(stage, folder) {
	return folder ? `${stage}/${folder}/` : `${stage}/`;
}

/** `readdir` with file types, or null when the directory is missing, unreadable, or raced away. */
async function readDirents(dir) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return null;
	}
}

const isTicketFile = d => !d.isDirectory() && d.name.endsWith('.md');
// NOTE: a symlinked backlog sub-folder is neither indexed nor validated (`Dirent.isDirectory()` is false
// for a link); if a project ever symlinks release folders, stat links here.
const isSubfolder = d => d.isDirectory() && !d.name.startsWith('.');
/** Code-unit order: identical on every platform and filesystem, and case-sensitive like release codes. */
export const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The layout of `backlog/`: its top-level ticket files, and each immediate
 * sub-folder (dot-folders skipped) with its ticket files and the directories
 * nested inside it.  Folders come in name order, files in directory order.
 * Discovery never reads deeper than one level; `nested` exists so the board
 * check can say what is being ignored.
 */
export async function readBacklogLayout(ticketsDir) {
	const backlogDir = join(ticketsDir, 'backlog');
	const dirents = await readDirents(backlogDir) ?? [];
	const folders = [];
	for (const name of dirents.filter(isSubfolder).map(d => d.name).sort(byName)) {
		const inner = await readDirents(join(backlogDir, name));
		if (!inner) continue;  // raced with a remove/rename
		folders.push({
			name,
			files: inner.filter(isTicketFile).map(d => d.name),
			nested: inner.filter(isSubfolder).map(d => d.name).sort(byName),
		});
	}
	return { top: dirents.filter(isTicketFile).map(d => d.name), folders };
}

/**
 * Every ticket file of one stage as `{ entry, folder, path }`: the top level
 * first, then — for `backlog` with `includeFolders` — each sub-folder's files,
 * folders in name order.
 */
export async function stageFiles(ticketsDir, stage, includeFolders) {
	const stageDir = join(ticketsDir, stage);
	if (stage === 'backlog' && includeFolders) {
		const { top, folders } = await readBacklogLayout(ticketsDir);
		return [
			...top.map(entry => ({ entry, folder: null, path: join(stageDir, entry) })),
			...folders.flatMap(({ name, files }) => files.map(entry => ({ entry, folder: name, path: join(stageDir, name, entry) }))),
		];
	}
	const dirents = await readDirents(stageDir) ?? [];
	return dirents.filter(isTicketFile).map(d => ({ entry: d.name, folder: null, path: join(stageDir, d.name) }));
}

/** A ticket file's text, or null when it was removed or moved between listing and reading. */
export async function readTicketFile(path) {
	try {
		return await readFile(path, 'utf-8');
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * One-shot scan of every known stage folder, returning `slug → record`, where
 * a record is `{ stage, file, folder, releaseRank, release }`.
 *
 * When the same slug appears in multiple stages (e.g. an agent split or a
 * stale duplicate), the most-advanced copy wins — iteration runs in reverse
 * pipeline order so a slug found in `complete/` masks one still sitting in
 * `plan/`.  Used to resolve cross-stage prereq edges that aren't in the
 * snapshot's own stage bucket.
 *
 * Backlog sub-folders are always included — the runner never processes their
 * tickets, but a prereq naming one must resolve to where it sits rather than
 * read as unknown.  Within `backlog`, top-level entries come before folder
 * entries and folders go in name order; the first copy of a slug wins.
 *
 * Pass `{ withPrereqs: true }` to also read each ticket's `prereq:` header,
 * which lets callers walk the prereq DAG across stages (e.g. transitive
 * blocked-detection).  This costs one read per ticket and is opt-in.
 *
 * Tickets pruned out of `complete/` are folded in last, from the tombstone
 * ledger, as `{ stage: 'complete', pruned: true, … }` records with no `file`.
 * Without them a landed-then-pruned prereq reads exactly like a slug that
 * never existed.  They are added last so a live board entry always wins — a
 * slug reopened after a prior completion resolves to where it actually is.
 */
const STAGE_INDEX_ORDER = ['complete', 'review', 'implement', 'fix', 'plan', 'backlog', 'blocked'];
export async function indexAllTickets(ticketsDir, { withPrereqs = false } = {}) {
	const releases = await readReleases(ticketsDir);
	const index = new Map();
	for (const stage of STAGE_INDEX_ORDER) {
		for (const { entry, folder, path } of await stageFiles(ticketsDir, stage, true)) {
			const slug = parseSlug(entry);
			if (index.has(slug)) continue;
			const record = { stage, file: entry, folder, ...releasePlacement(releases, folder) };
			if (withPrereqs) {
				const content = await readTicketFile(path);
				if (content == null) continue;
				record.prereqs = parsePrereqs(content);
			}
			index.set(slug, record);
		}
	}
	for (const [slug, tomb] of await readTombstones(ticketsDir)) {
		if (index.has(slug)) continue;
		index.set(slug, {
			stage: 'complete',
			file: null,
			folder: null,
			releaseRank: 0,
			release: null,
			pruned: true,
			completedAt: tomb.completedAt ?? null,
			commit: tomb.commit ?? null,
			...(withPrereqs ? { prereqs: [] } : {}),
		});
	}
	return index;
}

/**
 * `--shard k/n` membership: a stable hash of the slug, so two runners on
 * separate clones given `0/2` and `1/2` split every stage between them without
 * ever picking the same ticket, and a ticket keeps its runner as it moves
 * through stages.
 */
export function inShard(slug, shard) {
	if (!shard) return true;
	let h = 0x811c9dc5;  // FNV-1a
	for (let i = 0; i < slug.length; i++) {
		h ^= slug.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h % shard.count === shard.index;
}

/**
 * Walk a ticket's prereq chain across the cross-stage index and return the
 * first slug that's parked in `blocked/`, or `null` if no path leads there.
 *
 * The index must be built with `{ withPrereqs: true }` so we have each
 * ticket's outgoing edges.  Slugs absent from the index terminate that
 * branch (assumed already complete or a stale reference).  Cycles are
 * tolerated via the visited set; the topo sort is responsible for rejecting
 * cycles among in-snapshot tickets.
 */
export function findTransitiveBlocker(ticket, index) {
	const visited = new Set();
	const stack = [...ticket.prereqs];
	while (stack.length > 0) {
		const slug = stack.pop();
		if (visited.has(slug)) continue;
		visited.add(slug);
		const found = index.get(slug);
		if (!found) continue;
		if (found.stage === 'blocked') return { slug };
		if (Array.isArray(found.prereqs)) {
			for (const p of found.prereqs) stack.push(p);
		}
	}
	return null;
}

/**
 * Resolve every prereq of `ticket` against the cross-stage index, returning
 * one record per slug with a `status`:
 *
 *   - `satisfied`     — on the board in a strictly later rank (or the same
 *      stage and backlog folder, where the topo sort orders it).
 *   - `behind`        — on the board but at a lower/peer rank, in `blocked/`,
 *      or in a different backlog folder from a same-stage dependent.
 *   - `release-order` — deferred to a later release than the ticket itself
 *      (a higher `releaseRank`), so it can never land first whatever its
 *      stage.  Unsatisfied.  Carries `folder` (the prereq's release) and
 *      `dueIn` / `dueFolder` (the ticket's release, and its folder when that
 *      release is deferred too) for the message.
 *   - `pruned`        — not on the board but carrying a tombstone: it completed
 *      and was later swept out of `complete/`.  Satisfied, and carries
 *      `completedAt` / `commit` so the runner can say so out loud.
 *   - `unknown`       — matches neither the board nor a tombstone.  Treated as
 *      satisfied (the historical assumption: already complete, or a stale
 *      reference), but reported, since it is the one case nothing can vouch
 *      for.
 */
export function resolvePrereqs(ticket, index) {
	const ticketRank = ticket.releaseRank ?? 0;
	return ticket.prereqs.map(slug => {
		const found = index.get(slug);
		if (!found) return { slug, status: 'unknown' };
		if (found.pruned) {
			return { slug, status: 'pruned', stage: found.stage, completedAt: found.completedAt, commit: found.commit };
		}
		if ((found.releaseRank ?? 0) > ticketRank) {
			return {
				slug,
				status: 'release-order',
				stage: found.stage,
				folder: found.folder,
				dueIn: ticket.release ?? null,
				dueFolder: ticketRank > 0 ? ticket.folder : null,
			};
		}
		return { slug, status: boardStatus(found, ticket), stage: found.stage, folder: found.folder ?? null };
	});
}

/**
 * `satisfied` or `behind` for a prereq on the board.  A same-stage edge is
 * left to the topo sort — but the sort only ever sees one stage's top level,
 * so a prereq in a different backlog folder from its dependent has nothing
 * ordering it and is behind.  (A top-level backlog ticket whose prereq is
 * parked in a curated folder must not be promoted ahead of it.)
 */
function boardStatus(found, ticket) {
	if (found.stage !== ticket.stage) return isPrereqSatisfied(found.stage, ticket.stage) ? 'satisfied' : 'behind';
	return (found.folder ?? null) === (ticket.folder ?? null) ? 'satisfied' : 'behind';
}

/** Resolution statuses that defer the dependent. */
const UNSATISFIED_STATUSES = new Set(['behind', 'release-order']);

/** The first resolution that defers its dependent, or null. */
export function firstUnsatisfied(resolutions) {
	return resolutions.find(r => UNSATISFIED_STATUSES.has(r.status)) ?? null;
}

function releaseOrderMessage(r) {
	return `prereq "${r.slug}" is deferred to release ${r.folder} (backlog/${r.folder}/) but this ticket is due in ${r.dueIn}`
		+ ` — pull the prereq into ${boardLocation('backlog', r.dueFolder)} or defer this ticket to backlog/${r.folder}/`;
}

/**
 * Why an unsatisfied resolution defers its dependent, as one clause.  The
 * runner's deferral log, the dry-run and the board check all print this, so
 * the same situation always reads the same way.
 */
export function deferralReason(r) {
	return r.status === 'release-order'
		? releaseOrderMessage(r)
		: `prereq "${r.slug}" is in ${boardLocation(r.stage, r.folder)}`;
}

/**
 * One log line per prereq whose resolution is worth saying out loud — the
 * pruned ones (so a landed prereq never reads as missing work), the unknown
 * ones (so a genuinely unresolvable slug stays visible instead of being
 * silently assumed complete), and the release-order ones (so the fix — move
 * one ticket or the other — is spelled out).  Otherwise board-resolved prereqs
 * produce nothing; their state is already evident from the board.
 */
export function prereqNotes(resolutions) {
	const notes = [];
	for (const r of resolutions) {
		if (r.status === 'pruned') {
			const when = r.completedAt ?? 'unknown date';
			const commit = r.commit ? `, commit ${r.commit.slice(0, 8)}` : '';
			notes.push(`prereq "${r.slug}": completed ${when}, pruned${commit}`);
		} else if (r.status === 'unknown') {
			notes.push(`prereq "${r.slug}": not on the board and no tombstone — unknown, assumed complete`);
		} else if (r.status === 'release-order') {
			notes.push(releaseOrderMessage(r));
		}
	}
	return notes;
}

/**
 * Resolve a ticket's prereqs against the cross-stage index and return the
 * first one that defers it: *behind* (lower rank, peer-but-different stage,
 * parked in `blocked/`, or in another backlog folder) or deferred to a later
 * release.  Returns `null` when every prereq is either satisfied (same stage
 * and folder, or strictly later),
 * tombstoned (completed, then pruned out of `complete/`), or absent entirely
 * (assumed already complete or a stale reference).
 *
 * Pass a prebuilt index to avoid re-scanning when checking many tickets;
 * omit it for one-shot checks at the moment of processing.
 */
export async function findUnsatisfiedPrereq(ticket, ticketsDir, index) {
	const idx = index ?? await indexAllTickets(ticketsDir);
	return firstUnsatisfied(resolvePrereqs(ticket, idx));
}

const SEQUENCE_PREFIX = /^(\d+(?:\.\d+)?)-(.+)\.md$/;

/** Parse sequence number from filename. Returns null when no numeric prefix is present. */
export function parseSequence(filename) {
	const match = basename(filename).match(SEQUENCE_PREFIX);
	return match ? parseFloat(match[1]) : null;
}

/** Extract the canonical slug (filename without any numeric prefix or .md extension). */
export function parseSlug(filename) {
	const base = basename(filename, '.md');
	const match = base.match(/^\d+(?:\.\d+)?-(.+)$/);
	return match ? match[1] : base;
}

/**
 * Read a single-line header field's raw value, or null when the field is
 * absent.  `pattern` is a field name, or an alternation of names
 * (`prereq|dependencies`); the header is `headerRegion`'s, so `content` may
 * be a whole ticket or `ticket.header`.
 *
 * The horizontal-whitespace class matters: a plain `\s*` after the colon also
 * matches the newline, so an empty field (`prereq:` with nothing after it)
 * would swallow the *next* header line as its value — which is exactly how
 * `prereq:` followed by `files: …` came to yield a file path as a prereq slug.
 * An empty field yields `''`, which every caller treats as absent.
 */
export function headerField(content, pattern) {
	return headerFieldLines(content, pattern)[0]?.value ?? null;
}

/**
 * Every header line of a single-line field, in file order, as `{ line, value }`:
 * `line` is 1-based in `content`, so a caller can remove exactly that line
 * (lib/ship.mjs does), and `value` is trimmed.  `pattern` is as for
 * `headerField`.  Only lines inside `headerBounds`' span count; a body line
 * below the header fence never does.
 */
export function headerFieldLines(content, pattern) {
	// `[ \t]` — a literal space and a literal tab — deliberately, not `[^\S\r\n]`.
	// This pattern is assembled in a template literal, where a regex class escape
	// silently degrades: `\S` becomes a bare `S`, so `[^\S\r\n]` compiles as
	// "any char except S/CR/LF" and, under the `i` flag, greedily eats the value's
	// leading characters up to its first `s` (`difficulty: easy` → `sy`). A tab
	// written as `\t` survives, because a literal tab in a character class means
	// the same thing. Keep regex-class escapes out of this string.
	const field = new RegExp(`^(?:${pattern}):[ \t]*(.*)$`, 'mi');
	const { lines, start, end } = headerBounds(content);
	const found = [];
	for (let i = start; i < end; i++) {
		const match = lines[i].match(field);
		if (match) found.push({ line: i + 1, value: match[1].trim() });
	}
	return found;
}

/** A line consisting only of three-or-more dashes: `---`, `----`, and longer. */
const FENCE_RE = /^-{3,}[^\S\r\n]*$/;

/**
 * Isolate a ticket's header block — the fields above the prose body.
 *
 * The fence is *optional and of two widths* in practice.  A census of this
 * repo's 643 tickets found 433 opening with `---` (YAML-style), 56 with the
 * `----` the template shows, and 154 with no fence at all, so anything that
 * assumes one shape is wrong for most of the corpus.  We therefore treat the
 * header as an optionally-fenced block:
 *
 *   - if line 0 is a fence, the header starts on the line after it;
 *     otherwise it starts at line 0;
 *   - the header ends at the next fence at or after that start, or at
 *     end-of-document when there is none.
 *
 * The "at or after that start" is the load-bearing part.  Searching for a
 * fence from index 0 would match the *opening* one, collapsing the header to
 * nothing and silently dropping every `prereq:` in the 433 three-dash tickets
 * — a far worse failure than the unbounded region it replaces.  (The previous
 * `indexOf('\n----')` avoided that trap only by accident: requiring a leading
 * newline skipped a fence at index 0, and the three-dash majority fell through
 * to "no divider found → whole document".)
 *
 * For an unfenced ticket the result is strictly tighter than treating the
 * whole document as header: a `---` rule in the prose now ends the region, so
 * a body line beginning `prereq:` or `difficulty:` can no longer be read as a
 * field.
 */
function headerRegion(content) {
	const { lines, start, end } = headerBounds(content);
	return lines.slice(start, end).join('\n');
}

/**
 * The line span `headerRegion` cuts out, as `{ lines, opened, start, end,
 * closed }`: `opened` when line 0 is a fence, header lines `[start, end)`, and
 * `closed` when a fence ends the header rather than end-of-document.  Exported
 * so a file with the same header shape (lib/project-rules.mjs) uses the same
 * fence rules instead of a second parser.
 */
export function headerBounds(content) {
	const lines = content.split(/\r?\n/);
	const opened = FENCE_RE.test(lines[0]);
	const start = opened ? 1 : 0;
	let end = start;
	while (end < lines.length && !FENCE_RE.test(lines[end])) end++;
	return { lines, opened, start, end, closed: end < lines.length };
}

/** An indented `- item` line of a list-valued header field; group 1 is the item, when there is one. */
const LIST_ITEM_RE = /^[ \t]+-(?:[ \t]+(.*))?$/;

/** A list item without its surrounding whitespace and quotes. */
const unquote = item => item.trim().replace(/^(["'])(.*)\1$/, '$2').trim();

/**
 * Parse a list-valued header field into its items — `[]` when the field is
 * absent or holds nothing.  `name` is a plain field name (letters, digits,
 * hyphens) and matches case-insensitively, like every header field.  Three
 * spellings:
 *
 *   features: SIT-BRA, SIT-CRT
 *   features: [SIT-BRA, SIT-CRT]
 *   features:
 *     - SIT-BRA
 *     - SIT-CRT
 *
 * The list form runs until the first line that is not an indented `- item`.
 * Items are trimmed, and surrounding quotes and empty items are dropped, so
 * `features: []` is as absent as no field at all.  `content` may be a whole
 * ticket or a header region already cut out of one (`ticket.header`): a
 * region holds no fence, so its region is itself.
 */
export function parseListField(content, name) {
	const lines = headerRegion(content).split('\n');
	// `[ \t]` written literally, for the reason given in `headerFieldLines`.
	const field = new RegExp(`^${name}:[ \t]*(.*)$`, 'i');
	const at = lines.findIndex(line => field.test(line));
	if (at === -1) return [];

	const value = lines[at].match(field)[1].trim();
	const items = [];
	if (value !== '') {
		items.push(...value.replace(/^\[(.*)\]$/, '$1').split(','));
	} else {
		for (const line of lines.slice(at + 1)) {
			const item = line.match(LIST_ITEM_RE);
			if (!item) break;
			items.push(item[1] ?? '');
		}
	}
	return items.map(unquote).filter(Boolean);
}

/** Parse the `prereq:` header field into an array of slug strings.  Tolerates legacy `dependencies:`. */
export function parsePrereqs(content) {
	const value = headerField(content, 'prereq|dependencies');
	if (value == null) return [];
	return value
		.split(',')
		.map(s => s.trim())
		.filter(Boolean)
		// Defensive: strip any lingering `N-` or `N.N-` prefix and `.md` suffix.
		.map(ref => ref.replace(/^\d+(?:\.\d+)?-/, '').replace(/\.md$/, ''));
}

/**
 * Parse the optional `difficulty:` header field.  This is the portable,
 * agent-agnostic knob (`easy` | `medium` | `hard`); the runner maps it — in
 * combination with the pipeline stage and per-agent config — to a concrete
 * model and reasoning-effort (see lib/model-selection.mjs).  Returns the
 * trimmed lowercase value or `null` when absent; normalization to a known
 * token (and the `medium` default) happens at resolution time.
 */
export function parseDifficulty(content) {
	const value = headerField(content, 'difficulty');
	return value ? value.toLowerCase() : null;
}

/**
 * Parse the optional `target:` header field — the release code a ticket
 * claims to be due in — or null when absent or empty.  Kept verbatim (codes
 * are case-sensitive); whether it agrees with the ticket's location is the
 * board check's call (lib/board-check.mjs).
 */
export function parseTarget(content) {
	return headerField(content, 'target') || null;
}

/** The ticket object discovery hands to strategies, validators and the agent prompt. */
function buildTicket({ entry, folder, path }, stage, content, releases) {
	return {
		file: entry,
		path,
		stage,
		folder,                                   // backlog sub-folder name, or null
		...releasePlacement(releases, folder),    // releaseRank, release
		sequence: parseSequence(entry),           // raw: number or null
		slug: parseSlug(entry),
		prereqs: parsePrereqs(content),
		difficulty: parseDifficulty(content),
		target: parseTarget(content),
		header: headerRegion(content),
	};
}

/**
 * Look for a ticket with the given slug across the named stage folders
 * (backlog sub-folders included when `backlog` is named).  Returns the first
 * match (in the order `stages` was passed) as a fully-populated ticket
 * object, or null if no match exists.
 *
 * Used by the chase strategy after each stage transition to locate the
 * agent's same-slug successor — by name rather than by filesystem diff,
 * since other agents may be modifying tickets/ in parallel.
 */
export async function findTicketBySlug(ticketsDir, slug, stages) {
	for (const stage of stages) {
		for (const file of await stageFiles(ticketsDir, stage, true)) {
			if (parseSlug(file.entry) !== slug) continue;
			const content = await readTicketFile(file.path);
			if (content == null) continue;
			return buildTicket(file, stage, content, await readReleases(ticketsDir));
		}
	}
	return null;
}

/**
 * Discover all .md ticket files in a stage folder, filtered by max sequence.
 *
 * `includeFolders` adds the tickets in each immediate sub-folder of `backlog/`
 * (never deeper, dot-folders skipped).  The runner leaves it off: a deferred
 * ticket must never be promoted by `--stages backlog:N`.
 */
export async function discoverTickets(ticketsDir, stage, maxSequence, { includeFolders = false } = {}) {
	const releases = await readReleases(ticketsDir);
	const tickets = [];

	for (const file of await stageFiles(ticketsDir, stage, includeFolders)) {
		// Unnumbered tickets are treated as sequence = +Infinity ("follows numbered").
		if ((parseSequence(file.entry) ?? Infinity) > maxSequence) continue;
		const content = await readTicketFile(file.path);
		if (content == null) continue;  // raced with a remove/move during snapshotting
		tickets.push(buildTicket(file, stage, content, releases));
	}

	// Within a stage: ascending sequence (low first); unnumbered (null) sorts last.
	tickets.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
	return tickets;
}

export function formatSeq(seq) {
	return seq == null ? '--' : String(seq);
}
