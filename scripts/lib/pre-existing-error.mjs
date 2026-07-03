/**
 * Pre-existing test-failure triage.
 *
 * When an agent working a normal ticket runs tests and hits a failure it
 * judges to be unrelated to its own changes, the workflow rules tell it to
 * drop a short report into `tickets/.pre-existing-error.md` and continue.
 * After every ticket commits (and again once the run finishes), the runner
 * calls `handlePreExistingError`: it picks up the report, invokes a triage
 * agent against it, removes the file, and commits whatever the triage
 * produced.
 *
 * Policy is **fix the root cause early, do not work around**. Triage either
 * lands a tightly-scoped root-cause fix in place, or — when the fix is larger
 * than a triage pass should attempt — files a prioritized ticket into
 * `tickets/fix/` (the top-priority processing stage), so the normal
 * fix→implement→review pipeline resolves the root cause on its next iteration
 * with a real budget, ahead of feature work. Skips, commented-out tests, and
 * loosened assertions are NOT acceptable outcomes. A failure that genuinely
 * cannot be fixed in-repo (an upstream dependency) is filed to
 * `tickets/blocked/` with the external cause named — tracked, never silent.
 *
 * To stop the same failure being re-triaged from cold by every subsequent
 * ticket, triage records the failing-test signature in a ledger
 * (`tickets/.pre-existing-known.md`). Before dispatching, the runner checks
 * that ledger: a signature already tracked by an in-flight `fix/` or `blocked/`
 * ticket short-circuits the re-triage.
 *
 * The triage agent uses the same adapter (claude/cursor/etc.) as the rest
 * of the pipeline but with a focused prompt — no per-stage rules, no MCP
 * directives — because the report supplies the only context it needs.
 */

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runAgent } from './process.mjs';

const REPORT_FILE = '.pre-existing-error.md';
const LEDGER_FILE = '.pre-existing-known.md';

function reportPath(ticketsDir) {
	return join(ticketsDir, REPORT_FILE);
}

function ledgerPath(ticketsDir) {
	return join(ticketsDir, LEDGER_FILE);
}

async function readReport(ticketsDir) {
	try {
		return await readFile(reportPath(ticketsDir), 'utf-8');
	} catch {
		return null;
	}
}

/**
 * Parse the known-failures ledger into entries. Each tracked line has the shape
 *   - `<test-signature>` → <slug> | <state> | <filed>
 * where <state> is `in-flight` (a fix ticket is live) or `blocked`. Malformed
 * or comment lines are ignored so the file stays human-editable.
 */
