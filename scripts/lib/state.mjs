/**
 * Run-level filesystem state: stop file, in-progress marker, resume notes.
 *
 * The runner uses two sidecar files in tickets/:
 *   - `.stop`        — create to gracefully halt the runner between tickets
 *   - `.in-progress` — written before each ticket, removed on success; lets the
 *                      next run detect an interrupted attempt and prepend a
 *                      resume note to the ticket so the agent picks up where
 *                      it left off.
 */

import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { headerBounds } from './tickets.mjs';

const STOP_FILE = '.stop';
const IN_PROGRESS_FILE = '.in-progress';

const RESUME_MARKER_START = '<!-- resume-note -->';
const RESUME_MARKER_END = '<!-- /resume-note -->';

export async function pathExists(p) {
	try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/** Returns true (and removes the stop file) if the user has asked the runner to halt. */
export async function checkStop(ticketsDir) {
	const stopFile = join(ticketsDir, STOP_FILE);
	if (await pathExists(stopFile)) {
		await unlink(stopFile).catch(() => {});
		return true;
	}
	return false;
}

function inProgressPath(ticketsDir) {
	return join(ticketsDir, IN_PROGRESS_FILE);
}

async function readInProgressRaw(ticketsDir) {
	try {
		return await readFile(inProgressPath(ticketsDir), 'utf-8');
	} catch {
		return null;
	}
}

/** Peek at any prior in-progress state WITHOUT clearing it. Returns parsed object or null.
 *  Used by the startup working-tree reconcile to attribute leftover edits to the ticket that
 *  was interrupted; the marker must survive that read so the resume-note path (and `--dry-run`)
 *  still sees it. */
export async function readInProgress(ticketsDir) {
	const raw = await readInProgressRaw(ticketsDir);
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Read and clear any prior in-progress state. Returns parsed object or null.  A marker that
 *  fails to parse is still removed, so a corrupt file cannot wedge every future run. */
export async function readAndClearInProgress(ticketsDir) {
	const raw = await readInProgressRaw(ticketsDir);
	if (raw === null) return null;
	await unlink(inProgressPath(ticketsDir)).catch(() => {});
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Write in-progress state before starting a ticket. */
export async function writeInProgress(ticketsDir, ticket, logFile, agent) {
	const state = {
		file: ticket.file,
		stage: ticket.stage,
		sequence: ticket.sequence,
		slug: ticket.slug,
		path: ticket.path,
		logFile,
		agent,
		startedAt: new Date().toISOString(),
	};
	await writeFile(inProgressPath(ticketsDir), JSON.stringify(state, null, '\t'), 'utf-8');
}

/** Clear in-progress state after successful completion. */
export async function clearInProgress(ticketsDir) {
	await unlink(inProgressPath(ticketsDir)).catch(() => {});
}

/** The resume note as an array of lines (no trailing blank line — see `addResumeNote`). */
function buildResumeNoteLines(priorRun) {
	return [
		RESUME_MARKER_START,
		'RESUME: A prior agent run on this ticket did not complete.',
		`  Prior run: ${priorRun.startedAt} (agent: ${priorRun.agent})`,
		`  Log file: ${priorRun.logFile}`,
		'Read the log to see what was done. Resume where it left off.',
		'If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.',
		RESUME_MARKER_END,
	];
}

/**
 * Insert a resume note into a ticket file, just after its header. Idempotent —
 * the plain-text search below finds an existing note wherever it sits
 * (including above the header, from before this fix) and removes it first.
 *
 * Reuses `headerBounds` rather than re-deriving the fence rules: a note
 * prepended above the header reads as part of the header to
 * `board-check.mjs`'s anchor check and `tickets.mjs`'s `prereq:`/`difficulty:`
 * parsing, hiding the real fields. Insertion point is `closed ? end + 1 :
 * end` — right after the closing fence when the header has one, or at the
 * very end of the document when it doesn't (an unfenced header has no fence
 * to end it, so `headerBounds` reads the whole document as header and `end`
 * is already the line count).
 */
export async function addResumeNote(ticketPath, priorRun) {
	let content = await readFile(ticketPath, 'utf-8');
	const startIdx = content.indexOf(RESUME_MARKER_START);
	const endIdx = content.indexOf(RESUME_MARKER_END);
	if (startIdx !== -1 && endIdx !== -1) {
		content = content.slice(0, startIdx) + content.slice(endIdx + RESUME_MARKER_END.length).replace(/^\n/, '');
	}
	const { lines, end, closed } = headerBounds(content);
	const at = closed ? end + 1 : end;
	const updated = [...lines.slice(0, at), ...buildResumeNoteLines(priorRun), ...lines.slice(at)].join('\n');
	await writeFile(ticketPath, updated, 'utf-8');
}
