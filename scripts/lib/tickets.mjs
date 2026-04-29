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

/** Default stages from which to pull tickets (backlog excluded — parked by design). */
export const PENDING_STAGES = ['fix', 'review', 'implement', 'plan'];

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

/** Parse the `prereq:` header field into an array of slug strings.  Tolerates legacy `dependencies:`. */
export function parsePrereqs(content) {
	// Header sits above the first `----` divider; parse only that region.
	const divIdx = content.indexOf('\n----');
	const header = divIdx === -1 ? content : content.slice(0, divIdx);
	const match = header.match(/^(?:prereq|dependencies):\s*(.*)$/mi);
	if (!match) return [];
	return match[1]
		.split(',')
		.map(s => s.trim())
		.filter(Boolean)
		// Defensive: strip any lingering `N-` or `N.N-` prefix and `.md` suffix.
		.map(ref => ref.replace(/^\d+(?:\.\d+)?-/, '').replace(/\.md$/, ''));
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
		const content = await readFile(path, 'utf-8');
		tickets.push({
			file: entry,
			path,
			stage,
			sequence,            // raw: number or null
			slug: parseSlug(entry),
			prereqs: parsePrereqs(content),
		});
	}

	// Within a stage: ascending sequence (low first); unnumbered (null) sorts last.
	tickets.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
	return tickets;
}

export function formatSeq(seq) {
	return seq == null ? '--' : String(seq);
}
