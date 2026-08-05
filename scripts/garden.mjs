#!/usr/bin/env node
/**
 * Backlog Gardener — one dedicated agent pass over tickets/backlog/.
 *
 * Every processing stage generates backlog tickets, but the backlog drains
 * only through a human.  The gardener turns a flat, ever-growing queue into
 * fewer, better-ranked decisions: it backfills triage headers
 * (severity/likelihood/tradeoffs), merges duplicates, clusters instances of
 * one underlying weakness into theme tickets, ranks the queue, and — only on
 * explicit human feedback — executes declines (recorded as accepted-tradeoff
 * `NOTE:` comments at the code site, so reviewers don't re-file) and
 * promotions.  It rewrites `tickets/.garden-report.md` for the human every
 * pass.  Agent rules live in agent-rules/garden.md.
 *
 * Usage:
 *   node tess/scripts/garden.mjs [options] [feedback text...]
 *
 * See `--help` for options.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { discoverTickets, parseSlug } from './lib/tickets.mjs';
import { ensureLogsDir, logPath } from './lib/logging.mjs';
import { runAgent } from './lib/process.mjs';
import { commitAll, getTessVersion } from './lib/git.mjs';
import { filterStageBlocks, searchDirective } from './lib/prompt.mjs';
import { detectSearch } from './lib/detect-search.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESS_ROOT = join(__dirname, '..');

function printHelp() {
	console.log([
		'Backlog Gardener — consolidate, triage, and rank tickets/backlog/ via one agent pass',
		'',
		'Without feedback the gardener only consolidates (merge duplicates, cluster class',
		'instances into theme tickets), backfills severity/likelihood/tradeoffs headers, ranks',
		'the queue, and rewrites tickets/.garden-report.md.  Declining or promoting tickets',
		'requires explicit human feedback; declines are recorded as accepted-tradeoff NOTE:',
		'comments at the code site so future reviewers do not re-file the finding.',
		'',
		'Usage: node tess/scripts/garden.mjs [options] [feedback text...]',
		'',
		'Options:',
		'  --feedback <file>    Human feedback file (decisions to execute: declines, promotes)',
		'  --agent <name>       claude | auggie | cursor | codex      (default: claude)',
		'  --difficulty <d>     easy | medium | hard — model tier      (default: hard)',
		'  --token-budget <n>   Soft context budget (claude only)      (default: unset)',
		'  --no-commit          Skip the automatic git commit',
		'  --dry-run            Print the backlog inventory without invoking the agent',
		'  --help               Show this help',
		'',
		'Bare arguments are joined into an inline feedback message (combined with',
		'--feedback file content when both are given).',
	].join('\n'));
}

function parseArgs(argv) {
	const opts = {
		agent: 'claude',
		difficulty: 'hard',
		tokenBudget: Infinity,
		feedbackFile: null,
		feedbackText: [],
		dryRun: false,
		noCommit: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--feedback':
				opts.feedbackFile = argv[++i];
				break;
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--difficulty':
				opts.difficulty = argv[++i];
				break;
			case '--token-budget':
				opts.tokenBudget = parseInt(argv[++i], 10);
				break;
			case '--no-commit':
				opts.noCommit = true;
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--help':
				printHelp();
				process.exit(0);
			default:
				if (arg.startsWith('--')) {
					console.error(`Unknown option: ${arg} (see --help)`);
					process.exit(1);
				}
				opts.feedbackText.push(arg);
		}
	}
	if (Number.isFinite(opts.tokenBudget) && opts.tokenBudget <= 0) {
		console.error('--token-budget must be a positive integer.');
		process.exit(1);
	}
	return opts;
}

/** First single-line header field match near the top of a ticket file, or null. */
function headerField(content, name) {
	const head = content.slice(0, 4000);
	const m = head.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'));
	return m ? m[1].trim() : null;
}

