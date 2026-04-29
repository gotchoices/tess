/**
 * Claude adapter — invokes `claude` with stream-json output.
 *
 * On Windows we spawn through a shell so npm shims (.cmd/.ps1) resolve; on
 * POSIX we exec the binary directly.
 */

/**
 * Format Claude stream-json lines to readable text.
 * Returns { text, done? } — when done is true the agent has emitted its
 * final result and the runner should stop waiting for a clean exit.
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

export function claude(instructionFile, _prompt, { stage }) {
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
		return { shellCmd: `claude ${escaped}`, formatStream };
	}
	return { cmd: 'claude', args, formatStream };
}
