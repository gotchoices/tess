/**
 * Ticket discovery and parsing.
 *
 * Encapsulates the on-disk shape of a ticket: stage folder, optional sequence
 * prefix, slug, and the `prereq:` header field.  All filesystem-touching reads
 * for the snapshot live here.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { constants } from 'node:fs';
import { readTombstones } from './tombstones.mjs';

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

/**
 * One-shot scan of every known stage folder, returning `slug → { stage, file }`.
 *
 * When the same slug appears in multiple stages (e.g. an agent split or a
 * stale duplicate), the most-advanced copy wins — iteration runs in reverse
 * pipeline order so a slug found in `complete/` masks one still sitting in
 * `plan/`.  Used to resolve cross-stage prereq edges that aren't in the
 * snapshot's own stage bucket.
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
	const index = new Map();
	for (const stage of STAGE_INDEX_ORDER) {
		const stageDir = join(ticketsDir, stage);
		let entries;
		try {
			entries = await readdir(stageDir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith('.md')) continue;
			const slug = parseSlug(entry);
			if (index.has(slug)) continue;
			const record = { stage, file: entry };
			if (withPrereqs) {
				try {
					const content = await readFile(join(stageDir, entry), 'utf-8');
					record.prereqs = parsePrereqs(content);
				} catch (err) {
					if (err.code === 'ENOENT') continue;  // raced with a remove/move
					throw err;
				}
			}
			index.set(slug, record);
		}
	}
	for (const [slug, tomb] of await readTombstones(ticketsDir)) {
		if (index.has(slug)) continue;
		index.set(slug, {
			stage: 'complete',
			file: null,
			pruned: true,
			completedAt: tomb.completedAt ?? null,
			commit: tomb.commit ?? null,
			...(withPrereqs ? { prereqs: [] } : {}),
		});
	}
	return index;
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
 *   - `satisfied` — on the board in a strictly later rank (or the same stage,
 *      where the topo sort orders it).
 *   - `behind`    — on the board but at a lower/peer rank, or in `blocked/`.
 *   - `pruned`    — not on the board but carrying a tombstone: it completed
 *      and was later swept out of `complete/`.  Satisfied, and carries
 *      `completedAt` / `commit` so the runner can say so out loud.
 *   - `unknown`   — matches neither the board nor a tombstone.  Treated as
 *      satisfied (the historical assumption: already complete, or a stale
 *      reference), but reported, since it is the one case nothing can vouch
 *      for.
 */
export function resolvePrereqs(ticket, index) {
	return ticket.prereqs.map(slug => {
		const found = index.get(slug);
		if (!found) return { slug, status: 'unknown' };
		if (found.pruned) {
			return { slug, status: 'pruned', stage: found.stage, completedAt: found.completedAt, commit: found.commit };
		}
		const status = isPrereqSatisfied(found.stage, ticket.stage) ? 'satisfied' : 'behind';
		return { slug, status, stage: found.stage };
	});
}

/**
 * One log line per prereq whose resolution is worth saying out loud — the
 * pruned ones (so a landed prereq never reads as missing work) and the unknown
 * ones (so a genuinely unresolvable slug stays visible instead of being
 * silently assumed complete).  Board-resolved prereqs produce nothing; their
 * state is already evident from the board.
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
		}
	}
	return notes;
}

/**
 * Resolve a ticket's prereqs against the cross-stage index and return the
 * first one that's *behind* (lower rank, peer-but-different stage, or
 * parked in `blocked/`).  Returns `null` when every prereq is either
 * satisfied (same stage or strictly later), tombstoned (completed, then
 * pruned out of `complete/`), or absent entirely (assumed already complete
 * or a stale reference).
 *
 * Pass a prebuilt index to avoid re-scanning when checking many tickets;
 * omit it for one-shot checks at the moment of processing.
 */