async function readLedgerEntries(ticketsDir) {
	let text;
	try {
		text = await readFile(ledgerPath(ticketsDir), 'utf-8');
	} catch {
		return [];
	}
	const entries = [];
	for (const line of text.split('\n')) {
		const m = line.match(/^-\s+`([^`]+)`\s*(?:→|->)\s*([^|]+)\|\s*([^|]+)\|/);
		if (m) entries.push({ signature: m[1].trim(), slug: m[2].trim(), state: m[3].trim() });
	}
	return entries;
}

/**
 * A report is already-tracked when its text mentions the signature of a ledger
 * entry whose fix is still open (`in-flight`/`blocked`). Substring match on the
 * failing-test path is deliberate — the report rule requires agents to include
 * the exact test path, and a live tracking ticket already owns that root cause.
 */
function findKnownEntry(report, ledger) {
	return ledger.find(
		(e) => (e.state === 'in-flight' || e.state === 'blocked') && e.signature && report.includes(e.signature),
	);
}

function buildTriagePrompt(report) {
	return [
		'# Triage: pre-existing test failure',
		'',
		'A prior tess agent, while working an unrelated ticket, encountered a test',
		'failure it judged to be pre-existing (not caused by its own changes) and',
		'wrote the report below. The policy is **fix the root cause as early as',
		'possible — never work around, skip, or defer it into obscurity.**',
		'',
		'Steps:',
		'',
		'  1. Re-run the indicated test(s) and confirm the failure reproduces at HEAD.',
		'     If it now PASSES (already fixed, flaky), the failure is gone: remove any',
		'     stale entry for it from `tickets/.pre-existing-known.md` and stop.',
		'  2. Check `tickets/.pre-existing-known.md` and the `tickets/fix/` and',
		'     `tickets/blocked/` folders for a ticket already tracking this failure.',
		'     If one exists, do NOT file a duplicate — stop (the fix is already',
		'     queued). Only proceed to a fix or a new ticket if nothing tracks it yet.',
		'  3. If you can identify and land the ROOT-CAUSE fix with reasonable',
		'     confidence, do so. Keep it tightly scoped — no unrelated refactors.',
		'     A root-cause fix is always preferred over any other outcome.',
		'  4. If the root-cause fix is larger than a single scoped pass should attempt,',
		'     file a PRIORITIZED ticket in `tickets/fix/` (filename `<slug>.md`, no',
		'     sequence prefix) using the standard tess header (description/prereq/',
		'     files/difficulty) followed by a body that captures the failing test, the',
		'     error output, the root-cause hypothesis, and the suspect files. Include a',
		'     "Design constraints" subsection and flag any cross-cutting obligations',
		'     the fix triggers (determinism edition bump, byte-format vector, golden',
		'     fixture, migration). Filing into `fix/` — the top-priority stage — means',
		'     the normal pipeline resolves it next, ahead of feature work.',
		'  5. Only if the failure genuinely cannot be fixed in this repository (it',
		'     originates in an upstream dependency) file it to `tickets/blocked/`',
		'     instead, naming the external cause.',
		'',
		'FORBIDDEN outcomes — none of these count as resolving the failure, and you',
		'must not use them to make the suite green:',
		'  - `it.skip` / `describe.skip` / `.only` / commenting out or deleting the',
		'    failing test or its assertions,',
		'  - loosening, inverting, or `expect`-wrapping assertions to pass,',
		'  - filing to `tickets/backlog/` (that is where failures go to be forgotten;',
		'    a reproducible pre-existing failure belongs in `fix/` or `blocked/`).',
		'A test may only be skipped with explicit human sign-off recorded in the',
		'ticket (approver + reason); you do not have that authority here.',
		'',
		'After filing a `fix/` or `blocked/` ticket (or if one already exists from a',
		'prior pass), append or update its entry in `tickets/.pre-existing-known.md`',
		'so later tickets do not re-triage it from cold. Create the file if absent',
		'with a `# Known pre-existing failures (tess)` heading. Each entry is one line:',
		'    - `<failing-test-path-or-id>` → <slug> | <state> | <YYYY-MM-DD>',
		'where <state> is `in-flight` for a `fix/` ticket or `blocked` for a',
		'`blocked/` one. Use the exact test path from the report as the signature. When',
		'you land a root-cause fix in place instead of filing a ticket, remove any',
		'existing entry for that signature.',
		'',
		'Do NOT modify or re-write `tickets/.pre-existing-error.md` — the runner',
		'deletes it after you exit. Do NOT commit; the runner handles commits.',
		'Do NOT advance, touch, or create tickets outside `fix/`, `blocked/`, and the',
		'ledger file named above.',
		'Do NOT run `git checkout -- `, `git restore`, `git reset`, `git clean`, or',
		'`git stash`, and do not otherwise revert or discard working-tree changes you',
		'did not make. The tree may carry concurrent edits — board promotions, other',
		'in-flight work — that are not yours to undo. Reproduce and fix the failure in',
		'place; "at HEAD" means the current committed state, not a sanitized tree.',
		'',
		'## Report',
		'',
		report,
	].join('\n');
}

/**
 * If a pre-existing-error report is present, dispatch a triage agent against
 * it, remove the file, and commit any resulting changes. Returns true if a
 * triage pass was attempted.
 */
export async function handlePreExistingError(ctx) {
	const { ticketsDir, repoRoot, logsDir, opts } = ctx;
	const report = await readReport(ticketsDir);
	if (!report) return false;

	// Dedup: if this failure is already tracked by an in-flight fix/ or blocked/
	// ticket, a triage pass would only re-diagnose a root cause someone already
	// owns. Drop the report and let the tracking ticket resolve it.
	const known = findKnownEntry(report, await readLedgerEntries(ticketsDir));
	if (known) {
		console.log(
			`\n  ⚠  Pre-existing test failure reported — already tracked in ${known.slug} (${known.state}); skipping re-triage.`,
		);
		await unlink(reportPath(ticketsDir)).catch(() => {});
		return true;
	}

	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const logFile = join(logsDir, `pre-existing-error.${ts}.log`);
	console.log(`\n  ⚠  Pre-existing test failure reported — dispatching triage agent.`);
	console.log(`     Log: ${logFile}`);

	const prompt = buildTriagePrompt(report);
	try {
		const result = await runAgent(opts.agent, prompt, repoRoot, logFile, {
			stage: 'triage',
			tokenBudget: opts.tokenBudget,
		});
		if (result.exitCode !== 0) {
			const suffix = result.timedOut ? ' (idle timeout)' : '';
			console.warn(`     Triage agent exited ${result.exitCode}${suffix}.`);
		}
	} catch (err) {
		console.warn(`     Triage agent failed to spawn: ${err.message}`);
	}

	// Always remove the report so the loop terminates even if the agent left it.
	await unlink(reportPath(ticketsDir)).catch(() => {});

	if (!opts.noCommit) {
		try {
			const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' }).trim();
			if (status) {
				execSync('git add -A', { cwd: repoRoot, encoding: 'utf-8' });
				execSync('git commit -m "tess: triage pre-existing test failure"', { cwd: repoRoot, encoding: 'utf-8' });
				console.log('     Committed triage result.');
			}
		} catch (err) {
			console.warn(`     Triage commit failed: ${err.message}`);
		}
	}
	return true;
}
