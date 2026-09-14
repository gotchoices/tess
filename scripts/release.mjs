#!/usr/bin/env node
/**
 * Release commands for a board with a `tickets/releases.md`.
 *
 * One command today, `ship`: make the next release current.  The rules live in
 * lib/ship.mjs; this file parses arguments, prints the plan, and sets the exit
 * status.  Run from the project root, like run.mjs.
 *
 * Usage:
 *   node tess/scripts/release.mjs ship [--dry-run] [--no-commit]
 *
 * See `--help` for details.
 */

import { join } from 'node:path';

import { applyShip, planShip, reconcileForShip, shipCommitMessage } from './lib/ship.mjs';

const COMMANDS = ['ship'];
const USAGE = 'Usage: node tess/scripts/release.mjs ship [--dry-run] [--no-commit]';

function printHelp() {
	console.log([
		'Release commands — change which release in tickets/releases.md is current',
		'',
		USAGE,
		'',
		'ship  Ship the current (first) release: move the tickets in backlog/<NEXT>/ up to',
		'      backlog/, remove every ticket header line `target: <SHIPPED>` outside',
		'      complete/, remove the first entry from tickets/releases.md, and commit as',
		'      "tess: ship release <SHIPPED>".  Any problem found while planning, or a',
		'      dirty working tree, stops it before anything changes.',
		'',
		'Options:',
		'  --dry-run    Print what shipping would do; change nothing',
		'  --no-commit  Skip the clean-tree check and the commit; leave the result for you to commit',
		'  --help       Show this help',
	].join('\n'));
}

function usageError(message) {
	console.error(`${message}\n${USAGE}  (see --help)`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { command: null, dryRun: false, noCommit: false };
	for (const arg of argv) {
		switch (arg) {
			case '--help':
				printHelp();
				process.exit(0);
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--no-commit':
				opts.noCommit = true;
				break;
			default:
				if (arg.startsWith('-')) usageError(`Unknown option: ${arg}`);
				if (opts.command) usageError(`Unexpected argument: ${arg}`);
				if (!COMMANDS.includes(arg)) usageError(`Unknown command: ${arg}`);
				opts.command = arg;
		}
	}
	if (!opts.command) usageError('No command given.');
	return opts;
}

const ticketCount = n => `${n} ticket${n === 1 ? '' : 's'}`;
const strippedCount = plan => new Set(plan.strips.map(strip => strip.path)).size;

function printPlan(plan) {
	if (plan.shipped) {
		console.log(`Ship release ${plan.shipped}: ${plan.next ? `${plan.next} becomes the current release.` : 'no releases remain after it.'}`);
	}
	if (plan.moves.length > 0) {
		console.log(`\nMove ${ticketCount(plan.moves.length)} up to backlog/:`);
		for (const { from, to } of plan.moves) console.log(`  ${from} → ${to}`);
	}
	if (plan.removeFolder) console.log(`\nRemove the emptied ${plan.removeFolder}/`);
	if (plan.strips.length > 0) {
		console.log(`\nRemove target: ${plan.shipped} from ${ticketCount(strippedCount(plan))}:`);
		for (const { path, line } of plan.strips) console.log(`  ${path}:${line}`);
	}
	if (plan.shipped && plan.moves.length === 0 && plan.strips.length === 0 && !plan.removeFolder) {
		console.log('\nNo tickets to move or strip.');
	}
	if (plan.errors.length > 0) {
		console.error(`\nCannot ship — fix ${plan.errors.length === 1 ? 'this' : 'these'} first; nothing was changed:`);
		for (const error of plan.errors) console.error(`  - ${error}`);
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const repoRoot = process.cwd();
	const plan = await planShip(join(repoRoot, 'tickets'));

	printPlan(plan);
	if (plan.errors.length > 0) process.exit(1);
	if (opts.dryRun) {
		if (!opts.noCommit) reconcileForShip(repoRoot, { dryRun: true });
		console.log('\nDry run — nothing changed.');
		return;
	}

	const result = await applyShip(plan, { repoRoot, noCommit: opts.noCommit });
	if (!result.applied) {
		console.error(`\nRelease ${plan.shipped} not shipped — nothing was changed.`);
		process.exit(1);
	}

	console.log(`\nShipped release ${plan.shipped}.`);
	console.log(plan.next ? `Current release: ${plan.next}.` : 'No releases remain — every ticket is current.');
	console.log(`Moved ${ticketCount(plan.moves.length)}; removed target: ${plan.shipped} from ${ticketCount(strippedCount(plan))}.`);
	if (opts.noCommit) console.log('Not committed (--no-commit).');
	else if (result.committed) console.log(`Committed: ${shipCommitMessage(plan.shipped)}`);
	console.log(`Tools that tag other files with release codes should strip ${plan.shipped} now.`);

	if (!opts.noCommit && !result.committed) {
		console.error('\nThe ship was applied, but the commit failed (see above) — inspect `git status` and commit it by hand.');
		if (plan.next) console.error(`Do not run ship again to finish it: the list now starts at ${plan.next}, so that would ship ${plan.next} too.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Release command failed:', err);
	process.exit(1);
});
