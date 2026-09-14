/**
 * Builds agent prompts: the per-ticket prompt (workflow rules + ticket
 * contents + framing) and the gardener's (garden rules + shared conventions +
 * backlog inventory + human feedback).
 *
 * If the project has the local code-search MCP server wired up AND the index
 * has been built, a directive block is injected at the END of the prompt
 * naming the exact `mcp__<server>__<tool>` ids — agents weight the last
 * instruction in the prompt heavily, so this is where the nudge has the most
 * effect.  When search isn't available, no mention of it appears at all.
 *
 * The rules file contains `<!-- stage:NAME -->...<!-- /stage -->` blocks for
 * every stage so a human reads one coherent document; at prompt-build time we
 * keep only the active stage's block, reducing cognitive load and leaving
 * room for per-stage rules to grow without bloating cross-stage context.
 * The project's rules addenda (`tickets/rules/*.md`) follow the core rules,
 * filtered the same way.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NEXT_STAGE, formatSeq } from './tickets.mjs';
import { RULES_DIR, readProjectRules } from './project-rules.mjs';
import { detectSearch } from './detect-search.mjs';
import { boardCheckLines, inventoryText, releaseSummary } from './garden-inventory.mjs';

/**
 * Build the full prompt for a ticket.
 *
 * `prereqNotes` (from lib/tickets.mjs) carries the prereq resolutions the
 * ticket file cannot explain on its own — a slug that landed and was later
 * pruned out of `complete/`, or one nothing on the board vouches for.  Agents
 * have mis-triaged the former as blocked-on-missing-work, so it goes in the
 * prompt, not just the runner's console.
 */
export async function buildPrompt(ticket, tessRoot, repoRoot, prereqNotes = []) {
	const rulesFile = join(tessRoot, 'agent-rules', 'tickets.md');
	const [content, rules, projectRules, searchServer] = await Promise.all([
		readFile(ticket.path, 'utf-8'),
		readFile(rulesFile, 'utf-8'),
		readProjectRules(join(repoRoot, 'tickets')),
		detectSearch(repoRoot),
	]);

	const sections = [
		`# Ticket: ${ticket.file} (stage: ${ticket.stage}, sequence: ${formatSeq(ticket.sequence)})`,
		`# Next stage: ${NEXT_STAGE[ticket.stage]}`,
		'',
		'## Ticket workflow rules:',
		'',
		filterStageBlocks(rules, ticket.stage),
		// NOTE: every addendum rides in every ticket prompt, uncapped.  If addenda grow large, cap
		// their size or require stage blocks, so each stage pays only for the text it uses.
		...projectRuleSections(projectRules.rules, ticket.stage),
		'',
		`## Contents of \`${ticket.path}\`:`,
		'',
		content,
		'',
		'## End',
	];

	if (prereqNotes.length > 0) {
		sections.push(
			'',
			'## Prereq status (resolved by the runner)',
			'',
			...prereqNotes.map(n => `- ${n}`),
			'',
			'A prereq marked `pruned` has already landed — its ticket was archived and swept out of `complete/`. Treat it as done.',
		);
	}

	if (searchServer) {
		sections.push(searchDirective(searchServer));
	}

	sections.push(
		'Work ticket as described above.',
		'Do NOT commit — runner handles commits after you complete.',
	);

	return sections.join('\n');
}

/**
 * Build the gardener's prompt for one pass over the backlog.
 *
 * `inventory` is lib/garden-inventory.mjs `buildInventory`'s result, `rules`
 * the project rules addenda (`readProjectRules(…).rules`), and `board`
 * `checkBoard`'s `{ errors, warnings }`, which get a section only when there
 * are any.  A null `feedback` means none was given, and the prompt then
 * forbids every move the garden rules reserve for the human.
 */
