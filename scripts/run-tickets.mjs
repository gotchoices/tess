#!/usr/bin/env node
/**
 * Ticket Runner — processes outstanding tickets through the pipeline stages
 * by invoking an agentic CLI tool for each one.
 *
 * Version: 1.0.0
 *
 * Key design choices:
 *   - The ticket list is snapshotted once at startup.  Tickets created by the agent
 *     during this run are NOT picked up, ensuring each ticket advances exactly one
 *     stage per invocation of the runner.
 *   - The agent owns the full stage transition: it creates next-stage file(s),
 *     deletes the source ticket file, and commits everything.  This allows the agent
 *     to split one ticket into multiple next-stage tickets, adjust priorities, etc.
 *   - Agent logs are captured in tickets/.logs/ (git-ignored), one per ticket per stage.
 *
 * Usage:
 *   node tess/scripts/run-tickets.mjs [options]
 *
 * Options:
 *   --min-priority <n>   Default min priority for all stages  (default: 3)
 *   --stages <list>      Comma-separated stages to process, optionally with per-stage
 *                        min priority as  stage:n  (default: fix,plan,implement,review)
 *                        Examples:
 *                          --stages fix,implement
 *                          --stages review:5,implement:3
 *                          --stages fix:4,implement,review:5  (uses --min-priority for bare names)
 *   --agent <name>       Agent adapter to use: claude | auggie | cursor  (default: claude)
 *   --dry-run            List tickets that would be processed, don't invoke agent
 *   --help               Show this help
 */