export async function findUnsatisfiedPrereq(ticket, ticketsDir, index) {
	const idx = index ?? await indexAllTickets(ticketsDir);
	return resolvePrereqs(ticket, idx).find(r => r.status === 'behind') ?? null;
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
 * absent.  The header is the region above the first `----` divider.
 *
 * The horizontal-whitespace class matters: a plain `\s*` after the colon also
 * matches the newline, so an empty field (`prereq:` with nothing after it)
 * would swallow the *next* header line as its value — which is exactly how
 * `prereq:` followed by `files: …` came to yield a file path as a prereq slug.
 * An empty field yields `''`, which every caller treats as absent.
 */
function headerField(content, pattern) {
	// `[ \t]` — a literal space and a literal tab — deliberately, not `[^\S\r\n]`.
	// This pattern is assembled in a template literal, where a regex class escape
	// silently degrades: `\S` becomes a bare `S`, so `[^\S\r\n]` compiles as
	// "any char except S/CR/LF" and, under the `i` flag, greedily eats the value's
	// leading characters up to its first `s` (`difficulty: easy` → `sy`). A tab
	// written as `\t` survives, because a literal tab in a character class means
	// the same thing. Keep regex-class escapes out of this string.
	const match = headerRegion(content).match(new RegExp(`^(?:${pattern}):[ \t]*(.*)$`, 'mi'));
	return match ? match[1].trim() : null;
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
	const lines = content.split(/\r?\n/);
	const start = lines.length > 0 && FENCE_RE.test(lines[0]) ? 1 : 0;
	let end = start;
	while (end < lines.length && !FENCE_RE.test(lines[end])) end++;
	return lines.slice(start, end).join('\n');
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
 * Look for a ticket with the given slug across the named stage folders.
 * Returns the first match (in the order `stages` was passed) as a fully-
 * populated ticket object, or null if no match exists.
 *
 * Used by the chase strategy after each stage transition to locate the
 * agent's same-slug successor — by name rather than by filesystem diff,
 * since other agents may be modifying tickets/ in parallel.
 */
export async function findTicketBySlug(ticketsDir, slug, stages) {
	for (const stage of stages) {
		const stageDir = join(ticketsDir, stage);
		let entries;
		try {
			entries = await readdir(stageDir);
		} catch {
			continue;  // stage dir doesn't exist
		}
		for (const entry of entries) {
			if (!entry.endsWith('.md')) continue;
			if (parseSlug(entry) !== slug) continue;
			const path = join(stageDir, entry);
			let content;
			try {
				content = await readFile(path, 'utf-8');
			} catch (err) {
				if (err.code === 'ENOENT') continue;  // raced with a remove/move
				throw err;
			}
			return {
				file: entry,
				path,
				stage,
				sequence: parseSequence(entry),
				slug,
				prereqs: parsePrereqs(content),
				difficulty: parseDifficulty(content),
			};
		}
	}
	return null;
}

/** Discover all .md ticket files in a stage folder, filtered by max sequence. */
export async function discoverTickets(ticketsDir, stage, maxSequence) {
	const stageDir = join(ticketsDir, stage);
	try {
		await access(stageDir, constants.R_OK);
	} catch {
		return [];
	}

	const entries = await readdir(stageDir);
	const tickets = [];

	for (const entry of entries) {
		if (!entry.endsWith('.md')) continue;

		const sequence = parseSequence(entry);
		// Unnumbered tickets are treated as sequence = +Infinity ("follows numbered").
		const effective = sequence ?? Infinity;
		if (effective > maxSequence) continue;

		const path = join(stageDir, entry);
		let content;
		try {
			content = await readFile(path, 'utf-8');
		} catch (err) {
			if (err.code === 'ENOENT') continue;  // raced with a remove/move during snapshotting
			throw err;
		}
		tickets.push({
			file: entry,
			path,
			stage,
			sequence,            // raw: number or null
			slug: parseSlug(entry),
			prereqs: parsePrereqs(content),
			difficulty: parseDifficulty(content),
		});
	}

	// Within a stage: ascending sequence (low first); unnumbered (null) sorts last.
	tickets.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
	return tickets;
}

export function formatSeq(seq) {
	return seq == null ? '--' : String(seq);
}
