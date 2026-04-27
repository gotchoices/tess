#!/usr/bin/env node
/**
 * Ticket Runner — processes outstanding tickets through the pipeline stages
 * by invoking an agentic CLI tool for each one.
 *
 * Version: 2.0.0
 *
 * Key design choices:
 *   - The ticket list is snapshotted once at startup.  Tickets created by the agent
 *     during this run are NOT picked up, ensuring each ticket advances exactly one
 *     stage per invocation of the runner.
 *   - The agent owns the stage transition: it creates next-stage file(s) and
 *     deletes the source ticket file.  The runner commits after the agent completes.
 *     This keeps commits out of interactive agent sessions while ensuring clean
 *     commit-per-ticket history when running the pipeline.
 *   - Agent logs are captured in tickets/.logs/ (git-ignored), one per ticket per stage.
 *   - Numeric filename prefix encodes *sequence* (lower runs sooner); the prefix is
 *     optional — unnumbered tickets follow after all numbered ones in a stage.
 *   - Tickets may declare `prereq: <slug>, <slug>` in the header.  Prereqs must
 *     land (advance stage) before dependents; the runner topologically sorts the
 *     snapshot and errors on cycles or sequence-number violations.
 *   - If `tickets/.version` is missing or older than the current format, the runner
 *     auto-migrates legacy v1 tickets (priority → inverted sequence, dependencies →
 *     prereq, prefix stripped from references) and commits the migration.
 *
 * Usage:
 *   node tess/scripts/run.mjs [options]
 *
 * Options:
 *   --max-sequence <n>   Default max sequence for all stages   (default: unlimited)
 *                        Tickets with sequence > n (and unnumbered tickets when n
 *                        is finite) are skipped.
 *   --stages <list>      Comma-separated stages to process, optionally with per-stage
 *                        max sequence as  stage:n  (default: fix,plan,implement,review)
 *                        Examples:
 *                          --stages fix,implement
 *                          --stages review:5,implement:3
 *                          --stages fix:4,implement,review:5  (uses --max-sequence for bare names)
 *                          --stages backlog:2                 (backlog is not in the default set)
 *   --agent <name>       Agent adapter to use: claude | auggie | cursor | codex  (default: claude)
 *   --max <n>            Stop after processing at most n tickets  (default: unlimited)
 *   --no-commit          Skip automatic git commit after each ticket
 *   --dry-run            List tickets that would be processed, don't invoke agent
 *   --help               Show this help
 */

import { readdir, readFile, access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename, relative, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate, needsMigration, FORMAT_VERSION } from './migrate.mjs';

// ─── Path resolution ───────────────────────────────────────────────────────────
// The runner lives at tess/scripts/run.mjs.
// tess root = ../../ from this file.  tickets/ and repo root are resolved from cwd.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TESS_ROOT = join(__dirname, '..');

const STOP_FILE = '.stop';              // create tickets/.stop to halt the runner
const IN_PROGRESS_FILE = '.in-progress';  // tracks the currently-running ticket for resume

function getTessVersion() {
	try {
		const hash = execSync('git log -1 --format=%h', { cwd: TESS_ROOT, encoding: 'utf-8' }).trim();
		return hash;
	} catch {
		return 'unknown';
	}
}

// ─── Stream formatters ─────────────────────────────────────────────────────────

/**
 * Format Claude stream-json lines to readable text.
 * Returns { text, done? } — when done is true the agent has emitted its
 * final result and the runner should stop waiting for a clean exit.
 */
function formatClaudeJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'system' && obj.subtype === 'init') {
			return { text: `[session ${obj.session_id ?? '?'}]\n` };
		}
		if (obj.type === 'assistant') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					parts.push(`\n[ASSISTANT]\n${block.text}\n`);
				} else if (block.type === 'tool_use') {
					const inputStr = typeof block.input === 'object'
						? JSON.stringify(block.input).slice(0, 200)
						: String(block.input ?? '');
					parts.push(`\n[TOOL:${block.name}] ${inputStr}\n`);
				}
			}
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'user') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'tool_result') {
					const text = Array.isArray(block.content)
						? block.content.map(c => c.text ?? '').join('')
						: String(block.content ?? '');
					parts.push(`  ✓ ${text.slice(0, 200)}\n`);
				} else if (block.type === 'text' && block.text) {
					parts.push(`\n[USER]\n${block.text}\n`);
				}
			}
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'result') {
			const status = obj.is_error ? '✗ ERROR' : '✓ DONE';
			const cost = obj.total_cost_usd != null ? ` | cost $${obj.total_cost_usd.toFixed(4)}` : '';
			const dur = obj.duration_ms != null ? ` | ${(obj.duration_ms / 1000).toFixed(1)}s` : '';
			return {
				text: `\n[RESULT ${status}${dur}${cost}]\n${obj.result ?? ''}\n`,
				done: true,
				exitCode: obj.is_error ? 1 : 0,
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

function formatCursorJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'user') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[USER]\n${t}\n` };
		}
		if (obj.type === 'assistant') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[ASSISTANT]\n${t}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'started') {
			const tc = obj.tool_call ?? {};
			if (tc.shellToolCall) return { text: `\n[SHELL] ${tc.shellToolCall.args?.command ?? ''}\n` };
			if (tc.readToolCall) return { text: `\n[READ] ${tc.readToolCall.args?.path ?? ''}\n` };
			if (tc.editToolCall) return { text: `\n[EDIT] ${tc.editToolCall.args?.path ?? ''}\n` };
			if (tc.writeToolCall) return { text: `\n[WRITE] ${tc.writeToolCall.args?.path ?? ''}\n` };
			if (tc.grepToolCall) return { text: `\n[GREP] ${tc.grepToolCall.args?.pattern ?? ''} in ${tc.grepToolCall.args?.path ?? ''}\n` };
			if (tc.lsToolCall) return { text: `\n[LS] ${tc.lsToolCall.args?.path ?? ''}\n` };
			if (tc.deleteToolCall) return { text: `\n[DELETE] ${tc.deleteToolCall.args?.path ?? ''}\n` };
			return { text: `\n[TOOL] ${Object.keys(tc)[0] ?? '?'}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'completed') {
			const tc = obj.tool_call ?? {};
			const ok = (r) => r?.success != null;
			if (tc.shellToolCall) return { text: ok(tc.shellToolCall.result) ? `  ✓ exit ${tc.shellToolCall.result.success?.exitCode ?? 0}\n` : `  ✗ failed\n` };
			if (tc.readToolCall) return { text: ok(tc.readToolCall.result) ? `  ✓ read ${tc.readToolCall.result.success?.totalLines ?? 0} lines\n` : `  ✗ failed\n` };
			if (tc.editToolCall || tc.writeToolCall || tc.deleteToolCall) return { text: ok(Object.values(tc)[0]?.result) ? `  ✓ done\n` : `  ✗ failed\n` };
			return { text: `  ✓ done\n` };
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

function formatCodexJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'thread.started') {
			return { text: `[session ${obj.thread_id ?? '?'}]\n` };
		}
		if (obj.type === 'turn.started') {
			return { text: '\n[TURN STARTED]\n' };
		}
		if (obj.type === 'item.completed') {
			const item = obj.item ?? {};
			if (item.type === 'agent_message' && item.text) {
				return { text: `\n[ASSISTANT]\n${item.text}\n` };
			}
		}
		if (obj.type === 'turn.completed') {
			const usage = obj.usage ?? {};
			const input = usage.input_tokens != null ? ` in ${usage.input_tokens}` : '';
			const output = usage.output_tokens != null ? ` out ${usage.output_tokens}` : '';
			return {
				text: `\n[RESULT ✓ DONE${input || output ? ` | tokens${input}${output}` : ''}]\n`,
				done: true,
				exitCode: 0,
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

// ─── Agent adapters ────────────────────────────────────────────────────────────
// Each adapter returns { cmd, args } or { shellCmd } for spawning the agent process.
// `instructionFile` is the path to a temp file containing the full prompt.
// When shellCmd is set, it is passed as a single string to avoid DEP0190 (Windows + shell:true).

const agents = {
	claude: (instructionFile, _prompt, { stage }) => {
		const effort = 'xhigh';
		const args = [
			'-p',
			'--dangerously-skip-permissions',
			'--verbose',
			'--no-session-persistence',
			'--output-format', 'stream-json',
			'--effort', effort,
			'--append-system-prompt-file', instructionFile,
			'Work the ticket as described in the appended system prompt.',
		];
		// On Windows, spawn() with shell:false cannot resolve .cmd/.ps1 shims
		// installed by npm. Use shellCmd so spawn() runs with shell:true instead.
		if (process.platform === 'win32') {
			const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
			return { shellCmd: `claude ${escaped}`, formatStream: formatClaudeJsonLine };
		}
		return { cmd: 'claude', args, formatStream: formatClaudeJsonLine };
	},

	auggie: (instructionFile, _prompt) => ({
		shellCmd: `auggie --print --instruction "${instructionFile}"`,
	}),

	codex: (instructionFile, _prompt, { cwd }) => {
		const relPath = relative(cwd, instructionFile).replace(/\\/g, '/');
		const prompt = `Read and follow all instructions in the file: ${relPath}`;
		return {
			cmd: 'codex',
			args: [
				'exec',
				'--json',
				'--color', 'never',
				'--full-auto',
				'--ephemeral',
				'-C', cwd,
				prompt,
			],
			formatStream: formatCodexJsonLine,
		};
	},

	cursor: (instructionFile, _prompt, { cwd }) => {
		const relPath = relative(cwd, instructionFile).replace(/\\/g, '/');
		const prompt = `Read and follow all instructions in the file: ${relPath}`;
		return {
			shellCmd: `agent --print -f --trust --output-format stream-json --workspace "${cwd}" "${prompt}"`,
			formatStream: formatCursorJsonLine,
		};
	},
};

/** Default stages from which to pull tickets (backlog excluded — parked by design). */
const PENDING_STAGES = ['fix', 'review', 'implement', 'plan'];

/** All valid stage names (for --stages validation). */
const KNOWN_STAGES = ['backlog', 'fix', 'plan', 'implement', 'review', 'complete', 'blocked'];

/** Map from stage → next stage in the pipeline (for prompt context). */
const NEXT_STAGE = {
	backlog: 'plan',
	fix: 'implement',
	plan: 'implement',
	implement: 'review',
	review: 'complete',
};

// ─── Ticket discovery ──────────────────────────────────────────────────────────

const SEQUENCE_PREFIX = /^(\d+(?:\.\d+)?)-(.+)\.md$/;

/** Parse sequence number from filename. Returns null when no numeric prefix is present. */
function parseSequence(filename) {
	const match = basename(filename).match(SEQUENCE_PREFIX);
	return match ? parseFloat(match[1]) : null;
}

/** Extract the canonical slug (filename without any numeric prefix or .md extension). */
function parseSlug(filename) {
	const base = basename(filename, '.md');
	const match = base.match(/^\d+(?:\.\d+)?-(.+)$/);
	return match ? match[1] : base;
}

/** Parse the `prereq:` header field into an array of slug strings.  Tolerates legacy `dependencies:`. */
function parsePrereqs(content) {
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
async function discoverTickets(ticketsDir, stage, maxSequence) {
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

// ─── Topological ordering ─────────────────────────────────────────────────────
// Tickets may declare `prereq: <slug>` pointing at other tickets that must land
// first.  Within the snapshot, we verify the DAG and sort so prereqs run before
// dependents.  Explicit sequence numbers that conflict with a prereq edge (prereq
// has a larger sequence than its dependent) are a hard error — the human needs
// to re-number.  Cycles are also a hard error.

/** Kahn's algorithm with sequence as the priority tiebreaker. */
function topoSortAndCheck(tickets) {
	const bySlug = new Map();
	for (const t of tickets) {
		// If two tickets in the batch share a slug (different stages), index by
		// the first-seen copy; prereqs resolve to whichever is present.
		if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
	}
	const graph = new Map(tickets.map(t => [t, []]));        // prereq-ticket → dependent-tickets
	const indegree = new Map(tickets.map(t => [t, 0]));

	for (const t of tickets) {
		for (const ref of t.prereqs) {
			const pt = bySlug.get(ref);
			if (!pt || pt === t) continue;  // prereq outside snapshot (likely already complete) — ignore
			graph.get(pt).push(t);
			indegree.set(t, indegree.get(t) + 1);
			if (pt.sequence != null && t.sequence != null && pt.sequence > t.sequence) {
				throw new Error(
					`Sequence conflict: "${pt.file}" (seq ${pt.sequence}) is a prereq of ` +
					`"${t.file}" (seq ${t.sequence}) but has a later sequence number. ` +
					`Re-number so the prereq comes first.`
				);
			}
		}
	}

	const queue = tickets.filter(t => indegree.get(t) === 0);
	const sorted = [];
	while (queue.length > 0) {
		queue.sort((a, b) => {
			const sa = a.sequence ?? Infinity;
			const sb = b.sequence ?? Infinity;
			if (sa !== sb) return sa - sb;
			return a.slug.localeCompare(b.slug);
		});
		const next = queue.shift();
		sorted.push(next);
		for (const dep of graph.get(next)) {
			indegree.set(dep, indegree.get(dep) - 1);
			if (indegree.get(dep) === 0) queue.push(dep);
		}
	}

	if (sorted.length < tickets.length) {
		const cyclic = tickets.filter(t => indegree.get(t) > 0).map(t => t.file).join(', ');
		throw new Error(`Cycle detected in ticket prereqs involving: ${cyclic}`);
	}

	return sorted;
}

// ─── Logging ───────────────────────────────────────────────────────────────────
// Logs are kept in tickets/.logs/<ticket-name>.<stage>.<timestamp>.log

/** Return the .logs dir path, ensuring it exists. */
async function ensureLogsDir(ticketsDir) {
	const logsDir = join(ticketsDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

/** Build a log file path for a ticket run. */
function logPath(logsDir, ticket) {
	const name = ticket.file.replace(/\.md$/, '');
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${name}.${ticket.stage}.${ts}.log`);
}

// ─── Stop file ─────────────────────────────────────────────────────────────────
// Create tickets/.stop to gracefully halt the runner between tickets.

async function pathExists(p) {
	try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function checkStop(ticketsDir) {
	const stopFile = join(ticketsDir, STOP_FILE);
	if (await pathExists(stopFile)) {
		await unlink(stopFile).catch(() => {});
		return true;
	}
	return false;
}

// ─── In-progress state ────────────────────────────────────────────────────────
// Before each ticket, write tickets/.in-progress with ticket info and log path.
// On success, delete it.  On next run, read and clear any leftover state so the
// agent can be told to resume from a prior incomplete run.

function inProgressPath(ticketsDir) {
	return join(ticketsDir, IN_PROGRESS_FILE);
}

/** Read and clear any prior in-progress state. Returns parsed object or null. */
async function readAndClearInProgress(ticketsDir) {
	const p = inProgressPath(ticketsDir);
	try {
		const raw = await readFile(p, 'utf-8');
		await unlink(p).catch(() => {});
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Write in-progress state before starting a ticket. */
async function writeInProgress(ticketsDir, ticket, logFile, agent) {
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
async function clearInProgress(ticketsDir) {
	await unlink(inProgressPath(ticketsDir)).catch(() => {});
}

const RESUME_MARKER_START = '<!-- resume-note -->';
const RESUME_MARKER_END = '<!-- /resume-note -->';

/** Build a resume note to prepend to a ticket file. */
function buildResumeNote(priorRun) {
	return [
		RESUME_MARKER_START,
		'RESUME: A prior agent run on this ticket did not complete.',
		`  Prior run: ${priorRun.startedAt} (agent: ${priorRun.agent})`,
		`  Log file: ${priorRun.logFile}`,
		'Read the log to see what was done. Resume where it left off.',
		'If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.',
		RESUME_MARKER_END,
		'',
	].join('\n');
}

/** Prepend a resume note to a ticket file. Idempotent — replaces any existing note. */
async function addResumeNote(ticketPath, priorRun) {
	let content = await readFile(ticketPath, 'utf-8');
	// Strip any existing resume note
	const startIdx = content.indexOf(RESUME_MARKER_START);
	const endIdx = content.indexOf(RESUME_MARKER_END);
	if (startIdx !== -1 && endIdx !== -1) {
		content = content.slice(0, startIdx) + content.slice(endIdx + RESUME_MARKER_END.length).replace(/^\n/, '');
	}
	const note = buildResumeNote(priorRun);
	await writeFile(ticketPath, note + content, 'utf-8');
}

// ─── Agent invocation ──────────────────────────────────────────────────────────

/** Build the full prompt for a ticket. */
async function buildPrompt(ticket, ticketsDir) {
	const rulesFile = join(TESS_ROOT, 'agent-rules', 'tickets.md');
	const [content, rules] = await Promise.all([
		readFile(ticket.path, 'utf-8'),
		readFile(rulesFile, 'utf-8'),
	]);
	return [
		`# Ticket: ${ticket.file} (stage: ${ticket.stage}, sequence: ${formatSeq(ticket.sequence)})`,
		`# Next stage: ${NEXT_STAGE[ticket.stage]}`,
		'',
		'## Ticket workflow rules:',
		'',
		rules,
		'',
		`## Contents of \`${ticket.path}\`:`,
		'',
		content,
		'',
		'## End',
		'Work the ticket as described above.',
		'Do NOT commit — the runner handles commits after you complete.',
	].join('\n');
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung

/**
 * Force-kill a child process and all its descendants.
 *
 * On Windows we spawn agents with `shell: true`, which means `child` is
 * `cmd.exe` wrapping the actual agent (often a Node process behind a `.cmd`
 * shim). A plain `child.kill()` only terminates cmd.exe — the agent is
 * orphaned, keeps running, and may hold log/prompt files or pipes open.
 * `taskkill /T /F` walks the process tree and force-kills every descendant.
 * On POSIX, `child.kill('SIGKILL')` is sufficient because the runner does
 * not detach into its own process group.
 */
function killTree(child) {
	if (!child || child.killed || child.exitCode != null) return;
	if (process.platform === 'win32') {
		try {
			execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
		} catch {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
	} else {
		try { child.kill('SIGKILL'); } catch { /* already gone */ }
	}
}

/** Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns exit code. */
async function runAgent(agentName, prompt, cwd, logFile, { stage } = {}) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	const adapterResult = adapter(instructionFile, prompt, { cwd, stage });
	const logStream = createWriteStream(logFile, { flags: 'a' });
	const { cmd, args, shellCmd, formatStream } = adapterResult;

	const spawnArgs = shellCmd
		? [shellCmd, [], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true }]
		: [cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false }];

	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(...spawnArgs);
			let idleTimer = null;
			let resultExitCode = null;
			let settled = false;

			function settle(code) {
				if (settled) return;
				settled = true;
				clearTimeout(idleTimer);
				logStream.end(`\n[runner] Agent exited with code ${code}\n`);
				logStream.once('finish', () => resolve(code));
				logStream.once('error', () => resolve(code));
			}

			function resetIdleTimer() {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					const msg = `\n[runner] Agent idle for ${IDLE_TIMEOUT_MS / 60000}min — killing as hung.\n`;
					process.stderr.write(msg);
					logStream.write(msg);
					killTree(child);
				}, IDLE_TIMEOUT_MS);
			}

			resetIdleTimer();

			function writeOut(text) {
				process.stdout.write(text);
				if (!logStream.write(text)) {
					child.stdout.pause();
					logStream.once('drain', () => child.stdout.resume());
				}
			}

			function processLine(line) {
				if (!formatStream) { writeOut(line + '\n'); return; }
				const result = formatStream(line);
				if (result.text) writeOut(result.text);
				if (result.done) {
					resultExitCode = result.exitCode ?? 0;
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => {
						const msg = `\n[runner] Agent sent result but didn't exit — killing stale process.\n`;
						process.stderr.write(msg);
						logStream.write(msg);
						killTree(child);
					}, 30_000);
				}
			}

			let buf = '';
			child.stdout.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				buf += chunk.toString();
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) processLine(line);
			});

			child.stderr.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				process.stderr.write(chunk);
				logStream.write(chunk);
			});

			child.on('error', (err) => {
				const label = shellCmd ? 'agent' : cmd;
				console.error(`Failed to spawn ${label}: ${err.message}`);
				logStream.end(`\n[runner] Agent spawn error: ${err.message}\n`);
				logStream.once('finish', () => reject(err));
				logStream.once('error', () => reject(err));
			});

			child.on('close', (code) => {
				if (buf) processLine(buf.trimEnd());
				settle(resultExitCode ?? code ?? 1);
			});
		});
	} finally {
		process.stdout.write('\x1b[0m');
		await unlink(instructionFile).catch(() => {});
	}
}

