/**
 * Builds the per-ticket prompt: workflow rules + ticket contents + framing.
 *
 * If the project has the local code-search MCP server wired up AND the index
 * has been built, a directive block is injected at the END of the prompt
 * naming the exact `mcp__<server>__<tool>` ids — agents weight the last
 * instruction in the prompt heavily, so this is where the nudge has the most
 * effect.  When search isn't available, no mention of it appears at all.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NEXT_STAGE, formatSeq } from './tickets.mjs';
import { detectSearch } from './detect-search.mjs';

/** Build the full prompt for a ticket. */
export async function buildPrompt(ticket, tessRoot, repoRoot) {
	const rulesFile = join(tessRoot, 'agent-rules', 'tickets.md');
	const [content, rules, searchServer] = await Promise.all([
		readFile(ticket.path, 'utf-8'),
		readFile(rulesFile, 'utf-8'),
		detectSearch(repoRoot),
	]);

	const sections = [
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
	];

	if (searchServer) {
		sections.push(searchDirective(searchServer));
	}

	sections.push(
		'Work the ticket as described above.',
		'Do NOT commit — the runner handles commits after you complete.',
	);

	return sections.join('\n');
}

function searchDirective(serverName) {
	// MCP tool ids preserve the server name verbatim — e.g. server "code-search"
	// gives `mcp__code-search__search_code` (with the dash, not an underscore).
	// Full tool surface is documented in the project's root AGENTS.md (see
	// tess/agent-rules/search.md, appended by `init.mjs --with-search`).  This
	// block exists to (a) load the deferred schemas, (b) recency-bias the agent
	// toward search before grep/Glob/Read, and (c) embed the choice rule —
	// agents have been seen feeding identifier lists into search_code, which
	// embeds as noise (weak-top warning) and wastes a tool call.
	const ns = `mcp__${serverName}__`;
	const toolNames = [`${ns}search_code`, `${ns}find_references`, `${ns}read_chunk`];
	return [
		'',
		'## Code-search tools',
		'',
		'These tools are deferred — load their schemas first:',
		'',
		`    ToolSearch({ query: "select:${toolNames.join(',')}" })`,
		'',
		'Then use them before grep/Glob/Read for codebase exploration. Picking the right one matters:',
		'',
		'- **Identifier-shaped query** (single symbol, camelCase, snake_case, or a list of names like `fooBar bazQux`) → `find_references`.',
		'- **Prose query** ("where do we…", "what handles…", you do not yet know the identifier) → `search_code`.',
		'',
		'`search_code` embeds the query as natural language, so a bag of identifiers collapses to noise (negative cosine / "weak top" warning). On a weak-top result, switch tool or rephrase — do not trust the relative-% ranking on noisy hits. See AGENTS.md § Code search for the full tool surface, parameters, and fallback rules.',
		'',
	].join('\n');
}
