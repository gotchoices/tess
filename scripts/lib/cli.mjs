/**
 * Command-line argument parsing and help output.
 */

import { KNOWN_STAGES, PENDING_STAGES } from './tickets.mjs';
import { KNOWN_STRATEGIES } from './strategies/index.mjs';

export function printHelp() {
	const lines = [
		'Ticket Runner — process outstanding tickets via agentic CLI',
		'',
		'The ticket list is snapshotted once at startup — tickets created by the agent',
		'during this run are NOT picked up until the next run.  This ensures each',
		'ticket advances exactly one stage per run.',
		'',
		'Numeric filename prefix encodes sequence (lower runs sooner); prefix is optional.',
		'Unnumbered tickets run after all numbered ones in a stage.  Tickets may declare',
		'`prereq: <slug>, <slug>` in the header — prereqs run before dependents, and a',
		'sequence number that conflicts with a prereq edge is a hard error.',
		'',
		'Usage: node tess/scripts/run.mjs [options]',
		'',
		'Options:',
		'  --max-sequence <n>   Default max sequence for all stages  (default: unlimited)',
		'                       Tickets with sequence > n are skipped; unnumbered tickets',
		'                       are skipped whenever n is finite.',
		'  --stages <list>      Comma-separated stages, optionally with per-stage max sequence',
		'                       as  stage:n  (default: fix,plan,implement,review)',
		'                       e.g.  --stages review:5,implement:3,fix',
		'                             --stages backlog:2  (backlog is not in the default set)',
		'  --agent <name>       claude | auggie | cursor | codex      (default: claude)',
		'  --strategy <name>    batch | chase                          (default: batch)',
		'                       batch: drain each stage before moving to the next.',
		'                       chase: take one root ticket and follow it through every',
		'                              stage to complete/ before moving to the next root.',
		'                              A ticket landing in blocked/ or backlog/ is deferred',
		'                              and any queued ticket listing it as `prereq:` is',
		'                              skipped for the rest of the run.',
		'  --max <n>            Stop after at most n tickets          (default: unlimited)',
		'  --no-commit          Skip automatic git commit after each ticket',
		'  --dry-run            List tickets without invoking agent',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

/**
 * Parse --stages value into an ordered array of { stage, maxSequence } entries.
 * Bare stage names use the global defaultMax.
 */
export function parseStages(raw, defaultMax) {
	return raw.split(',').map(token => {
		const [stage, pStr] = token.trim().split(':');
		const maxSequence = pStr !== undefined ? parseFloat(pStr) : defaultMax;
		return { stage, maxSequence };
	});
}

export function parseArgs(argv) {
	const opts = {
		maxSequence: Infinity,
		agent: 'claude',
		strategy: 'batch',
		dryRun: false,
		noCommit: false,
		maxTickets: Infinity,
		stagesRaw: null,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--max-sequence':
				opts.maxSequence = parseFloat(argv[++i]);
				break;
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--strategy':
				opts.strategy = argv[++i];
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--no-commit':
				opts.noCommit = true;
				break;
			case '--max':
				opts.maxTickets = parseInt(argv[++i], 10);
				break;
			case '--stages':
				opts.stagesRaw = argv[++i];
				break;
			case '--help':
				printHelp();
				process.exit(0);
		}
	}

	const stagesRaw = opts.stagesRaw ?? PENDING_STAGES.join(',');
	const stages = parseStages(stagesRaw, opts.maxSequence);

	for (const { stage } of stages) {
		if (!KNOWN_STAGES.includes(stage)) {
			console.error(`Unknown stage: "${stage}". Valid stages: ${KNOWN_STAGES.join(', ')}`);
			process.exit(1);
		}
	}

	if (!KNOWN_STRATEGIES.includes(opts.strategy)) {
		console.error(`Unknown strategy: "${opts.strategy}". Valid strategies: ${KNOWN_STRATEGIES.join(', ')}`);
		process.exit(1);
	}

	return { ...opts, stages };
}

export function formatStageSummary(stages) {
	return stages.map(({ stage, maxSequence }) =>
		Number.isFinite(maxSequence) ? `${stage}(<=${maxSequence})` : stage
	).join(', ');
}
