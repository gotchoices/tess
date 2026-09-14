#!/usr/bin/env node
/**
 * Backlog Gardener — one dedicated agent pass over tickets/backlog/.
 *
 * Every processing stage generates backlog tickets, but the backlog drains
 * only through a human.  The gardener turns a flat, ever-growing queue into
 * fewer, better-ranked decisions: it backfills triage headers
 * (severity/likelihood/tradeoffs) and specification anchors, merges
 * duplicates, clusters instances of one underlying weakness into theme
 * tickets, ranks the queue (release first, then severity), proposes declining
 * top-level tickets that have waited too long, and — only on explicit human
 * feedback — executes declines (recorded as accepted-tradeoff `NOTE:`
 * comments at the code site, so reviewers don't re-file), promotions,
 * deferrals to a later release and pull-forwards.  It rewrites
 * `tickets/.garden-report.md` for the human every pass.  Agent rules live in
 * agent-rules/garden.md; the prompt is built by lib/prompt.mjs
 * `buildGardenPrompt`.
 *
 * Usage:
 *   node tess/scripts/garden.mjs [options] [feedback text...]
 *
 * See `--help` for options.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { discoverTickets, indexAllTickets, parseSlug, readBacklogLayout } from './lib/tickets.mjs';
import { ensureLogsDir, logPath } from './lib/logging.mjs';
import { runAgent } from './lib/process.mjs';
import { commitAll, getTessVersion, reconcileWorkingTree } from './lib/git.mjs';
import { readInProgress } from './lib/state.mjs';
import { buildGardenPrompt } from './lib/prompt.mjs';
import { checkBoard, readBoardContext } from './lib/board-check.mjs';
import { DEFAULT_DECLINE_AFTER_DAYS, topLevelArrivals } from './lib/backlog-age.mjs';
import { boardCheckLines, buildInventory, inventoryText, releaseSummary } from './lib/garden-inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESS_ROOT = join(__dirname, '..');

function printHelp() {
	console.log([
		'Backlog Gardener — consolidate, triage, and rank tickets/backlog/ via one agent pass',
		'',
		'Without feedback the gardener only consolidates (merge duplicates, cluster class',
		'instances into theme tickets), backfills severity/likelihood/tradeoffs headers and',
		'specification anchors, ranks the queue (current release first), proposes declining',
		'top-level tickets that have waited --decline-after-days, and rewrites',
		'tickets/.garden-report.md.  Declining, promoting, deferring a ticket to a later',
		'release, or pulling a deferred ticket forward requires explicit human feedback;',
		'declines are recorded as accepted-tradeoff NOTE: comments at the code site so',
		'future reviewers do not re-file the finding.',
		'',
		'Usage: node tess/scripts/garden.mjs [options] [feedback text...]',
		'',
		'Options:',
		'  --feedback <file>         Human feedback file (decisions to execute: declines, promotes, defers)',
		'  --agent <name>            claude | auggie | cursor | codex      (default: claude)',
		'  --difficulty <d>          easy | medium | hard — model tier      (default: hard)',
		`  --decline-after-days <n>  Propose declining top-level tickets that have waited n days (default: ${DEFAULT_DECLINE_AFTER_DAYS})`,
		'  --token-budget <n>        Soft context budget (claude only)      (default: unset)',
		'  --no-commit               Skip the automatic git commit',
		'  --dry-run                 Print the grouped inventory and board check without invoking the agent',
		'  --help                    Show this help',
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
		declineAfterDays: DEFAULT_DECLINE_AFTER_DAYS,
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
			case '--decline-after-days': {
				const value = argv[++i];
				if (!/^\d+(?:\.\d+)?$/.test(value ?? '')) {
					console.error('--decline-after-days must be a non-negative number of days.');
					process.exit(1);
				}
				opts.declineAfterDays = Number(value);
				break;
			}
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

/**
 * Slugs now in backlog/ and its sub-folders (post-run re-scan; sequence
 * prefixes ignored), so neither a re-sequence nor a move between the top level
 * and a folder counts as a removal plus an addition.
 */
