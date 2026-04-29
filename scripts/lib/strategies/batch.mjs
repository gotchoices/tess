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

import { writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execSync } from 'node:child_process';
import { NEXT_STAGE, formatSeq } from '../tickets.mjs';
import { runAgent, MAX_TIMEOUT_RETRIES } from '../process.mjs';
import { commitTicket } from '../git.mjs';
import { writeInProgress, clearInProgress, addResumeNote, checkStop } from '../state.mjs';
import { logPath } from '../logging.mjs';
import { buildPrompt } from '../prompt.mjs';

export async function run({ snapshot, ticketsDir, repoRoot, tessRoot, tessVersion, logsDir, opts }) {
	ticketLoop: for (let i = 0; i < snapshot.length; i++) {
		if (await checkStop(ticketsDir)) {
			console.log('\n⏹  Stop file detected — halting before next ticket.');
			break;
		}

		const ticket = snapshot[i];

		// Guard: a previous agent may have already moved this ticket
		try {
			await access(ticket.path, constants.R_OK);
		} catch {
			console.log(`\n  [${i + 1}/${snapshot.length}] Skipped (already moved): ${ticket.file}\n`);
			continue;
		}

		let attempt = 0;
		let lastResult = null;
		let lastLogFile = null;
		let lastStartedAt = null;
		let success = false;

		while (attempt <= MAX_TIMEOUT_RETRIES) {
			// On retry, prepend a resume note pointing at the prior attempt's log so
			// the agent can read what it had been doing and resume rather than restart.
			if (attempt > 0) {
				try {
					await access(ticket.path, constants.R_OK);
				} catch {
					console.log(`  Ticket no longer present — not retrying.`);
					break;
				}
				try {
					await addResumeNote(ticket.path, {
						startedAt: lastStartedAt,
						agent: opts.agent,
						logFile: lastLogFile,
					});
					console.log(`\n  Retrying after timeout (attempt ${attempt + 1}/${MAX_TIMEOUT_RETRIES + 1}) — resume note added.`);
				} catch (err) {
					console.warn(`  Failed to add resume note: ${err.message}`);
				}
				if (await checkStop(ticketsDir)) {
					console.log('\n⏹  Stop file detected — halting before retry.');
					break ticketLoop;
				}
			}

			const currentLog = logPath(logsDir, ticket);
			const startedAt = new Date().toISOString();
			lastLogFile = currentLog;
			lastStartedAt = startedAt;

			const attemptLabel = attempt > 0 ? `  (retry ${attempt})` : '';
			const ticketBanner = [
				`${'─'.repeat(72)}`,
				`  [${i + 1}/${snapshot.length}] ${ticket.file}${attemptLabel}`,
				`  Stage: ${ticket.stage} → ${NEXT_STAGE[ticket.stage]}  |  Sequence: ${formatSeq(ticket.sequence)}`,
				`  Log: ${currentLog}`,
				`${'─'.repeat(72)}`,
			].join('\n');
			console.log(ticketBanner);

			await writeFile(currentLog, [
				`Ticket: ${ticket.file}`,
				`Stage: ${ticket.stage} → ${NEXT_STAGE[ticket.stage]}`,
				`Sequence: ${formatSeq(ticket.sequence)}`,
				`Agent: ${opts.agent}`,
				`Tess: ${tessVersion}`,
				`Started: ${startedAt}`,
				`Attempt: ${attempt + 1}${attempt > 0 ? ' (retry after timeout)' : ''}`,
				'═'.repeat(72),
				'',
			].join('\n'));

			await writeInProgress(ticketsDir, ticket, currentLog, opts.agent);

			const prompt = await buildPrompt(ticket, tessRoot);
			lastResult = await runAgent(opts.agent, prompt, repoRoot, currentLog, { stage: ticket.stage });

			if (lastResult.exitCode === 0) {
				success = true;
				break;
			}

			if (lastResult.timedOut && attempt < MAX_TIMEOUT_RETRIES) {
				console.error(`\n  Ticket timed out — will retry with resume note.`);
				attempt++;
				continue;
			}

			break;
		}

		if (success) {
			await clearInProgress(ticketsDir);

			if (!opts.noCommit && commitTicket(ticket, repoRoot)) {
				console.log(`  Committed.`);
			}

			console.log(`\n  [${i + 1}/${snapshot.length}] Complete: ${ticket.file}\n`);
		} else if (lastResult?.timedOut) {
			// All timeout retries exhausted. Annotate the ticket with a resume note
			// pointing at the latest log so the next run picks up where this one
			// left off, then continue to the next ticket so the runner doesn't
			// abandon the queue when stepping away.
			try {
				await access(ticket.path, constants.R_OK);
				await addResumeNote(ticket.path, {
					startedAt: lastStartedAt,
					agent: opts.agent,
					logFile: lastLogFile,
				});
				if (!opts.noCommit) {
					try {
						execSync('git add -A', { cwd: repoRoot, encoding: 'utf-8' });
						execSync(`git commit -m "tess: timed out on ${ticket.slug} — added resume note"`, { cwd: repoRoot, encoding: 'utf-8' });
					} catch (err) {
						console.warn(`    Failed to commit resume note: ${err.message}`);
					}
				}
			} catch { /* ticket file may have been moved */ }
			await clearInProgress(ticketsDir);
			console.error(`\n  [${i + 1}/${snapshot.length}] Timed out ${attempt + 1} time(s) on: ${ticket.file}`);
			console.error(`    Latest log: ${lastLogFile}`);
			console.error(`    Resume note added — re-run tess to pick up where it left off.\n`);
		} else if (lastResult) {
			console.error(`\nAgent exited with code ${lastResult.exitCode} on ticket: ${ticket.file}`);
			console.error(`Log: ${lastLogFile}`);
			console.error('Stopping to avoid cascading failures. Re-run to retry.');
			process.exit(lastResult.exitCode);
		}

		if (i < snapshot.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}
}
