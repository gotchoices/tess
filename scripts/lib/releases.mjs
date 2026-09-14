/**
 * The release list: `tickets/releases.md`.
 *
 * An optional, ordered list of release codes.  The first entry is the
 * *current* release; a later entry is a release that work is deferred to by
 * filing it in `backlog/<CODE>/`.  An absent file turns the release model off;
 * a present file turns it on, even with no entries — an empty list means
 * everything is current.
 *
 * The format is a line grammar, deliberately not a markdown parse:
 *
 *   - a line starting `## ` outside a fenced code block starts an entry, and
 *     its trimmed heading text is the code;
 *   - a line starting with three backticks toggles the fence;
 *   - the first non-blank line after a heading may be `due: YYYY-MM-DD` (field
 *     name in any case);
 *   - every other line is preamble (before the first entry) or exit-criteria
 *     text belonging to the entry above it.
 *
 * Each entry keeps its exact source slice, line endings included, so a caller
 * can drop an entry and write the file back without re-rendering the rest:
 * `serializeReleases(parseReleases(text))` is byte-identical to `text`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Release list filename, relative to the tickets directory. */
export const RELEASES_FILE = 'releases.md';

/** How errors name the file — the runner always works on `<repo>/tickets`. */
const DISPLAY_PATH = `tickets/${RELEASES_FILE}`;

/** An uppercase letter, then 1–7 uppercase letters or digits: the shape of a top-level feature code. */
const CODE_RE = /^[A-Z][A-Z0-9]{1,7}$/;
/** Case-insensitive like a ticket header field, so `Due:` is a due date, not silently exit-criteria text. */
const DUE_RE = /^due:[ \t]*(.*)$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BOM = '﻿';

/** True when `YYYY-MM-DD` names a day that exists (rejects `2026-02-30`). */
function isCalendarDate(year, month, day) {
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Parse release-list text.  Returns `{ preamble, entries, errors }`; entries
 * with errors are still listed, so serialization stays byte-identical and the
 * caller decides what an error means.
 */
export function parseReleases(text) {
	// A byte-order mark belongs to the file, not to whichever line happens to be first.
	const bom = text.startsWith(BOM) ? BOM : '';
	const lines = text.slice(bom.length).match(/[^\n]*\n|[^\n]+$/g) ?? [];

	let preamble = bom;
	const entries = [];
	const errors = [];
	const firstListed = new Map();  // code → line number of its first entry
	let entry = null;
	let inFence = false;
	let awaitingDue = false;

	lines.forEach((raw, i) => {
		const lineNo = i + 1;
		const line = raw.replace(/\r?\n$/, '');

		if (!inFence && line.startsWith('## ')) {
			entry = { code: line.slice(3).trim(), due: null, line: lineNo, raw };
			entries.push(entry);
			awaitingDue = true;
			if (!CODE_RE.test(entry.code)) {
				errors.push(`${DISPLAY_PATH}:${lineNo}: "${entry.code}" is not a release code — use an uppercase letter followed by 1–7 uppercase letters or digits`);
			} else if (firstListed.has(entry.code)) {
				errors.push(`${DISPLAY_PATH}:${lineNo}: release code ${entry.code} is listed twice (first on line ${firstListed.get(entry.code)})`);
			} else {
				firstListed.set(entry.code, lineNo);
			}
			return;
		}
		if (line.startsWith('```')) inFence = !inFence;

		if (!entry) {
			preamble += raw;
			return;
		}
		entry.raw += raw;

		if (!awaitingDue || line.trim() === '') return;
		awaitingDue = false;
		const due = line.match(DUE_RE);
		if (!due) return;
		const value = due[1].trim();
		const date = value.match(DATE_RE);
		if (!date) {
			errors.push(`${DISPLAY_PATH}:${lineNo}: due: "${value}" is not a date — write due: YYYY-MM-DD`);
		} else if (!isCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]))) {
			errors.push(`${DISPLAY_PATH}:${lineNo}: due: ${value} is not a real calendar date`);
		} else {
			entry.due = value;
		}
	});

	return { preamble, entries, errors };
}

/**
 * Read `tickets/releases.md`.  `present: false` (with nothing else) when the
 * file does not exist; any other read failure throws, because an unreadable
 * list leaves the release model in an unknowable state.
 */
export async function readReleases(ticketsDir) {
	let text;
	try {
		text = await readFile(join(ticketsDir, RELEASES_FILE), 'utf-8');
	} catch (err) {
		if (err.code === 'ENOENT') return { present: false, preamble: '', entries: [], errors: [] };
		throw err;
	}
	return { present: true, ...parseReleases(text) };
}

/** The file text for a (possibly edited) release list: preamble, then each entry's source slice. */
export function serializeReleases(releases) {
	return releases.preamble + releases.entries.map(e => e.raw).join('');
}

/** The current release's code, or null when the model is off or the list is empty. */
export function currentRelease(releases) {
	return releases.entries[0]?.code ?? null;
}

/** A code's position in the list (0 = current), or -1 when it is not listed. */
export function rankOf(releases, code) {
	return releases.entries.findIndex(e => e.code === code);
}

/**
 * Where a ticket's location puts it in the release order, as
 * `{ releaseRank, release }`.  `folder` is its backlog sub-folder, or null.
 *
 * Only a folder named after a listed code other than the current one is
 * deferred: it ranks by its position and is due in that release.  Everything
 * else — top level, other stages, model off, a folder that is not a listed
 * code (a board error in its own right) — is current work: rank 0, due in the
 * current release (null when there is none).
 */
export function releasePlacement(releases, folder) {
	const rank = folder == null ? -1 : rankOf(releases, folder);
	return rank > 0
		? { releaseRank: rank, release: folder }
		: { releaseRank: 0, release: currentRelease(releases) };
}
