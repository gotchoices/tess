/**
 * Live strategy — re-discovers and re-prioritizes the whole ticket board after
 * every stage transition, instead of draining a snapshot frozen at startup.
 *
 * Where batch and chase traverse a fixed startup snapshot ("capture once, then
 * drain"), live recomputes "what runs next" from disk on every iteration. A
 * ticket created mid-run — a review that files a fix, a plan that splits into
 * implements — is picked up and re-ranked immediately, so the runner always
 * works the current highest-priority ticket given the live state of tickets/.
 *
 * Ordering policy is the same cross-stage priority batch uses: the `--stages`
 * order across stages (default `review,implement,fix,plan` — drive in-flight
 * work toward done before opening new work), and within each stage prereq-topo
 * then sequence. Live just re-evaluates that policy continuously rather than
 * once.
 *
 * Selection (each iteration):
 *   1. Re-discover every processing stage in `--stages` order, topo-sort within
 *      the stage, concatenate preserving cross-stage priority → the live queue.
 *   2. Build one cross-stage index and pick the first queue ticket that is
 *      runnable: not excluded (agent-errored / timed-out / not runnable this
 *      run), not behind a same-stage prereq this pass passed over, under the
 *      per-slug transition cap, not transitively blocked (when --skip-blocked), and with
 *      every prereq satisfied (strictly-later rank, not deferred to a later
 *      release). A ticket whose prereq is merely *behind but still in the
 *      pipeline* is skipped THIS pass only — it becomes selectable once that
 *      prereq advances, which is the whole point of reassessing live.
 *   3. Run it. On success the ticket leaves its stage and its successor re-enters
 *      the board to compete by priority again. When nothing is runnable, the
 *      board is drained or wedged on blocked prereqs — stop.
 *
 * Termination: every agent run either advances a ticket (it leaves its stage),
 * excludes it (error/timeout), or the per-slug cap retires it; prereq-gated
 * tickets only ever run once their gate clears via another ticket's progress.
 * When nothing is runnable, the loop ends. The per-slug cap and a global hard
 * cap backstop a misbehaving agent that regresses tickets in a loop or spawns
 * work without bound.
 *
 * Strategy contract (shared with batch/chase):
 *   await run({ snapshot, ticketsDir, repoRoot, tessRoot, tessVersion,
 *               logsDir, opts }) → { errors: [{ slug, exitCode }, ...] }
 * The `snapshot` is ignored for selection (run.mjs still builds it for the
 * banner, dry-run, startup cycle check, and resume-note placement); live owns
 * discovery from there on.
 */

import { runOneStage } from '../run-ticket.mjs';
import {
	discoverTickets,
	indexAllTickets,
	findUnsatisfiedPrereq,
	findTransitiveBlocker,
	inShard,
	NEXT_STAGE,
} from '../tickets.mjs';
import { topoSortAndCheck } from '../topo.mjs';

// Per-slug transition ceiling. A well-behaved ticket touches each stage once
// (≤4 transitions backlog→complete; budget splits add a few). Past this a slug
// is looping — an agent regressing it (e.g. review → implement) — and we retire
// it for the run. Mirrors the intent of chase's MAX_CHAIN_STEPS.
const MAX_TRANSITIONS_PER_SLUG = 12;

// Absolute backstop on agent runs when --max is unset, so a pathological agent
// that keeps spawning brand-new slugs cannot run unattended forever. Far above
// any real board; the per-slug cap and the natural drain end real runs first.
const HARD_RUN_CAP = 1000;

// Backstop for the no-agent-run path: a picked ticket whose file vanished
// between discovery and the access check returns 'skipped' without changing any
// state, so an external process repeatedly moving a file out from under us could
// otherwise spin. Single-threaded runs never reach this; the cap just bounds the
// pathological concurrent-edit case.
const MAX_STALE_SKIPS = 64;

/**
 * Rebuild the live queue: discover each processing stage in `--stages` order,
 * topo-sort within the stage (prereq before dependent, then sequence), and
 * concatenate preserving cross-stage priority. Mirrors run.mjs's snapshot
 * builder, but runs fresh every iteration. A mid-run cycle or sequence conflict
 * introduced by an agent degrades that one stage to sequence order with a
 * warning rather than aborting the run (run.mjs already rejected any cycle
 * present at startup).
 */
async function buildQueue(ticketsDir, stages) {
	const queue = [];
	for (const { stage, maxSequence } of stages) {
		const bucket = await discoverTickets(ticketsDir, stage, maxSequence);
		if (bucket.length === 0) continue;
		try {
			queue.push(...topoSortAndCheck(bucket));
		} catch (err) {
			console.warn(`  Live queue: topo-sort of ${stage}/ failed (${err.message}); using sequence order.`);
			queue.push(...bucket);  // discoverTickets already returns ascending-sequence order
		}
	}
	return queue;
}

