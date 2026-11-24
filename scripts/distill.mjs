#!/usr/bin/env node
/**
 * Distill pass — one agent run per `tickets/blocked/` ticket that needs its
 * decision brief written or re-checked.
 *
 * `blocked/` is the human's inbox and drains only through a human.  The
 * dashboard's Decisions page shows each ticket as a card built from the brief
 * in its header (lib/brief.mjs), and the card is only as good as that brief.
 * This pass keeps the briefs true: for each due ticket an agent checks the
 * ticket's premise against the current tree, writes or corrects the brief,
 * answers a question the human sent back (`ask:`), and folds together tickets
 * one answer would settle.  It never answers a ticket, moves one out of
 * `blocked/`, or touches anything outside it.  Agent rules live in
 * agent-rules/distill.md; the prompt is built by lib/prompt.mjs
 * `buildDistillPrompt`.
 *
 * A ticket is due when its brief is missing or incomplete, when it carries an
 * `ask:`, or when a file it names has a commit after its `checked:` date
 * (lib/inbox.mjs `distillReasons`).  A ticket a human has already answered is
 * never due.  One agent per ticket, not one for the stage: each has to read
 * the code behind its own question, and a ticket's commit then says which
 * ticket it was.
 *
 * Each ticket's commit takes only `tickets/blocked/`, so the pass can be
 * started — from a terminal or from the dashboard's Distill button — over a
 * tree with other uncommitted work in it, which it leaves alone.  It refuses
 * to start while the runner is working a ticket in the same checkout, and it
 * stops between tickets when asked through its own stop file (lib/inbox.mjs
 * `requestDistillStop`), never the runner's `tickets/.stop`.
 *
 * Usage:
 *   node tess/scripts/distill.mjs [options]
 *
 * See `--help` for options.
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { commitPaths, dueForDistill, readInbox, takeDistillStop, today } from './lib/inbox.mjs';
import { stripSlugDecoration } from './lib/tickets.mjs';
import { ensureLogsDir, logPath } from './lib/logging.mjs';
import { runAgent } from './lib/process.mjs';
import { getTessVersion } from './lib/git.mjs';
import { readInProgress } from './lib/state.mjs';
import { buildDistillPrompt } from './lib/prompt.mjs';
import { readBoardContext } from './lib/board-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESS_ROOT = join(__dirname, '..');

function printHelp() {
	console.log([
		'Distill pass — write and re-check the decision brief of each tickets/blocked/ ticket',
		'',
		'A blocked ticket is due when its brief is missing or incomplete, when a human sent a',
		'question back (ask:), or when a file it names changed after its checked: date.  For',
		'each due ticket one agent checks the premise against the current tree and writes the',
		'header fields the dashboard\'s Decisions page renders as a card.  It never answers,',
		'moves or closes a ticket, and never touches a ticket a human has already answered.',
		'',
		'Usage: node tess/scripts/distill.mjs [options]',
		'',
		'Options:',
		'  --only <slugs>       Comma-separated ticket slugs; work only these (due or not)',
		'  --all                Re-check every unanswered ticket, not only the due ones',
		'  --max <n>            Stop after n tickets                    (default: unlimited)',
		'  --agent <name>       claude | auggie | cursor | codex        (default: claude)',
		'  --difficulty <d>     easy | medium | hard — model tier for a ticket that names',
		'                       none                                    (default: medium)',
		'  --token-budget <n>   Soft per-ticket context budget (claude only)',
		'  --no-commit          Skip the automatic git commit after each ticket',
		'  --ignore-runner      Start even though tickets/.in-progress says the runner is',
		'                       working a ticket in this checkout (for a marker left by a',
		'                       run that died)',
		'  --dry-run            List the due tickets and why, without invoking the agent',
		'  --help               Show this help',
	].join('\n'));
}

function parseArgs(argv) {
	const opts = {
		only: null,
		all: false,
		max: Infinity,
		agent: 'claude',
		difficulty: 'medium',
		tokenBudget: Infinity,
		noCommit: false,
		ignoreRunner: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--only': {
				const slugs = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean).map(stripSlugDecoration);
				if (slugs.length === 0) {
					console.error('--only requires at least one slug.');
					process.exit(1);
				}
				opts.only = new Set(slugs);
				break;
			}
			case '--all':
				opts.all = true;
				break;
			case '--max':
				opts.max = parseInt(argv[++i], 10);
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
			case '--ignore-runner':
				opts.ignoreRunner = true;
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--help':
				printHelp();
				process.exit(0);
			default:
				console.error(`Unknown option: ${arg} (see --help)`);
				process.exit(1);
		}
	}
	if (!(opts.max > 0)) {
		console.error('--max must be a positive integer.');
		process.exit(1);
	}
	if (Number.isFinite(opts.tokenBudget) && opts.tokenBudget <= 0) {
		console.error('--token-budget must be a positive integer.');
		process.exit(1);
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const repoRoot = process.cwd();
	const ticketsDir = join(repoRoot, 'tickets');
	const blockedDir = join(ticketsDir, 'blocked');

	// This pass commits only `tickets/blocked/` — the one folder its agents may touch — so it needs
	// no clean tree and leaves whatever else is uncommitted alone.  What it cannot survive is a
	// runner working a ticket in this checkout: the runner's commit stages the whole tree and would
	// take a half-written brief with it, under that ticket's name.
	const running = opts.dryRun || opts.ignoreRunner ? null : await readInProgress(ticketsDir);
	if (running) {
		console.error(`\n[distill] Refusing to start: the runner is working ${running.stage}/${running.slug} in this checkout, and its commit would sweep up a half-written brief.`);
		console.error('[distill] Run the pass when the runner is idle, or from another checkout.  If tickets/.in-progress is left over from a run that died, pass --ignore-runner.');
		process.exit(2);
	}
	await takeDistillStop(ticketsDir);  // a stop asked of an earlier pass is not this one's

	const tessVersion = getTessVersion(TESS_ROOT);
	const inbox = await readInbox(ticketsDir);
	if (inbox.length === 0) {
		console.log('blocked/ is empty — nothing to distill.');
		return;
	}
	if (opts.only) {
		const present = new Set(inbox.map(entry => entry.slug));
		for (const slug of opts.only) {
			if (!present.has(slug)) console.warn(`[distill] warning: --only named "${slug}" but it is not in blocked/.`);
		}
	}

	const due = await dueForDistill(ticketsDir, { only: opts.only, all: opts.all, inbox });
	const decided = inbox.filter(entry => entry.brief.decision).length;
	const limited = due.slice(0, opts.max);
	// Answering on the dashboard moves a ticket out of blocked/, so one still here with `decision:`
	// was answered by hand in an editor and is waiting for its author to move it.
	const summary = `${inbox.length} ticket(s) in blocked/ — ${due.length} due, ${decided} answered by hand and not yet moved, ${inbox.length - due.length - decided} current`;

	if (opts.dryRun) {
		console.log(`\ntess (${tessVersion}) — distill dry run`);
		console.log(`${summary}\n`);
		for (const { entry, reasons } of limited) {
			console.log(`  ${entry.file}  (${entry.waiting.length} waiting, ${entry.ageDays == null ? 'new' : `${entry.ageDays}d`})`);
			for (const reason of reasons) console.log(`      - ${reason}`);
		}
		const limitNote = due.length > limited.length ? ` (limited to ${limited.length} of ${due.length})` : '';
		console.log(`\n${limited.length} ticket(s) would be distilled${limitNote}.`);
		return;
	}

	if (limited.length === 0) {
		console.log(`${summary}. Nothing to distill.`);
		return;
	}

	console.log([
		`${'═'.repeat(72)}`,
		`  tess distill (${tessVersion})`,
		`  ${summary}`,
		`  Agent: ${opts.agent}  |  Working ${limited.length} ticket(s)`,
		`${'═'.repeat(72)}`,
	].join('\n'));

	const logsDir = await ensureLogsDir(ticketsDir);
	const { rules } = (await readBoardContext(ticketsDir)).rules;
	const date = today();
	const errors = [];
	let done = 0;

	for (const [i, { entry, reasons, difficulty }] of limited.entries()) {
		const label = `[distill ${i + 1}/${limited.length}]`;
		if (await takeDistillStop(ticketsDir)) {
			console.log('\n⏹  Stop requested — halting before next ticket.');
			break;
		}
		// An earlier ticket this pass may have absorbed this one (a merge), or a human may have
		// answered it meanwhile: re-read the inbox rather than trust the list taken at the start.
		const current = await readInbox(ticketsDir);
		const now = current.find(e => e.slug === entry.slug);
		if (!now) {
			console.log(`\n  ${label} Skipped (no longer in blocked/): ${entry.file}`);
			continue;
		}
		if (now.brief.decision) {
			console.log(`\n  ${label} Skipped (answered meanwhile): ${now.file}`);
			continue;
		}

		const logFile = logPath(logsDir, { file: now.file, stage: 'distill' });
		console.log([
			`${'─'.repeat(72)}`,
			`  ${label} ${now.file}`,
			...reasons.map(reason => `  Due: ${reason}`),
			`  Log: ${logFile}`,
			`${'─'.repeat(72)}`,
		].join('\n'));
		await writeFile(logFile, [
			`Distill: ${now.file}`,
			`Agent: ${opts.agent}`,
			`Tess: ${tessVersion}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildDistillPrompt(TESS_ROOT, repoRoot, {
			entry: now,
			reasons,
			others: current.filter(e => e.slug !== now.slug),
			rules,
			date,
		});
		const result = await runAgent(opts.agent, prompt, repoRoot, logFile, {
			stage: 'distill',
			tokenBudget: opts.tokenBudget,
			difficulty: difficulty ?? opts.difficulty,
		});

		const failed = result.exitCode !== 0;
		if (failed) {
			console.error(`\n  ${label} Agent ${result.timedOut ? 'timed out' : `exited with code ${result.exitCode}`} on ${now.file}. Log: ${logFile}`);
			errors.push({ slug: now.slug, exitCode: result.exitCode || 1 });
		} else {
			done++;
		}
		// Committed either way, and only `tickets/blocked/`.  A failed agent's partial edits are
		// committed under a subject that says so: left in the tree, they would be swept into the next
		// ticket's distill commit, or a runner's, under a name that hides what they are.
		if (!opts.noCommit) {
			const subject = failed ? `tess: distill ${now.slug} (partial — the agent did not finish)` : `tess: distill ${now.slug}`;
			const committed = commitPaths(repoRoot, [blockedDir], subject);
			if (committed.committed) console.log(`  Committed: ${subject}`);
			else if (committed.error) console.error(`  Commit failed: ${committed.error}`);
		}
	}

	await takeDistillStop(ticketsDir);  // one asked for during the last ticket had nothing left to stop

	const after = await readInbox(ticketsDir);
	const lanes = {};
	for (const entry of after) lanes[entry.lane] = (lanes[entry.lane] ?? 0) + 1;
	console.log(`\nDistilled ${done} ticket(s). Inbox now: ${Object.entries(lanes).map(([lane, n]) => `${n} ${lane}`).join(', ')}.`);
	if (errors.length > 0) {
		console.error(`${errors.length} ticket(s) failed:`);
		for (const e of errors) console.error(`  - ${e.slug} (exit ${e.exitCode})`);
		process.exit(errors[0].exitCode);
	}
}

main().catch((err) => {
	console.error('Distill pass failed:', err);
	process.exit(1);
});
