/**
 * Chase strategy — picks one ticket and follows it through every pipeline
 * stage in a single run, then moves to the next root ticket.  Where batch
 * is stage-major (drain plan/, then implement/, then review/), chase is
 * ticket-major (take a plan ticket all the way to complete/).
 *
 * Successor lookup is by slug, not by filesystem diff.  After each stage
 * transition, we look for the same slug in NEXT_STAGE first, then in
 * blocked/ and backlog/.  This is robust against other agents touching
 * tickets/ in parallel — we don't try to attribute every new file to the
 * agent we just ran.
 *
 * Deferral cascade: a slug enters `deferred` when (a) the agent moved it
 * to blocked/ or backlog/ during the chain, or (b) the cross-stage prereq
 * gate in `runOneStage` rejected it because a prereq is still behind.
 * Subsequent root tickets that list a deferred slug as a prereq are
 * skipped — and they themselves are added to `deferred`, so the skip
 * cascades transitively through the queue.
 *
 * A safety cap (MAX_CHAIN_STEPS) bounds how many stage transitions a
 * single chase can perform, in case an agent regresses a ticket
 * (e.g. implement → plan) and creates a loop.  The natural pipeline
 * tops out at 4 steps (backlog → plan → implement → review → complete).
 */

import { runOneStage } from '../run-ticket.mjs';
import { NEXT_STAGE, findTicketBySlug } from '../tickets.mjs';

const MAX_CHAIN_STEPS = 6;

export async function run(ctx) {
	const { snapshot, ticketsDir } = ctx;

	const processed = new Set();   // slugs we've already chased (or skipped) as a root
	const deferred = new Set();    // slugs that hit blocked/backlog this run

	rootLoop: for (let i = 0; i < snapshot.length; i++) {
		const root = snapshot[i];
		const rootLabel = `[root ${i + 1}/${snapshot.length}]`;

		if (processed.has(root.slug)) continue;

		const blockingPrereq = root.prereqs.find(p => deferred.has(p));
		if (blockingPrereq) {
			console.log(`\n  ${rootLabel} Skipped ${root.file}: prereq "${blockingPrereq}" is deferred this run.\n`);
			processed.add(root.slug);
			deferred.add(root.slug);  // cascade: anything depending on root is also deferred
			continue;
		}

		processed.add(root.slug);

		let t = root;
		for (let step = 1; step <= MAX_CHAIN_STEPS; step++) {
			if (!NEXT_STAGE[t.stage]) break;  // terminal stage (e.g., complete)

			const stepLabel = `[root ${i + 1}/${snapshot.length} · step ${step}]`;
			const outcome = await runOneStage(t, ctx, { label: stepLabel });

			if (outcome.kind === 'stopped') break rootLoop;
			if (outcome.kind === 'skipped') break;
			if (outcome.kind === 'timed-out') break;
			if (outcome.kind === 'deferred') {
				deferred.add(t.slug);
				break;
			}
			if (outcome.kind === 'agent-error') {
				console.error('Stopping to avoid cascading failures. Re-run to retry.');
				process.exit(outcome.exitCode);
			}

			// Success — find the same slug in the next stage, or in blocked/backlog.
			const nextStage = NEXT_STAGE[t.stage];
			const advanced = await findTicketBySlug(ticketsDir, t.slug, [nextStage]);
			if (advanced) {
				t = advanced;
				continue;
			}

			const parked = await findTicketBySlug(ticketsDir, t.slug, ['blocked', 'backlog']);
			if (parked) {
				deferred.add(t.slug);
				console.log(`  Chase ended: "${t.slug}" landed in ${parked.stage}/. Dependents will be skipped this run.\n`);
				break;
			}

			console.log(`  Chase ended: no successor for "${t.slug}" in ${nextStage}/ (agent may have split or renamed it).\n`);
			break;
		}

		// Pause briefly between roots to mirror batch's between-ticket delay.
		if (i < snapshot.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}
}