/**
 * The highest-priority runnable ticket in the live queue, or null when nothing
 * is runnable.
 *
 * Holding is the same-stage arm of the deferral cascade. A slug passed over in
 * this pass — excluded for the run, or failing any gate below — stays in its
 * stage, so a dependent in a *later* stage is already gated by rank; but a
 * dependent in the *same* stage passes the rank gate (in-stage order is the
 * topo sort's job) and would run ahead of work that has not landed. So a
 * same-stage dependent of a passed-over slug is passed over too; the queue is
 * topo-sorted within each stage, so one forward pass carries the hold down a
 * chain. A dependent in an *earlier* stage is left to the rank gate: the stages
 * its prereq has already passed through have landed.
 */
export async function pickNext(queue, { ticketsDir, index, blockIndex = null, shard = null, excluded, transitions }) {
	const passedOver = new Set(excluded);
	const isRunnable = async t => {
		if (!NEXT_STAGE[t.stage]) return false;                                        // terminal stage — nothing to advance
		if (passedOver.has(t.slug)) return false;                                      // excluded this run
		if (!inShard(t.slug, shard)) return false;                                     // --shard: another runner's ticket
		if ((transitions.get(t.slug) ?? 0) >= MAX_TRANSITIONS_PER_SLUG) return false;  // regression loop
		if (t.prereqs.some(p => passedOver.has(p) && index.get(p)?.stage === t.stage)) return false;  // same-stage prereq not running this pass
		if (blockIndex && findTransitiveBlocker(t, blockIndex)) return false;          // --skip-blocked: prereq chain hits blocked/
		if (await findUnsatisfiedPrereq(t, ticketsDir, index)) return false;           // prereq behind but in-pipeline → retry later
		return true;
	};
	for (const t of queue) {
		if (await isRunnable(t)) return t;
		passedOver.add(t.slug);
	}
	return null;
}

export async function run(ctx) {
	const { ticketsDir, opts } = ctx;

	const excluded = new Set();      // slugs that errored / timed out / were not runnable this run — not retried until next run
	const transitions = new Map();   // slug → agent-run count this run (regression-loop backstop)
	const errors = [];

	// --max bounds the number of agent runs (stage transitions) for live, not a
	// snapshot length. Unset → fall back to the absolute hard cap.
	const runCap = Number.isFinite(opts.maxTickets) ? opts.maxTickets : HARD_RUN_CAP;

	let runs = 0;
	let staleSkips = 0;   // consecutive no-state-change skips; bounded by MAX_STALE_SKIPS
	// NOTE: the startup board check (run.mjs `checkBoard`) is not repeated per iteration — it reads
	// every ticket file. A board error introduced mid-run (say, an agent creating a backlog folder
	// for an unlisted release code) surfaces at the next run's startup; if agents start creating
	// release folders, run the check per iteration.
	while (runs < runCap) {
		const queue = await buildQueue(ticketsDir, opts.stages);
		if (queue.length === 0) break;

		// One cross-stage index per iteration, reused across all candidate checks.
		const index = await indexAllTickets(ticketsDir);
		const blockIndex = opts.skipBlocked
			? await indexAllTickets(ticketsDir, { withPrereqs: true })
			: null;

		// Pick the highest-priority runnable ticket given the live board.
		const pick = await pickNext(queue, { ticketsDir, index, blockIndex, shard: opts.shard, excluded, transitions });
		if (!pick) break;  // board drained, or every remaining ticket is gated/blocked

		const label = `[live ${runs + 1}]`;
		const outcome = await runOneStage(pick, ctx, { label });

		if (outcome.kind === 'stopped') break;
		if (outcome.kind === 'skipped') {
			// Moved out from under us — re-discover. No state changed, so bound the
			// pathological case where a file keeps vanishing at selection time.
			if (++staleSkips > MAX_STALE_SKIPS) {
				console.warn(`  Live: ${MAX_STALE_SKIPS} consecutive vanished picks — stopping to avoid a spin.`);
				break;
			}
			continue;
		}
		if (outcome.kind === 'deferred' || outcome.kind === 'invalid') {
			// deferred: pre-selection already cleared the prereq gate, so this is a rare race
			// (the board shifted between our index and runOneStage's re-check).
			// invalid: the ticket contradicts the board; re-picking it would only fail again.
			// Either way no agent ran: exclude for the run to avoid a tight no-progress loop,
			// without counting a run; next run retries.
			excluded.add(pick.slug);
			staleSkips = 0;  // excluded set grew → state changed, not a stale spin
			continue;
		}

		// Agent actually ran (success / agent-error / timed-out).
		staleSkips = 0;
		runs++;
		transitions.set(pick.slug, (transitions.get(pick.slug) ?? 0) + 1);

		if (outcome.kind === 'agent-error') {
			console.error(`  ${label} Agent error on "${pick.slug}" — excluding for the rest of this run.`);
			excluded.add(pick.slug);
			errors.push({ slug: pick.slug, exitCode: outcome.exitCode });
		} else if (outcome.kind === 'timed-out') {
			console.error(`  ${label} Timed out on "${pick.slug}" — excluding for the rest of this run (resume note added).`);
			excluded.add(pick.slug);
		}
		// success: the ticket left its stage; re-discovery surfaces its successor
		// and re-ranks it against the rest of the live board.

		await new Promise(r => setTimeout(r, 500));
	}

	if (runs >= runCap && Number.isFinite(opts.maxTickets)) {
		console.log(`  Reached --max ${opts.maxTickets} ticket(s).`);
	}

	return { errors };
}
