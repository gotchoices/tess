/**
 * Agent process invocation.
 *
 * Spawns the chosen agent adapter, tees stdout/stderr to a log file, and
 * applies an idle-timeout watchdog.  When an agent emits a "done" stream
 * record but doesn't exit promptly, the watchdog force-kills the process
 * tree so the runner doesn't hang.
 */

import { spawn, execSync } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { agents } from './agents/index.mjs';

export const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung
export const MAX_TIMEOUT_RETRIES = 1;          // retry a ticket once on idle timeout before moving on

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

/** Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns { exitCode, timedOut }. */
export async function runAgent(agentName, prompt, cwd, logFile, { stage } = {}) {
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
			let timedOut = false;

			function settle(code) {
				if (settled) return;
				settled = true;
				clearTimeout(idleTimer);
				logStream.end(`\n[runner] Agent exited with code ${code}\n`);
				logStream.once('finish', () => resolve({ exitCode: code, timedOut }));
				logStream.once('error', () => resolve({ exitCode: code, timedOut }));
			}

			function resetIdleTimer() {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					timedOut = true;
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
