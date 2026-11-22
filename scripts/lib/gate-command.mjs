/**
 * Runs a project's declared `gate-command:` (lib/project-rules.mjs) — tess's
 * generic post-agent, pre-commit hook.  One shell command, run once per
 * ticket stage transition, in the project root, with the transition in its
 * environment.  A non-zero exit is the signal lib/run-ticket.mjs turns into a
 * halt: nothing is committed, same as a stage overrun or an unsalvageable
 * dirty tree.
 */

import { execSync } from 'node:child_process';

export const MAX_GATE_RETRIES = 1; // resume the agent once to fix a gate-command failure before halting

/**
 * Run `command` in `cwd` with `env`.  Returns `{ ok: true }` on a zero exit,
 * `{ ok: false, output }` otherwise — `output` is the command's combined
 * stdout+stderr, trimmed, for the halt message.  `timeoutMs`, when given, kills
 * the command past that wall time, which reads as a failure.  `exec` is
 * swappable for tests; the real one throws on a non-zero exit, which is exactly
 * the signal this turns into `ok: false`.
 */
export function runGateCommand(command, { cwd, env, timeoutMs }, { exec = execSync } = {}) {
	try {
		exec(command, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...(timeoutMs ? { timeout: timeoutMs } : {}) });
		return { ok: true };
	} catch (err) {
		const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
		const timedOut = timeoutMs && err.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeoutMs / 1000)} s\n` : '';
		return { ok: false, output: `${timedOut}${output || err.message}`.trim() };
	}
}
