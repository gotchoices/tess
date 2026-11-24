/**
 * The dashboard's distill job: one run of scripts/distill.mjs, started from the
 * Decisions page, with its progress read off the script's own output.
 *
 * The script is the pass — which tickets are due, one agent per ticket, one
 * commit per ticket (scripts/distill.mjs).  This module only starts it, follows
 * it, and remembers the last run so the page can show how it ended.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DistillJob, DistillStart } from '../lib/types.js';

// Found from this file, not from the project: the project served need not carry tess at `./tess`.
const DISTILL_SCRIPT = fileURLToPath(new URL('../../../scripts/distill.mjs', import.meta.url));

const LOG_TAIL_LINES = 200;
// An agent's output is teed through the script, and one line of it can be a whole file.
const LOG_LINE_CHARS = 400;

interface TrackedJob extends DistillJob {
	child: ChildProcess | null;
}

// One slot per project, held on `globalThis`: when a config file changes (this one included),
// vite restarts the server inside this same process and evaluates this module again, while a
// pass started before the restart is still running and still writing to the job its listeners
// closed over.
const SLOTS_KEY = Symbol.for('tess.ui.distill-jobs');
const slots: Map<string, TrackedJob> = ((globalThis as Record<symbol, unknown>)[SLOTS_KEY] ??= new Map()) as Map<string, TrackedJob>;

/** `  [distill 2/5] some-ticket.md` and the script's other per-ticket lines; group 3 is what follows the label. */
const TICKET_LINE_RE = /\[distill (\d+)\/(\d+)\] (.*)$/;
/** stderr: `[distill 2/5] Agent exited with code 1 on some-ticket.md. Log: …`. */
const FAILED_RE = /^Agent .* on (\S+\.md)\./;
const TICKET_FILE_RE = /^\S+\.md$/;
/** The script's last line, with the number of tickets whose agent finished. */
const FINISHED_RE = /^Distilled (\d+) ticket\(s\)\./;
const DRY_RUN_RE = /^(\d+) ticket\(s\) would be distilled/;
/** Terminal colour and cursor codes. */
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Read one line of the script's output into the job's progress. */
function follow(job: TrackedJob, line: string, slugOf: (file: string) => string) {
	const ticket = line.match(TICKET_LINE_RE);
	if (ticket) {
		const [, index, total, rest] = ticket;
		job.total = Number(total);
		const failed = rest.match(FAILED_RE);
		if (failed) {
			job.failed.push(slugOf(failed[1]));
			return;
		}
		// Ticket i has started (or was skipped), so i-1 are behind it.
		job.done = Math.max(job.done, Number(index) - 1);
		job.current = TICKET_FILE_RE.test(rest) ? slugOf(rest) : null;
		return;
	}
	const finished = line.match(FINISHED_RE);
	if (finished) {
		job.done = Number(finished[1]);
		job.current = null;
		return;
	}
	const dryRun = line.match(DRY_RUN_RE);
	if (dryRun) job.total = Number(dryRun[1]);
}

/** A stream's chunks as whole lines: a banner split across two chunks must still be read as one. */
function lineReader(onLine: (line: string) => void) {
	let pending = '';
	return {
		push(chunk: Buffer | string) {
			pending += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? '';
			for (const line of lines) onLine(line);
		},
		flush() {
			if (pending) onLine(pending);
			pending = '';
		},
	};
}

function publicJob(job: TrackedJob | undefined): DistillJob | null {
	if (!job) return null;
	const { child: _child, ...shown } = job;
	return shown;
}

/** The project's distill job — running, or the last one that ran — or null. */
export function distillJob(projectRoot: string): DistillJob | null {
	return publicJob(slots.get(projectRoot));
}

export function isDistillRunning(projectRoot: string): boolean {
	return slots.get(projectRoot)?.status === 'running';
}

/** Note on the running job that a stop was asked for; the script reads the request itself, between tickets. */
export function markDistillStopRequested(projectRoot: string): DistillJob | null {
	const job = slots.get(projectRoot);
	if (job?.status === 'running') job.stopRequested = true;
	return publicJob(job);
}

/**
 * Start the pass in `projectRoot` and return its job.  The caller has checked
 * that none is running.  `slugOf` turns a ticket file name into its slug.
 *
 * NOTE: the child is tied to this server process by its output pipes.  It
 * outlives a vite restart, which happens inside the process; it does not
 * outlive the process itself.  For that the script's output would have to go to
 * a file the next server process tails, with the job found again from a marker.
 */
export function startDistillJob(projectRoot: string, start: DistillStart, slugOf: (file: string) => string): DistillJob {
	const args = [
		DISTILL_SCRIPT,
		...(start.only ? ['--only', start.only.join(',')] : []),
		...(start.all ? ['--all'] : []),
		...(start.max ? ['--max', String(start.max)] : []),
		...(start.dryRun ? ['--dry-run'] : []),
	];
	const job: TrackedJob = {
		id: `distill-${Date.now()}`,
		status: 'running',
		startedAt: Date.now(),
		dryRun: start.dryRun === true,
		total: null,
		done: 0,
		current: null,
		failed: [],
		stopRequested: false,
		logTail: [],
		child: null,
	};
	slots.set(projectRoot, job);

	const log = (line: string) => {
		if (!line.trim()) return;
		job.logTail.push(line.length > LOG_LINE_CHARS ? `${line.slice(0, LOG_LINE_CHARS)}…` : line);
		if (job.logTail.length > LOG_TAIL_LINES) job.logTail.shift();
	};
	const end = (exitCode: number) => {
		if (job.status !== 'running') return;  // `error` and `close` can both fire
		job.exitCode = exitCode;
		job.status = exitCode === 0 ? 'success' : 'error';
		job.endedAt = Date.now();
		job.current = null;
		job.child = null;
	};
	const onLine = (raw: string) => {
		// The agent's output comes through coloured; an escape code in front of a line would hide it from `follow`.
		const line = raw.replace(ANSI_RE, '');
		log(line);
		follow(job, line, slugOf);
	};
	const stdout = lineReader(onLine);
	const stderr = lineReader(onLine);

	const child = spawn(process.execPath, args, {
		cwd: projectRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: process.env,
		windowsHide: true,
	});
	job.child = child;
	child.stdout?.on('data', chunk => stdout.push(chunk));
	child.stderr?.on('data', chunk => stderr.push(chunk));
	child.on('error', err => {
		log(`[spawn-error] ${err.message}`);
		end(-1);
	});
	child.on('close', code => {
		stdout.flush();
		stderr.flush();
		end(code ?? -1);
	});

	return publicJob(job)!;
}
