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
	const ns = `mcp__${serverName.replace(/-/g, '_')}__`;
	return [
		'',
		'## Code-search tools (registered for this project)',
		'',
		'This project has a local semantic + literal code-search index. Use these tools FIRST for codebase exploration, before grep/Glob/Read:',
		'',
		`- \`${ns}search_code(query, k?, path_filter?)\` — semantic search. Use it whenever you want to **understand** something, even when you already know an identifier: what a symbol does, what invariant a function maintains, how two concepts relate, what existing patterns look like. Example: instead of \`grep "I4|I21" docs/invariant-catalog.md\`, call \`search_code("what does invariant I4 mean for overlay allocation")\`.`,
		`- \`${ns}find_references(symbol, max?, path_filter?)\` — literal-substring search across the index. Accepts \`|\`-separated alternatives that are OR-ed (each side is still a literal substring, not a regex), e.g. \`"composeNewSlot|defaultComposeNewSlot"\`. Use it when you want every occurrence of a name (or a small family of names).`,
		`- \`${ns}read_chunk(path, start_line, end_line)\` — expand a snippet returned by either search tool without spawning a Read call.`,
		'',
		'Reach for grep/Glob only when you need filename patterns, regex with anchors/lookarounds, or a guarantee that you have *every* literal hit (the index has chunk granularity).',
		'',
	].join('\n');
}
