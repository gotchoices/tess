#!/usr/bin/env node
/**
 * CLI for the tombstone backfill (see lib/backfill-tombstones.mjs for the
 * reconstruction itself).  One-shot maintenance: reconstructs tombstones
 * for every ticket pruned before `tickets/.pruned-tickets.jsonl` existed,
 * so `prereq:` slugs naming that older work resolve to "completed, pruned"
 * instead of "unknown".
 *
 * Usage:
 *   node tess/scripts/backfill-tombstones.mjs
 *   node tess/scripts/backfill-tombstones.mjs --dry-run
 *   node tess/scripts/backfill-tombstones.mjs --project /path/to/project
 *
 * Idempotent — re-running adds only what a prior run (live or backfill)
 * hasn't already recorded.
 */

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillTombstones } from './lib/backfill-tombstones.mjs';

function parseArgs(argv) {
	const opts = { projectRoot: process.cwd(), dryRun: false, ref: 'HEAD' };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--project' && argv[i + 1]) {
			opts.projectRoot = resolve(argv[++i]);
		} else if (argv[i] === '--dry-run') {
			opts.dryRun = true;
		} else if (argv[i] === '--ref' && argv[i + 1]) {
			opts.ref = argv[++i];
		} else if (argv[i] === '--help') {
			console.log([
				'Tess tombstone backfill — reconstruct tombstones for tickets pruned',
				'before the ledger existed.',
				'',
				'Usage:',
				'  node tess/scripts/backfill-tombstones.mjs',
				'  node tess/scripts/backfill-tombstones.mjs --dry-run',
				'  node tess/scripts/backfill-tombstones.mjs --project /path/to/project',
				'',
				'Idempotent — re-running adds only what is not already recorded.',
			].join('\n'));
			process.exit(0);
		}
	}
	return opts;
}

async function main() {
	const { projectRoot, dryRun, ref } = parseArgs(process.argv.slice(2));
	const ticketsDir = join(projectRoot, 'tickets');

	try { await access(ticketsDir, constants.F_OK); }
	catch {
		console.error(`No tickets/ directory at ${projectRoot}`);
		process.exit(1);
	}

	console.log(`\nTess tombstone backfill — project: ${projectRoot}${dryRun ? '  (dry-run)' : ''}\n`);

	const { sweeps, added } = await backfillTombstones(ticketsDir, projectRoot, { ref, dryRun });
	console.log(`  Scanned ${sweeps} prune sweep(s) reachable from ${ref}.`);
	console.log(`  ${dryRun ? 'Would append' : 'Appended'} ${added.length} tombstone record(s).`);
	if (added.length > 0) {
		const slugs = added.slice(0, 10).map(r => r.slug);
		console.log(`  ${dryRun ? 'First' : 'Including'}: ${slugs.join(', ')}${added.length > slugs.length ? ', …' : ''}`);
	}

	console.log('\nDone.\n');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
}
