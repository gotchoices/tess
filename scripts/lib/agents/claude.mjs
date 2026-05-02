/**
 * Claude adapter — invokes `claude` with stream-json output.
 *
 * On Windows we spawn through a shell so npm shims (.cmd/.ps1) resolve; on
 * POSIX we exec the binary directly.
 *
 * When a token budget is configured, the adapter registers a PreToolUse hook
 * (lib/budget-hook.mjs) via a temp `--settings` file.  The runner writes the
 * warning to the file named by TESS_BUDGET_FLAG_FILE once the soft budget is
 * crossed; the hook injects it into the model's next turn.  We write to a
 * file rather than passing JSON inline so the cross-platform shell-quoting
 * rules don't bite — `--settings <path>` is one path argument.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(__dirname, '..', 'budget-hook.mjs');

/** Sum of tokens that occupy the model's context window for a given turn. */
function contextSize(usage) {
	if (!usage) return 0;
	return (usage.input_tokens ?? 0)
		+ (usage.cache_read_input_tokens ?? 0)
		+ (usage.cache_creation_input_tokens ?? 0);
}

/**
 * Format Claude stream-json lines to readable text.
 * Returns { text, done?, usage? } — when done is true the agent has emitted
 * its final result and the runner should stop waiting for a clean exit;
 * `usage` (when present) is the per-turn context-window size in tokens.
 */
function formatStream(line) {
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
			const usage = obj.message?.usage;
			return { text: parts.join('') || '', usage: usage ? contextSize(usage) : undefined };
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

/** Settings JSON registering the PreToolUse hook that injects BUDGET_WARNING. */
function buildBudgetSettings() {
	return JSON.stringify({
		hooks: {
			PreToolUse: [
				{
					matcher: '*',
					hooks: [
						{ type: 'command', command: `node "${HOOK_SCRIPT}"` },
					],
				},
			],
		},
	}, null, 2);
}

export async function claude(instructionFile, _prompt, { stage, tokenBudget } = {}) {
	const effort = 'xhigh';
	const args = [
		'-p',
		'--dangerously-skip-permissions',
		'--verbose',
		'--no-session-persistence',
		'--output-format', 'stream-json',
		'--effort', effort,
		'--append-system-prompt-file', instructionFile,
	];
	const cleanupFiles = [];
	if (Number.isFinite(tokenBudget)) {
		const settingsFile = instructionFile.replace(/\.prompt\.md$/, '.settings.json');
		await writeFile(settingsFile, buildBudgetSettings(), 'utf-8');
		args.push('--settings', settingsFile);
		cleanupFiles.push(settingsFile);
	}
	args.push('Work the ticket as described in the appended system prompt.');
	// On Windows, spawn() with shell:false cannot resolve .cmd/.ps1 shims
	// installed by npm. Use shellCmd so spawn() runs with shell:true instead.
	if (process.platform === 'win32') {
		const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
		return { shellCmd: `claude ${escaped}`, formatStream, cleanupFiles };
	}
	return { cmd: 'claude', args, formatStream, cleanupFiles };
}