import { readdir, readFile, access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename, relative, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── Path resolution ───────────────────────────────────────────────────────────
// The runner lives at tess/scripts/run-tickets.mjs.
// tess root = ../../ from this file.  tickets/ and repo root are resolved from cwd.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TESS_ROOT = join(__dirname, '..');

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

// ─── Agent adapters ────────────────────────────────────────────────────────────
// Each adapter returns { cmd, args } or { shellCmd } for spawning the agent process.
// `instructionFile` is the path to a temp file containing the full prompt.
// When shellCmd is set, it is passed as a single string to avoid DEP0190 (Windows + shell:true).

const agents = {
	claude: (instructionFile, _prompt, { stage }) => {
		const effort = (stage === 'fix' || stage === 'plan' || stage === 'review') ? 'high' : 'medium';
		return {
			cmd: 'claude',
			args: [
				'-p',
				'--dangerously-skip-permissions',
				'--verbose',
				'--no-session-persistence',
				'--output-format', 'stream-json',
				'--effort', effort,
				'--append-system-prompt-file', instructionFile,
				'Work the ticket as described in the appended system prompt.',
			],
			formatStream: formatClaudeJsonLine,
		};
	},

	auggie: (instructionFile, _prompt) => ({
		cmd: 'auggie',
		args: ['--print', '--instruction', instructionFile],
	}),

	cursor: (instructionFile, _prompt, { cwd }) => {
		const relPath = relative(cwd, instructionFile).replace(/\\/g, '/');
		const prompt = `Read and follow all instructions in the file: ${relPath}`;
		return {
			shellCmd: `agent --print -f --trust --output-format stream-json --workspace "${cwd}" "${prompt}"`,
			formatStream: formatCursorJsonLine,
		};
	},
};

/** Stages from which to pull tickets. */
const PENDING_STAGES = ['fix', 'review', 'implement', 'plan'];

/** Map from stage → next stage in the pipeline (for prompt context). */
const NEXT_STAGE = {
	fix: 'implement',
	plan: 'implement',
	implement: 'review',
	review: 'complete',
};

// ─── Ticket discovery ──────────────────────────────────────────────────────────

const PRIORITY_PREFIX = /^(\d+)-/;
/** Parse priority number from filename like "3-some-ticket.md" → 3. Returns 0 if unparseable. */
function parsePriority(filename) {
	const match = basename(filename).match(PRIORITY_PREFIX);
	return match ? parseInt(match[1], 10) : 0;
}

/** Discover all .md ticket files in a stage folder, filtered by min priority. */
async function discoverTickets(ticketsDir, stage, minPriority) {
	const stageDir = join(ticketsDir, stage);
	try {
		await access(stageDir, constants.R_OK);
	} catch {
		return [];
	}

	const entries = await readdir(stageDir);
	const tickets = [];

	for (const entry of entries) {
		if (!entry.endsWith('.md') || !PRIORITY_PREFIX.test(entry)) continue;

		const priority = parsePriority(entry);
		if (priority < minPriority) continue;

		tickets.push({
			file: entry,
			path: join(stageDir, entry),
			stage,
			priority,
		});
	}

	tickets.sort((a, b) => b.priority - a.priority);
	return tickets;
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

// ─── Agent invocation ──────────────────────────────────────────────────────────

/** Build the full prompt for a ticket. */
async function buildPrompt(ticket, ticketsDir) {
	const rulesFile = join(TESS_ROOT, 'agent-rules', 'tickets.md');
	const [content, rules] = await Promise.all([
		readFile(ticket.path, 'utf-8'),
		readFile(rulesFile, 'utf-8'),
	]);
	return [
		`# Ticket: ${ticket.file} (stage: ${ticket.stage}, priority: ${ticket.priority})`,
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
		'When you are done, commit everything with a message like: "ticket(<stage>): <short description>"',
	].join('\n');
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung

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
					child.kill();
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
						child.kill();
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
		await unlink(instructionFile).catch(() => {});
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
		'Usage: node tess/scripts/run-tickets.mjs [options]',
		'',
		'Options:',
		'  --min-priority <n>   Default min priority for all stages  (default: 3)',
		'  --stages <list>      Comma-separated stages, optionally with per-stage min priority',
		'                       as  stage:n  (default: fix,plan,implement,review)',
		'                       e.g.  --stages review:5,implement:3,fix',
		'  --agent <name>       claude | auggie | cursor              (default: claude)',
		'  --dry-run            List tickets without invoking agent',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

/**
 * Parse --stages value into an ordered array of { stage, minPriority } entries.
 * Bare stage names use the global defaultMin.
 */
function parseStages(raw, defaultMin) {
	return raw.split(',').map(token => {
		const [stage, pStr] = token.trim().split(':');
		const minPriority = pStr !== undefined ? parseInt(pStr, 10) : defaultMin;
		return { stage, minPriority };
	});
}

function parseArgs(argv) {
	const opts = {
		minPriority: 3,
		agent: 'claude',
		dryRun: false,
		stagesRaw: null,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--min-priority':
				opts.minPriority = parseInt(argv[++i], 10);
				break;
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--dry-run':
				opts.dryRun = true;
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
	const stages = parseStages(stagesRaw, opts.minPriority);

	for (const { stage } of stages) {
		if (!PENDING_STAGES.includes(stage)) {
			console.error(`Unknown stage: "${stage}". Valid stages: ${PENDING_STAGES.join(', ')}`);
			process.exit(1);
		}
	}

	return { ...opts, stages };
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	const repoRoot = process.cwd();
	const ticketsDir = join(repoRoot, 'tickets');
	const tessVersion = getTessVersion();

	const allTickets = [];
	for (const { stage, minPriority } of opts.stages) {
		const tickets = await discoverTickets(ticketsDir, stage, minPriority);
		allTickets.push(...tickets);
	}

	if (allTickets.length === 0) {
		const stageSummary = opts.stages.map(({ stage, minPriority }) => `${stage}(>=${minPriority})`).join(', ');
		console.log(`No tickets found in stages: ${stageSummary}`);
		return;
	}

	const stageOrder = new Map(opts.stages.map(({ stage }, i) => [stage, i]));
	allTickets.sort((a, b) => {
		const sa = stageOrder.get(a.stage) ?? 999;
		const sb = stageOrder.get(b.stage) ?? 999;
		if (sa !== sb) return sa - sb;
		return b.priority - a.priority;
	});

	if (opts.dryRun) {
		const stageSummary = opts.stages.map(({ stage, minPriority }) => `${stage}(>=${minPriority})`).join(', ');
		console.log(`\ntess (${tessVersion})`);
		console.log(`Pending tickets in: ${stageSummary}\n`);
		for (const t of allTickets) {
			console.log(`  [${t.stage.padEnd(9)}] P${t.priority}  ${t.file}`);
		}
		console.log(`\n${allTickets.length} ticket(s) would be processed.`);
		return;
	}

	const banner = [
		`${'═'.repeat(72)}`,
		`  tess (${tessVersion})`,
		`  Snapshotted ${allTickets.length} ticket(s) to process.`,
		`${'═'.repeat(72)}`,
	].join('\n');
	console.log(banner);

	const logsDir = await ensureLogsDir(ticketsDir);

	for (let i = 0; i < allTickets.length; i++) {
		const ticket = allTickets[i];
		const currentLog = logPath(logsDir, ticket);

		const ticketBanner = [
			`${'─'.repeat(72)}`,
			`  [${i + 1}/${allTickets.length}] ${ticket.file}`,
			`  Stage: ${ticket.stage} → ${NEXT_STAGE[ticket.stage]}  |  Priority: ${ticket.priority}`,
			`  Log: ${currentLog}`,
			`${'─'.repeat(72)}`,
		].join('\n');
		console.log(ticketBanner);

		await writeFile(currentLog, [
			`Ticket: ${ticket.file}`,
			`Stage: ${ticket.stage} → ${NEXT_STAGE[ticket.stage]}`,
			`Priority: ${ticket.priority}`,
			`Agent: ${opts.agent}`,
			`Tess: ${tessVersion}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildPrompt(ticket, ticketsDir);
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog, { stage: ticket.stage });

		if (exitCode !== 0) {
			console.error(`\nAgent exited with code ${exitCode} on ticket: ${ticket.file}`);
			console.error(`Log: ${currentLog}`);
			console.error('Stopping to avoid cascading failures. Re-run to retry.');
			process.exit(exitCode);
		}

		console.log(`\n  [${i + 1}/${allTickets.length}] Complete: ${ticket.file}\n`);

		if (i < allTickets.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}

	console.log(`\nDone — ${allTickets.length} ticket(s) processed.`);
}

main().catch((err) => {
	console.error('Ticket runner failed:', err);
	process.exit(1);
});