async function backlogSlugs(ticketsDir) {
	const { top, folders } = await readBacklogLayout(ticketsDir);
	return new Set([...top, ...folders.flatMap(folder => folder.files)].map(parseSlug));
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

	// Garden never writes an `.in-progress` marker of its own, but it reads the one the runner
	// leaves behind: residue found here most plausibly belongs to whatever ticket was interrupted,
	// and salvaging it under "no ticket in progress" would state something untrue.  Read
	// non-destructively — clearing the marker stays the runner's job.  `salvage` is hard-coded
	// (not a `--dirty-tree` flag like the runner's) because garden is a single human-invoked,
	// single-shot pass: the operator is at the keyboard and sees the dirty-tree notice either way.
	const interrupted = await readInProgress(ticketsDir);
	const reconciled = reconcileWorkingTree(repoRoot, {
		owner: interrupted ? { stage: interrupted.stage, slug: interrupted.slug } : null,
		mode: 'salvage',
		noCommit: opts.noCommit,
		dryRun: opts.dryRun,
		label: 'the garden pass',
	});
	if (reconciled.action === 'abort') {
		console.error('\nWorking tree could not be salvaged — halting before the garden pass.');
		process.exit(1);
	}

	const tessVersion = getTessVersion(TESS_ROOT);

	const tickets = await discoverTickets(ticketsDir, 'backlog', Infinity, { includeFolders: true });
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

	// The runner exits on board errors; the gardener passes them on instead.  It works no ticket,
	// so an inconsistent board cannot mis-order work here, and fixing folders is a human's call the
	// report should surface rather than a reason to skip the pass.
	const context = await readBoardContext(ticketsDir);
	const board = await checkBoard(ticketsDir, context, await indexAllTickets(ticketsDir, { withPrereqs: true }));
	const inventory = buildInventory(tickets, {
		releases: context.releases,
		anchorFields: context.anchorFields,
		arrivals: topLevelArrivals(repoRoot, 'tickets', { warn: message => console.warn(`[garden] warning: ${message}`) }),
		nowSeconds: Math.floor(Date.now() / 1000),
		declineAfterDays: opts.declineAfterDays,
	});
	const { top, folders, proposed } = inventory.counts;
	const boardLines = boardCheckLines(board);
	const summary = {
		backlog: `${tickets.length} ticket(s) — ${top} at the top level, ${folders} in sub-folders`,
		aging: `propose declining after ${opts.declineAfterDays} days at the top level — ${proposed} proposed`,
		board: boardLines.length === 0
			? 'clean'
			: `${board.errors.length} error(s), ${board.warnings.length} warning(s) — passed to the gardener to report`,
		feedback: feedback ? 'provided — declines/promotions/deferrals enabled' : 'none — consolidate/backfill/rank/propose only',
	};

	if (opts.dryRun) {
		console.log(`\ntess (${tessVersion}) — garden dry run`);
		console.log(`Backlog: ${summary.backlog}`);
		console.log(releaseSummary(context.releases));
		console.log(`Aging: ${summary.aging}\n`);
		for (const line of inventoryText(inventory.groups)) console.log(line);
		console.log(`Board check: ${summary.board}`);
		for (const line of boardLines) console.log(`  ${line}`);
		console.log(`\nFeedback: ${feedback ? `${feedback.length} chars, ${summary.feedback}` : summary.feedback}`);
		return;
	}

	const banner = [
		`${'═'.repeat(72)}`,
		`  tess garden (${tessVersion})`,
		`  Backlog: ${summary.backlog}`,
		`  Agent: ${opts.agent}  |  Difficulty: ${opts.difficulty}`,
		`  Aging: ${summary.aging}`,
		`  Board check: ${summary.board}`,
		`  Feedback: ${summary.feedback}`,
		`${'═'.repeat(72)}`,
	].join('\n');
	console.log(banner);
	for (const line of boardLines) console.log(`  ${line}`);

	const logsDir = await ensureLogsDir(ticketsDir);
	const logFile = logPath(logsDir, { file: 'backlog.md', stage: 'garden' });
	await writeFile(logFile, [
		`Garden pass over tickets/backlog/ (${tickets.length} tickets)`,
		`Agent: ${opts.agent}`,
		`Tess: ${tessVersion}`,
		`Started: ${new Date().toISOString()}`,
		'═'.repeat(72),
		'',
	].join('\n'));
	console.log(`  Log: ${logFile}\n`);

	const beforeSlugs = new Set(tickets.map(t => t.slug));
	const prompt = await buildGardenPrompt(TESS_ROOT, repoRoot, {
		inventory,
		releases: context.releases,
		rules: context.rules.rules,
		board,
		declineAfterDays: opts.declineAfterDays,
		feedback,
	});
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

	// Slug-level diff (rename-tolerant: re-sequencing a ticket or moving it between folders isn't a remove+add).
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