export async function buildGardenPrompt(tessRoot, repoRoot, { inventory, releases, rules, board, declineAfterDays, feedback }) {
	const [gardenRules, sharedRules, searchServer] = await Promise.all([
		readFile(join(tessRoot, 'agent-rules', 'garden.md'), 'utf-8'),
		readFile(join(tessRoot, 'agent-rules', 'tickets.md'), 'utf-8'),
		detectSearch(repoRoot),
	]);
	const { top, folders } = inventory.counts;
	const boardLines = boardCheckLines(board);

	const sections = [
		`# Backlog gardening pass — ${top + folders} ticket(s) in tickets/backlog/ (${top} at the top level, ${folders} in sub-folders)`,
		'',
		'## Gardening rules:',
		'',
		gardenRules,
		'',
		'## Shared workflow conventions (stage-specific blocks removed):',
		'',
		filterStageBlocks(sharedRules, null),
		...projectRuleSections(rules, null),
	];

	if (boardLines.length > 0) {
		sections.push(
			'',
			'## Board check',
			'',
			'The runner\'s startup board check finds these on the current board. Report them; do not rename folders or move tickets to clear them.',
			'',
			...boardLines,
		);
	}

	sections.push(
		'',
		'## Backlog inventory (headers only — read the full files you act on):',
		'',
		releaseSummary(releases),
		`Paths are relative to tickets/backlog/. \`age\` is whole days since the ticket arrived at the top level of backlog/, read from git history (\`new\`: no commit has put it there yet). \`PROPOSE-DECLINE\` marks an age of ${declineAfterDays} days or more.`,
		'',
		...inventoryText(inventory.groups),
		'## Human feedback:',
		'',
		feedback ?? 'None provided this pass — consolidate, backfill, rank, and propose declines only. Do NOT decline, promote, defer, or pull forward any ticket.',
		'',
		'## End',
	);

	if (searchServer) {
		sections.push(searchDirective(searchServer));
	}

	sections.push(
		'Work the gardening pass as described above.',
		'Do NOT commit — the runner handles the commit after you complete.',
	);

	return sections.join('\n');
}

/**
 * Prompt lines for the project's rules addenda (lib/project-rules.mjs): per
 * addendum, a blank line, a `## Project rules (tickets/rules/<name>)` heading,
 * a blank line and its body with stage blocks filtered by `filterStageBlocks`
 * (`keepStage` null strips them all, as for the gardener).  An addendum with
 * nothing left to say — a declaration-only file — adds no heading.
 */
export function projectRuleSections(rules, keepStage) {
	return rules.flatMap(({ name, body }) => {
		const text = filterStageBlocks(body, keepStage).trim();
		return text === '' ? [] : ['', `## Project rules (tickets/${RULES_DIR}/${name})`, '', text];
	});
}

// Strip every `<!-- stage:NAME -->...<!-- /stage -->` block except the one
// matching `keepStage`; pass `null` to strip ALL stage blocks (used by the
// gardener, which wants only the cross-stage conventions).  Falls through
// unchanged when the file has no markers (legacy) or a named keepStage isn't
// marked (config skew) — both are safer than emptying the rules section.
// Line endings are normalized to LF before processing so CRLF checkouts
// (Windows) match the same regexes.
export function filterStageBlocks(rules, keepStage) {
	const normalized = rules.replace(/\r\n/g, '\n');
	const stageNames = [...normalized.matchAll(/<!-- stage:(\w+) -->/g)].map(m => m[1]);
	if (stageNames.length === 0) return normalized;
	if (keepStage !== null && !stageNames.includes(keepStage)) return normalized;
	const filtered = normalized.replace(
		/<!-- stage:(\w+) -->\n?([\s\S]*?)\n?<!-- \/stage -->\n?/g,
		(_match, name, body) => name === keepStage ? body + '\n' : '',
	);
	// Collapse the blank-line runs left behind where blocks were removed.
	return filtered.replace(/\n{3,}/g, '\n\n');
}

export function searchDirective(serverName) {
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
		'Deferred tools — load schemas first:',
		'',
		`    ToolSearch({ query: "select:${toolNames.join(',')}" })`,
		'',
		'Use them before grep/Glob/Read for codebase exploration. Picking right one matters:',
		'',
		'- **Identifier-shaped query** (single symbol, camelCase, snake_case, or name list like `fooBar bazQux`) → `find_references`.',
		'- **Prose query** ("where do we…", "what handles…", identifier unknown) → `search_code`.',
		'',
		'`search_code` embeds query as natural language, so identifier bag collapses to noise (negative cosine / "weak top" warning). On weak-top result, switch tool or rephrase — do not trust relative-% ranking on noisy hits. See AGENTS.md § Code search for full tool surface, parameters, fallback rules.',
		'',
	].join('\n');
}
