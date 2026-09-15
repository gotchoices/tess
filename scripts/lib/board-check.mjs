/**
 * Board-level consistency checks, and the per-ticket problems that make one
 * ticket not runnable.
 *
 * Two enforcement sites, kept apart on purpose:
 *   - `checkBoard` runs once, at runner startup, over the whole board.  Its
 *     errors describe a board that contradicts its own release list or carries
 *     a malformed project rules addendum, which is not safe to rank, so the
 *     runner exits before any agent runs; its warnings are printed and the run
 *     goes on.
 *   - `ticketProblems` runs in `runOneStage` for the one ticket about to be
 *     worked.  Any problem makes that ticket `invalid`: no agent, no commit.
 *
 * `readBoardContext` gathers what both read, so a later rule extends the
 * context rather than each caller re-reading files.
 */

import { anchorFieldsOf, anchorsRequiredBy, readProjectRules } from './project-rules.mjs';
import { RELEASES_FILE, currentRelease, rankOf, readReleases } from './releases.mjs';
import { boardLocation, deferralReason, parseListField, parseSlug, readBacklogLayout, resolvePrereqs } from './tickets.mjs';

const RELEASES_PATH = `tickets/${RELEASES_FILE}`;

/**
 * Everything the board rules read: `{ releases, rules, anchorFields,
 * anchorsRequired }`.  `rules` is `readProjectRules`' `{ rules, errors }`;
 * `anchorFields` is every header field that counts as an anchor;
 * `anchorsRequired` says whether a worked ticket must name one (see
 * lib/project-rules.mjs `anchorsRequiredBy`).
 */
export async function readBoardContext(ticketsDir) {
	const [releases, rules] = await Promise.all([readReleases(ticketsDir), readProjectRules(ticketsDir)]);
	return { releases, rules, anchorFields: anchorFieldsOf(rules.rules), anchorsRequired: anchorsRequiredBy(rules.rules) };
}

const ticketCount = n => `${n} ticket${n === 1 ? '' : 's'}`;

/**
 * Check the whole board.  `indexWithPrereqs` is `indexAllTickets(ticketsDir,
 * { withPrereqs: true })`: the sequencing warnings walk its prereq edges.
 * Returns `{ errors, warnings }`.
 */
export async function checkBoard(ticketsDir, context, indexWithPrereqs) {
	const { releases, rules } = context;
	const layout = await readBacklogLayout(ticketsDir);
	const errors = [...releases.errors, ...rules.errors];
	const warnings = [];

	if (releases.present) {
		const current = currentRelease(releases);
		for (const { name, files, nested } of layout.folders) {
			const folder = `backlog/${name}/ (${ticketCount(files.length)})`;
			if (name === current) {
				errors.push(`${folder} is named after the current release ${current} — current tickets live directly in backlog/`);
			} else if (rankOf(releases, name) === -1) {
				errors.push(`${folder} is not a release code in ${RELEASES_PATH} — rename it to a listed code or move its tickets to backlog/`);
			} else {
				for (const dir of nested) {
					warnings.push(`backlog/${name}/${dir}/ is ignored — tess reads only the tickets directly inside a release folder`);
				}
			}
		}
	}

	errors.push(...duplicateSlugErrors(layout));

	if (releases.present) warnings.push(...releaseOrderWarnings(indexWithPrereqs));

	return { errors, warnings };
}

/**
 * A slug filed in more than one place across `backlog/` and its sub-folders.
 * The index keeps the first copy, so which one a prereq resolved to would be
 * an accident of folder names.  Two copies side by side in one place
 * (`3-x.md` beside `x.md`) are not this check's business.
 */
function duplicateSlugErrors({ top, folders }) {
	const bySlug = new Map();  // slug → [{ place, path }]
	const add = (place, path) => {
		const slug = parseSlug(path);
		if (!bySlug.has(slug)) bySlug.set(slug, []);
		bySlug.get(slug).push({ place, path });
	};
	for (const entry of top) add(null, `backlog/${entry}`);
	for (const { name, files } of folders) {
		for (const entry of files) add(name, `backlog/${name}/${entry}`);
	}

	const errors = [];
	for (const [slug, copies] of bySlug) {
		if (new Set(copies.map(c => c.place)).size < 2) continue;
		errors.push(`slug "${slug}" is filed at ${copies.map(c => c.path).join(' and ')} — keep one copy`);
	}
	return errors;
}

/**
 * Every ticket whose prereq is deferred to a later release than the ticket
 * itself.  The runner reports this for a ticket it is about to work; this
 * covers the rest of the board — notably a folder ticket depending on a later
 * folder, which the runner never works and so would never mention.  Tickets
 * in `complete/` are skipped: an archived ticket's prereqs order nothing.
 */
function releaseOrderWarnings(index) {
	const warnings = [];
	for (const [slug, record] of index) {
		if (record.pruned || record.stage === 'complete' || !record.prereqs) continue;
		for (const r of resolvePrereqs({ ...record, slug }, index)) {
			if (r.status !== 'release-order') continue;
			warnings.push(`${boardLocation(record.stage, record.folder)}${record.file}: ${deferralReason(r)}`);
		}
	}
	return warnings;
}

/**
 * Why one discovered ticket is not runnable, as a list of problems — empty
 * when it is runnable.
 */
export function ticketProblems(ticket, context) {
	return [...targetProblems(ticket, context.releases), ...anchorProblems(ticket, context)];
}

/**
 * A `target:` header must agree with where the ticket sits.  The location is
 * what says a ticket's release, so a target can at most restate it; one that
 * says something else is a contradiction the runner will not guess its way
 * past.
 */
function targetProblems({ target, folder, stage }, releases) {
	if (!target) return [];
	if (!releases.present) return [`has target: ${target} but ${RELEASES_PATH} does not exist`];
	if (rankOf(releases, target) === -1) return [`target: ${target} is not a code in ${RELEASES_PATH}`];
	if (folder) {
		return target === folder ? [] : [`target: ${target} disagrees with its folder backlog/${folder}/`];
	}
	if (target === currentRelease(releases)) return [];
	return [`target: ${target} is a later release, but ${stage}/ holds current work — move it to backlog/${target}/ or drop the field`];
}

/** True when a ticket header gives any of `anchorFields` a non-empty value. */
export function hasAnchor(header, anchorFields) {
	return anchorFields.some(field => parseListField(header, field).length > 0);
}

/**
 * On a board that requires anchors, a ticket names at least one: a non-empty
 * `architecture:` or a field a project addendum declares.  Presence only —
 * whether an `architecture:` path or its `#section` exists is left to the
 * project's link checking, since resolving section slugs would mean
 * re-implementing heading-slug rules.  A board with no addendum declaring
 * anchor fields never has this problem.
 *
 * A malformed addendum can be why a field the ticket uses does not count.  The
 * startup board check stops the run on such errors, but an addendum broken
 * mid-run is seen only here, so its errors are listed with the problem.
 */
function anchorProblems({ header }, { anchorFields, anchorsRequired, rules }) {
	if (!anchorsRequired || hasAnchor(header, anchorFields)) return [];
	const named = anchorFields.map(field => `${field}:`);
	return [
		`no anchor — add ${named.length === 1 ? named[0] : `one of ${named.join(', ')}`} to the header`,
		...rules.errors.map(error => `project rules error, which may be why a field does not count: ${error}`),
	];
}