// ─── Git commit ────────────────────────────────────────────────────────────────

/** Stage and commit all changes for a completed ticket.  Returns true if a commit was created. */
function commitTicket(ticket, cwd) {
	try {
		// Check if there are any changes to commit
		const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();
		if (!status) return false;

		execSync('git add -A', { cwd, encoding: 'utf-8' });
		const msg = `ticket(${ticket.stage}): ${ticket.slug}`;
		execSync(`git commit -m "${msg}"`, { cwd, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Git commit failed: ${err.message}`);
		return false;
	}
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
	const lines = [
		'Ticket Runner — process outstanding tickets via agentic CLI',
		'',
		'The ticket list is snapshotted once at startup — tickets created by the agent',
		'during this run are NOT picked up until the next run.  This ensures each',
		'ticket advances exactly one stage per run.',
		'',
		'Numeric filename prefix encodes sequence (lower runs sooner); prefix is optional.',
		'Unnumbered tickets run after all numbered ones in a stage.  Tickets may declare',
		'`prereq: <slug>, <slug>` in the header — prereqs run before dependents, and a',
		'sequence number that conflicts with a prereq edge is a hard error.',
		'',
		'Usage: node tess/scripts/run.mjs [options]',
		'',
		'Options:',
		'  --max-sequence <n>   Default max sequence for all stages  (default: unlimited)',
		'                       Tickets with sequence > n are skipped; unnumbered tickets',
		'                       are skipped whenever n is finite.',
		'  --stages <list>      Comma-separated stages, optionally with per-stage max sequence',
		'                       as  stage:n  (default: fix,plan,implement,review)',
		'                       e.g.  --stages review:5,implement:3,fix',
		'                             --stages backlog:2  (backlog is not in the default set)',
		'  --agent <name>       claude | auggie | cursor | codex      (default: claude)',
		'  --max <n>            Stop after at most n tickets          (default: unlimited)',
		'  --no-commit          Skip automatic git commit after each ticket',
		'  --dry-run            List tickets without invoking agent',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

/**
 * Parse --stages value into an ordered array of { stage, maxSequence } entries.
 * Bare stage names use the global defaultMax.
 */
function parseStages(raw, defaultMax) {
	return raw.split(',').map(token => {
		const [stage, pStr] = token.trim().split(':');
		const maxSequence = pStr !== undefined ? parseFloat(pStr) : defaultMax;
		return { stage, maxSequence };
	});
}

function parseArgs(argv) {
	const opts = {
		maxSequence: Infinity,
		agent: 'claude',
		dryRun: false,
		noCommit: false,
		maxTickets: Infinity,
		stagesRaw: null,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--max-sequence':
				opts.maxSequence = parseFloat(argv[++i]);
				break;
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--no-commit':
				opts.noCommit = true;
				break;
			case '--max':
				opts.maxTickets = parseInt(argv[++i], 10);
				break;
			case '--stages':
				opts.stagesRaw = argv[++i];
				break;
			case '--help':
				printHelp();
				process.exit(0);
		}
	}

	const stagesRaw = opts.stagesRaw ?? PENDING_STAGES.join(',');
	const stages = parseStages(stagesRaw, opts.maxSequence);

	for (const { stage } of stages) {
		if (!KNOWN_STAGES.includes(stage)) {
			console.error(`Unknown stage: "${stage}". Valid stages: ${KNOWN_STAGES.join(', ')}`);
			process.exit(1);
		}
	}

	return { ...opts, stages };
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

function formatSeq(seq) {
	return seq == null ? '--' : String(seq);
}

function formatStageSummary(stages) {
	return stages.map(({ stage, maxSequence }) =>
		Number.isFinite(maxSequence) ? `${stage}(<=${maxSequence})` : stage
	).join(', ');
}

/** Run migration if needed and commit the result.  Returns whether a commit was made. */
async function runMigrationIfNeeded(ticketsDir, repoRoot, { noCommit, dryRun }) {
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
	try {
		const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' }).trim();
		if (!status) return false;
		execSync('git add -A', { cwd: repoRoot, encoding: 'utf-8' });
		execSync(`git commit -m "tess: migrate ticket format to v${FORMAT_VERSION}"`, { cwd: repoRoot, encoding: 'utf-8' });
		console.log('    Committed migration.');
		return true;
	} catch (err) {
		console.error(`    Migration commit failed: ${err.message}`);
		return false;
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	const repoRoot = process.cwd();
	const ticketsDir = join(repoRoot, 'tickets');
	const tessVersion = getTessVersion();

	// Auto-migrate legacy format before snapshotting tickets.
	await runMigrationIfNeeded(ticketsDir, repoRoot, { noCommit: opts.noCommit, dryRun: opts.dryRun });

	const allTickets = [];
	for (const { stage, maxSequence } of opts.stages) {
		const tickets = await discoverTickets(ticketsDir, stage, maxSequence);
		allTickets.push(...tickets);
	}

	if (allTickets.length === 0) {
		console.log(`No tickets found in stages: ${formatStageSummary(opts.stages)}`);
		return;
	}

	// Within each stage: topologically sort by prereqs (sequence-asc as tiebreaker).
	// Across stages: preserve the pipeline order declared via --stages.
	const byStage = new Map();
	for (const t of allTickets) {
		if (!byStage.has(t.stage)) byStage.set(t.stage, []);
		byStage.get(t.stage).push(t);
	}
	const ordered = [];
	for (const { stage } of opts.stages) {
		const bucket = byStage.get(stage);
		if (!bucket) continue;
		try {
			ordered.push(...topoSortAndCheck(bucket));
		} catch (err) {
			console.error(`\n[runner] ${err.message}`);
			process.exit(1);
		}
	}
	allTickets.length = 0;
	allTickets.push(...ordered);

	const totalFound = allTickets.length;
	if (opts.maxTickets < totalFound) allTickets.splice(opts.maxTickets);

	if (opts.dryRun) {
		console.log(`\ntess (${tessVersion})`);
		console.log(`Pending tickets in: ${formatStageSummary(opts.stages)}\n`);
		for (const t of allTickets) {
			console.log(`  [${t.stage.padEnd(9)}] seq ${formatSeq(t.sequence).padStart(4)}  ${t.file}`);
		}
		const limitNote = totalFound > allTickets.length ? ` (limited to ${allTickets.length} of ${totalFound})` : '';
		console.log(`\n${allTickets.length} ticket(s) would be processed${limitNote}.`);
		return;
	}

	// ── Read prior in-progress state (incomplete previous run) ──
	const priorRun = await readAndClearInProgress(ticketsDir);
	if (priorRun) {
		console.log(`\n  Prior incomplete run detected: ${priorRun.file} (${priorRun.stage})`);
		console.log(`    Started: ${priorRun.startedAt}  |  Log: ${priorRun.logFile}`);
		// If the ticket is still in the batch, annotate it with a resume note
		const match = allTickets.find(t => t.file === priorRun.file && t.stage === priorRun.stage);
		if (match) {
			try {
				await addResumeNote(match.path, priorRun);
				console.log(`    Added resume note to ${match.file}`);
			} catch (err) {
				console.warn(`    Failed to add resume note: ${err.message}`);
			}
		} else {
			console.log(`    Ticket no longer in batch — skipping resume note.`);
		}
	}

	const limitNote = totalFound > allTickets.length ? `, limited to ${allTickets.length}` : '';
	const banner = [
		`${'═'.repeat(72)}`,
		`  tess (${tessVersion})`,
		`  Snapshotted ${totalFound} ticket(s)${limitNote}.`,
		`${'═'.repeat(72)}`,
	].join('\n');
	console.log(banner);

	const logsDir = await ensureLogsDir(ticketsDir);

	for (let i = 0; i < allTickets.length; i++) {
		if (await checkStop(ticketsDir)) {
			console.log('\n⏹  Stop file detected — halting before next ticket.');
			break;
		}

		const ticket = allTickets[i];

		// Guard: a previous agent may have already moved this ticket
		try {
			await access(ticket.path, constants.R_OK);
		} catch {
			console.log(`\n  [${i + 1}/${allTickets.length}] Skipped (already moved): ${ticket.file}\n`);
			continue;
		}

		const currentLog = logPath(logsDir, ticket);

		const ticketBanner = [
			`${'─'.repeat(72)}`,
			`  [${i + 1}/${allTickets.length}] ${ticket.file}`,
			`  Stage: ${ticket.stage} → ${NEXT_STAGE[ticket.stage]}  |  Sequence: ${formatSeq(ticket.sequence)}`,
			`  Log: ${currentLog}`,
			`${'─'.repeat(72)}`,
		].join('\n');
		console.log(ticketBanner);

		await writeFile(currentLog, [
			`Ticket: ${ticket.file}`,
			`Stage: ${ticket.stage} → ${NEXT_STAGE[ticket.stage]}`,
			`Sequence: ${formatSeq(ticket.sequence)}`,
			`Agent: ${opts.agent}`,
			`Tess: ${tessVersion}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		// Track this ticket as in-progress
		await writeInProgress(ticketsDir, ticket, currentLog, opts.agent);

		const prompt = await buildPrompt(ticket, ticketsDir);
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog, { stage: ticket.stage });

		if (exitCode !== 0) {
			console.error(`\nAgent exited with code ${exitCode} on ticket: ${ticket.file}`);
			console.error(`Log: ${currentLog}`);
			console.error('Stopping to avoid cascading failures. Re-run to retry.');
			process.exit(exitCode);
		}

		// Ticket completed — clear in-progress state
		await clearInProgress(ticketsDir);

		if (!opts.noCommit && commitTicket(ticket, repoRoot)) {
			console.log(`  Committed.`);
		}

		console.log(`\n  [${i + 1}/${allTickets.length}] Complete: ${ticket.file}\n`);

		if (i < allTickets.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}

	console.log(`\nDone.`);
}

main().catch((err) => {
	console.error('Ticket runner failed:', err);
	process.exit(1);
});