function truncate(s, n) {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One inventory entry: filename, description, and triage-header presence. */
function inventoryLine(ticket, content) {
	const desc = truncate(headerField(content, 'description') ?? '(no description: header)', 200);
	const triage = [];
	if (ticket.slug.startsWith('bug-')) {
		triage.push(`severity: ${headerField(content, 'severity') ?? 'MISSING'}`);
		triage.push(`likelihood: ${headerField(content, 'likelihood') ?? 'MISSING'}`);
	}
	triage.push(`tradeoffs: ${headerField(content, 'tradeoffs') ? 'present' : 'MISSING'}`);
	return `- ${ticket.file} — ${desc}\n  [${triage.join(' | ')}]`;
}

async function buildInventory(tickets) {
	const lines = [];
	for (const t of tickets) {
		let content;
		try {
			content = await readFile(t.path, 'utf-8');
		} catch {
			continue; // raced with a remove/move
		}
		lines.push(inventoryLine(t, content));
	}
	return lines;
}

async function buildGardenPrompt({ inventory, feedback, repoRoot }) {
	const [gardenRules, sharedRules, searchServer] = await Promise.all([
		readFile(join(TESS_ROOT, 'agent-rules', 'garden.md'), 'utf-8'),
		readFile(join(TESS_ROOT, 'agent-rules', 'tickets.md'), 'utf-8'),
		detectSearch(repoRoot),
	]);

	const sections = [
		`# Backlog gardening pass — ${inventory.length} ticket(s) in tickets/backlog/`,
		'',
		'## Gardening rules:',
		'',
		gardenRules,
		'',
		'## Shared workflow conventions (stage-specific blocks removed):',
		'',
		filterStageBlocks(sharedRules, null),
		'',
		'## Backlog inventory (headers only — read the full files you act on):',
		'',
		...inventory,
		'',
		'## Human feedback:',
		'',
		feedback ?? 'None provided this pass — consolidate, backfill, and rank only. Do NOT decline or promote any ticket.',
		'',
		'## End',
	];

	if (searchServer) {
		sections.push(searchDirective(searchServer));
	}

	sections.push(
		'Work the gardening pass as described above.',
		'Do NOT commit — the runner handles the commit after you complete.',
	);

	return sections.join('\n');
}

/** Slugs currently in backlog/ (post-run re-scan; sequence prefixes ignored). */
async function backlogSlugs(ticketsDir) {
	let entries;
	try {
		entries = await readdir(join(ticketsDir, 'backlog'));
	} catch {
		return new Set();
	}
	return new Set(entries.filter(f => f.endsWith('.md')).map(parseSlug));
}

/** Count modified (not added/deleted) tracked files under tickets/backlog/. */
function countBacklogUpdates(repoRoot) {
	try {
		const status = execSync('git status --porcelain -- tickets/backlog', { cwd: repoRoot, encoding: 'utf-8' });
		return status.split('\n').filter(line => /^ ?M/.test(line)).length;
	} catch {
		return 0;
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const repoRoot = process.cwd();
	const ticketsDir = join(repoRoot, 'tickets');
	const tessVersion = getTessVersion(TESS_ROOT);

	const tickets = await discoverTickets(ticketsDir, 'backlog', Infinity);
	if (tickets.length === 0) {
		console.log('Backlog is empty — nothing to garden.');
		return;
	}

	let feedback = null;
	if (opts.feedbackFile) {
		feedback = await readFile(opts.feedbackFile, 'utf-8');
	}
	if (opts.feedbackText.length > 0) {
		feedback = (feedback ? `${feedback}\n\n` : '') + opts.feedbackText.join(' ');
	}

	const inventory = await buildInventory(tickets);

	if (opts.dryRun) {
		console.log(`\ntess (${tessVersion}) — garden dry run`);
		console.log(`Backlog: ${inventory.length} ticket(s)\n`);
		for (const line of inventory) console.log(line);
		console.log(`\nFeedback: ${feedback ? `${feedback.length} chars — declines/promotions enabled` : 'none — consolidate/backfill/rank only'}`);
		return;
	}

	const banner = [
		`${'═'.repeat(72)}`,
		`  tess garden (${tessVersion})`,
		`  Backlog: ${inventory.length} ticket(s)  |  Agent: ${opts.agent}  |  Difficulty: ${opts.difficulty}`,
		`  Feedback: ${feedback ? 'provided — declines/promotions enabled' : 'none — consolidate/backfill/rank only'}`,
		`${'═'.repeat(72)}`,
	].join('\n');
	console.log(banner);

	const logsDir = await ensureLogsDir(ticketsDir);
	const logFile = logPath(logsDir, { file: 'backlog.md', stage: 'garden' });
	await writeFile(logFile, [
		`Garden pass over tickets/backlog/ (${inventory.length} tickets)`,
		`Agent: ${opts.agent}`,
		`Tess: ${tessVersion}`,
		`Started: ${new Date().toISOString()}`,
		'═'.repeat(72),
		'',
	].join('\n'));
	console.log(`  Log: ${logFile}\n`);

	const beforeSlugs = new Set(tickets.map(t => t.slug));
	const prompt = await buildGardenPrompt({ inventory, feedback, repoRoot });
	const result = await runAgent(opts.agent, prompt, repoRoot, logFile, {
		stage: 'garden',
		tokenBudget: opts.tokenBudget,
		difficulty: opts.difficulty,
	});

	if (result.exitCode !== 0) {
		console.error(`\nGardener ${result.timedOut ? 'timed out' : `exited with code ${result.exitCode}`}.`);
		console.error(`Log: ${logFile}`);
		console.error('Nothing was committed — inspect `git status` and re-run.');
		process.exit(result.exitCode || 1);
	}

	// Slug-level diff (rename-tolerant: re-sequencing a ticket isn't a remove+add).
	const afterSlugs = await backlogSlugs(ticketsDir);
	const removed = [...beforeSlugs].filter(s => !afterSlugs.has(s)).length;
	const added = [...afterSlugs].filter(s => !beforeSlugs.has(s)).length;
	const updated = countBacklogUpdates(repoRoot);

	if (!opts.noCommit) {
		const msg = `tess: garden backlog (${removed} removed, ${added} added, ${updated} updated)`;
		if (commitAll(repoRoot, msg, { context: 'garden pass' })) {
			console.log(`\n  Committed: ${msg}`);
		}
	}

	console.log(`\nDone. Backlog: ${beforeSlugs.size} → ${afterSlugs.size} ticket(s). Report: tickets/.garden-report.md`);
}

main().catch((err) => {
	console.error('Gardener failed:', err);
	process.exit(1);
});
