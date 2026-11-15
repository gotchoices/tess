/**
 * Runs a project's declared `gate-command:` (lib/project-rules.mjs) — tess's
 * generic post-agent, pre-commit hook.  One shell command, run once per
 * ticket stage transition, in the project root, with the transition in its
 * environment.  A non-zero exit is the signal lib/run-ticket.mjs turns into a
 * halt: nothing is committed, same as a stage overrun or an unsalvageable
 * dirty tree.
 */

import { execSync } from 'node:child_process';

/**
 * Run `command` in `cwd` with `env`.  Returns `{ ok: true }` on a zero exit,
 * `{ ok: false, output }` otherwise — `output` is the command's combined
 * stdout+stderr, trimmed, for the halt message.  `exec` is swappable for
 * tests; the real one throws on a non-zero exit, which is exactly the signal
 * this turns into `ok: false`.
 */
export function runGateCommand(command, { cwd, env }, { exec = execSync } = {}) {
	try {
		exec(command, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
		return { ok: true };
	} catch (err) {
		const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
		return { ok: false, output: output || err.message };
	}
}
