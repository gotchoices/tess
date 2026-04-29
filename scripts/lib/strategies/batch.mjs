/**
 * Batch strategy — drains the snapshot in topo/sequence order, advancing
 * each ticket exactly one stage.  This is the original tess behavior.
 *
 * Strategy contract:
 *   await run({ snapshot, ticketsDir, repoRoot, tessRoot, tessVersion,
 *               logsDir, opts })
 *
 * The strategy may call `process.exit` on a hard agent failure to halt the
 * batch; a successful drain returns normally so the orchestrator can print
 * "Done.".
 */

import { runOneStage } from '../run-ticket.mjs';

export async function run(ctx) {
	const { snapshot } = ctx;

	for (let i = 0; i < snapshot.length; i++) {
		const ticket = snapshot[i];
		const label = `[${i + 1}/${snapshot.length}]`;
		const outcome = await runOneStage(ticket, ctx, { label });

		if (outcome.kind === 'stopped') break;
		if (outcome.kind === 'agent-error') {
			console.error('Stopping to avoid cascading failures. Re-run to retry.');
			process.exit(outcome.exitCode);
		}

		if (i < snapshot.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}
}
