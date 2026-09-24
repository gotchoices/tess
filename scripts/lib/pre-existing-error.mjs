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

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runAgent } from './process.mjs';
import { commitAll } from './git.mjs';
import { indexAllTickets } from './tickets.mjs';
import { anchorFieldsOf, anchorsRequiredBy, readProjectRules } from './project-rules.mjs';

const REPORT_FILE = '.pre-existing-error.md';
const LEDGER_FILE = '.pre-existing-known.md';

/**
 * A tracked ledger line opens with a backticked test signature and *ends* with
 *   → <slug> | <state> | <YYYY-MM-DD>
 * (arrow may be `→` or `->`). Groups: 1=signature, 2=slug, 3=state, 4=date.
 *
 * Everything between the two is free prose, and that prose is the point: a
 * signature is usually a file path, and one file can hold two unrelated
 * failures, so triage writes the disambiguating detail — which tests, which
 * error text, what was measured, how to confirm it is this one — into the
 * entry. An earlier form of this regex allowed only whitespace there and so
 * matched none of the entries agents actually write.
 *
 * The `.*` is greedy on purpose: it backtracks to the *last* arrow on the
 * line, so prose containing its own arrow does not capture a slug out of the
 * middle of a sentence. The `$` anchor is what makes that safe — the tail must
 * be the final thing on the line.
 *
 * Non-matching lines (heading, blanks, human comments) are left untouched.
 */
const ENTRY_RE = /^-\s+`([^`]+)`.*(?:→|->)\s*([^|]+)\|\s*([^|]+)\|\s*(\S+)\s*$/;

/**
 * States whose entry still has an open tracking ticket, and so both suppress
 * re-triage and are candidates for the staleness sweep. The third state in use,
 * `one-off`, is a deliberate permanent record of a failure investigated and
 * resolved without a ticket: it names no slug, suppresses nothing, and is never
 * pruned.
 */
const TRACKED_STATES = new Set(['in-flight', 'blocked']);

/**
 * A ledger that has entry-shaped lines but parses none of them is broken, not
 * empty — and it reads as empty at every call site. Warn so the next run says
 * so instead of silently tracking nothing. Only fires when *nothing* parses:
 * human notes are legitimately bullets, so a single unparsed dash line among
 * good ones is not a signal.
 */
function warnIfLedgerInert(lines, reader) {
	if (lines.some((line) => ENTRY_RE.test(line))) return;
	const dashed = lines.filter((line) => /^-\s/.test(line)).length;
	if (dashed === 0) return;
	console.warn(
		`[runner] ${LEDGER_FILE}: ${dashed} entry-shaped line(s), none parsed — the ledger is tracking nothing (${reader}).`,
	);
}

/** Filename-safe timestamp, so two log files from one run never collide. */
function stamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

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
 * Parse the known-failures ledger into entries, each `ENTRY_RE`-shaped (see
 * above). Malformed or comment lines are ignored so the file stays
 * human-editable — but a file where *every* line is ignored is reported.
 */
export async function readLedgerEntries(ticketsDir) {
	let text;
	try {
		text = await readFile(ledgerPath(ticketsDir), 'utf-8');
	} catch {
		return [];
	}
	const lines = text.split('\n');
	warnIfLedgerInert(lines, 'reading known failures');
	const entries = [];
	for (const line of lines) {
		const m = line.match(ENTRY_RE);
		if (m) entries.push({ signature: m[1].trim(), slug: m[2].trim(), state: m[3].trim() });
	}
	return entries;
}

/**
 * A report is already-tracked when its text mentions the signature of a ledger
 * entry whose fix is still open (`in-flight`/`blocked`). Substring match on the
 * failing-test path is deliberate — the report rule requires agents to include
 * the exact test path, and a live tracking ticket already owns that root cause.
 *
 * NOTE: the match cannot tell two distinct failures in one test file apart —
 * it sees the path, not the entry's confirm-protocol prose. On 2026-09-24 a
 * fixture bug in `src/lamina-scope-node.test.ts` would have been suppressed by
 * that file's unrelated timeout entry. That is why the caller archives the
 * report it suppresses rather than only deleting it; if this misfires often
 * enough to notice, the entry needs a narrower signature than a bare path.
 */
function findKnownEntry(report, ledger) {
	return ledger.find((e) => TRACKED_STATES.has(e.state) && e.signature && report.includes(e.signature));
}

/**
 * Reconcile the known-failures ledger against live ticket state.
 *
 * Each ledger entry names a tracking `slug` (a `fix/` ticket or a `blocked/`
 * parking) that owns a pre-existing failure. Triage only removes an entry when
 * it personally re-runs the test and finds it gone, or lands a fix in place —
 * but the common case is a failure that flows fix→implement→review→complete
 * through the normal pipeline, and nobody re-reads the ledger when that
 * tracking ticket lands. Those entries go stale: they suppress re-triage of a
 * *genuine* regression sharing the same test path, and the file grows forever.
 *
 * This sweep drops an entry only when both halves hold: its state is one that
 * implies an open tracker (`in-flight`/`blocked`), and that slug resolves on
 * the board to stage `complete`. `indexAllTickets` folds the tombstone ledger
 * in as `complete`, so a completed-then-swept slug resolves too.
 *
 * An entry whose slug resolves *nowhere* is kept and its slug returned in
 * `unresolved`. "Absent from the board" is not evidence the fix landed: it is
 * equally a typo, a rename, a tracker living on another repo's board (this
 * repo's lamina submodule has its own), or the literal non-slug an `one-off`
 * entry carries. None of those should silently delete accumulated triage
 * detail, so absence is reported rather than acted on.
 *
 * Safe-conservative: pruning removes only the *suppression*, never re-detection.
 * If a failure is in fact still broken after its tracker completed, the next
 * ticket that trips it re-runs the test, reproduces at HEAD, re-files, and
 * re-adds the entry. Non-entry lines (heading, blanks, human notes) pass
 * through untouched; if no tracked entries remain, the file is removed (triage
 * recreates it with its heading on demand).
 *
 * Returns `{ removed, slugs, unresolved }` — `slugs` are the pruned tracking
 * slugs, `unresolved` the kept-but-unfindable ones.
 */
export async function pruneKnownFailures(ticketsDir, repoRoot, { dryRun = false, noCommit = false } = {}) {
	let text;
	try {
		text = await readFile(ledgerPath(ticketsDir), 'utf-8');
	} catch {
		return { removed: 0, slugs: [], unresolved: [] };  // no ledger yet
	}

	const lines = text.split('\n');
	warnIfLedgerInert(lines, 'pruning resolved entries');

	const index = await indexAllTickets(ticketsDir);

	const kept = [];
	const prunedSlugs = [];
	const unresolved = [];
	let keptEntryCount = 0;
	for (const line of lines) {
		const m = line.match(ENTRY_RE);
		if (!m) {
			kept.push(line);  // heading, blank, or human note — preserve verbatim
			continue;
		}
		const slug = m[2].trim();
		const state = m[3].trim();
		const rec = TRACKED_STATES.has(state) ? index.get(slug) : null;
		if (TRACKED_STATES.has(state) && !rec) unresolved.push(slug);
		if (rec?.stage === 'complete') {
			prunedSlugs.push(slug);
		} else {
			kept.push(line);
			keptEntryCount++;
		}
	}

	if (unresolved.length > 0) {
		console.warn(
			`[runner] ${LEDGER_FILE}: kept ${unresolved.length} entr${unresolved.length === 1 ? 'y' : 'ies'} whose tracking slug is not on this board — ${unresolved.join(', ')}. Check for a typo, or a tracker on another repo's board.`,
		);
	}

	if (prunedSlugs.length === 0) return { removed: 0, slugs: [], unresolved };
	if (dryRun) return { removed: prunedSlugs.length, slugs: prunedSlugs, unresolved, dryRun: true };

	if (keptEntryCount === 0) {
		// Nothing tracked remains — drop the file rather than leave a bare heading.
		await unlink(ledgerPath(ticketsDir)).catch(() => {});
	} else {
		// Preserve trailing newline shape; kept already excludes pruned lines.
		await writeFile(ledgerPath(ticketsDir), kept.join('\n'), 'utf-8');
	}

	if (!noCommit) commitKnownFailurePrune(prunedSlugs.length, repoRoot);

	return { removed: prunedSlugs.length, slugs: prunedSlugs, unresolved };
}

/** Stage just the ledger change and commit it. Returns true on commit. */
function commitKnownFailurePrune(count, repoRoot) {
	try {
		execSync('git add -A -- tickets/.pre-existing-known.md', { cwd: repoRoot, encoding: 'utf-8' });
		const status = execSync('git status --porcelain -- tickets/.pre-existing-known.md', {
			cwd: repoRoot,
			encoding: 'utf-8',
		}).trim();
		if (!status) return false;
		const plural = count === 1 ? 'entry' : 'entries';
		const msg = `tess: prune ${count} resolved known-failure ledger ${plural}`;
		execSync(`git commit -m "${msg}"`, { cwd: repoRoot, encoding: 'utf-8' });
		return true;
	} catch (err) {
		console.error(`[runner] Known-failure ledger prune commit failed: ${err.message}`);
		return false;
	}
}

/**
 * The triage agent's prompt.  `anchorFields` (lib/project-rules.mjs
 * `anchorFieldsOf`) are the fields a filed ticket may anchor with; pass an
 * empty list on a board that does not require anchors and the prompt asks
 * for none.
 */
export function buildTriagePrompt(report, anchorFields) {
	const anchors = anchorFields.map(field => `\`${field}:\``).join(', ');
	const anchorLines = anchorFields.length === 0
		? [
			'     (an `architecture:` line naming the project\'s testing document is',
			'     welcome but not required). Then body',
		]
		: [
			`     plus at least one anchor field (${anchors}) — runner`,
			'     will not work ticket without one; for test-infrastructure failure,',
			'     `architecture:` naming project\'s testing document is usual. Then body',
		];
	return [
		'# Triage: pre-existing test failure',
		'',
		'Prior tess agent hit test failure while on unrelated ticket. Judged it',
		'pre-existing (not from own changes), wrote report below. Policy: **fix root',
		'cause ASAP — never work around, skip, or defer into obscurity.**',
		'',
		'Steps:',
		'',
		'  1. Rule out stale portal-dist BEFORE trusting failure. quereus/lamina',
		'     packages `portal:`-linked from sibling repos, load built `dist/` not',
		'     `.ts` source — so unrebuilt sibling `src/` edit surfaces as phantom code',
		'     defect (real current method/export reads `is not a function`/undefined).',
		'     Run `node scripts/stale-portal-dist-guard.mjs`. If stale, rebuild ONLY',
		'     flagged package(s) (`cd <sibling-repo>/packages/<pkg> && yarn build`) —',
		'     do not touch sibling `src/` — then re-run test. If now passes, failure',
		'     was build drift not code defect: record no bug, file no ticket, stop. (If',
		'     rebuild itself fails because concurrent runner left sibling `src/`',
		'     mid-edit, do not fight it — file to `tickets/blocked/` naming in-flight',
		'     sibling work.)',
		'  2. Re-run indicated test(s), confirm failure reproduces at HEAD against',
		'     freshly-built deps. If now PASSES (already fixed, flaky), failure gone:',
		'     remove any stale entry from `tickets/.pre-existing-known.md` and stop.',
		'  3. Check `tickets/.pre-existing-known.md` + `tickets/fix/` + `tickets/blocked/`',
		'     for ticket already tracking this failure. If exists, do NOT file',
		'     duplicate — stop (fix already queued). Only proceed to fix or new ticket',
		'     if nothing tracks it yet.',
		'  4. If you can identify + land ROOT-CAUSE fix with reasonable confidence, do',
		'     so. Keep tightly scoped — no unrelated refactors. Root-cause fix always',
		'     preferred over any other outcome.',
		'  5. If root-cause fix larger than single scoped pass should attempt, file',
		'     PRIORITIZED ticket in `tickets/fix/` (filename `<slug>.md`, no sequence',
		'     prefix) using standard tess header (description/prereq/files/difficulty)',
		...anchorLines,
		'     capturing failing test, error output, root-cause hypothesis, suspect',
		'     files. Include "Design constraints" subsection + flag any cross-cutting',
		'     obligations fix triggers (determinism edition bump, byte-format vector,',
		'     golden fixture, migration). Filing into `fix/` — top-priority stage —',
		'     means normal pipeline resolves it next, ahead of feature work.',
		'  6. Only if failure genuinely cannot be fixed in this repo (originates in',
		'     upstream dependency), file to `tickets/blocked/` instead, naming external',
		'     cause.',
		'',
		'FORBIDDEN outcomes — none count as resolving the failure; must not use them to',
		'make suite green:',
		'  - `it.skip` / `describe.skip` / `.only` / commenting out or deleting the',
		'    failing test or its assertions,',
		'  - loosening, inverting, or `expect`-wrapping assertions to pass,',
		'  - filing to `tickets/backlog/` (where failures go to be forgotten; a',
		'    reproducible pre-existing failure belongs in `fix/` or `blocked/`).',
		'Test may only be skipped with explicit human sign-off recorded in ticket',
		'(approver + reason); you do not have that authority here.',
		'',
		'After filing `fix/` or `blocked/` ticket (or if one already exists from prior',
		'pass), append or update its entry in `tickets/.pre-existing-known.md` so later',
		'tickets do not re-triage from cold. Create file if absent with',
		'`# Known pre-existing failures (tess)` heading. Each entry is exactly ONE',
		'line — no wrapping — opening with backticked signature and ENDING with the',
		'tracking tail:',
		'    - `<failing-test-path-or-id>` — <prose> → <slug> | <state> | <YYYY-MM-DD>',
		'Use exact test path from report as signature. <state> is `in-flight` (a',
		'`fix/` ticket is live), `blocked` (a `blocked/` ticket is), or `one-off` (you',
		'investigated and resolved it with no ticket filed — a deliberate permanent',
		'record; write `no tracking ticket` in the slug position). Only `in-flight`',
		'and `blocked` suppress re-triage.',
		'',
		'The <prose> between signature and tail is the valuable part — WRITE IT. One',
		'file can hold two unrelated failures, and the runner matches on the',
		'signature alone, so without prose a later reporter cannot tell your failure',
		'from a different one at the same path. Say which tests, which error text,',
		'what you measured, and a confirm protocol ("re-run the file on its own; if',
		'it fails there too, it is not this"). The ONLY hard constraint: the',
		'` → <slug> | <state> | <date>` tail must be the last thing on the line, and',
		'the whole entry must stay on one line.',
		'',
		'When you land root-cause fix in place instead of filing ticket, remove any',
		'existing entry for that signature.',
		'',
		'Do NOT modify or re-write `tickets/.pre-existing-error.md` — runner deletes it',
		'after you exit. Do NOT commit; runner handles commits. Do NOT advance, touch,',
		'or create tickets outside `fix/`, `blocked/`, and the ledger file named above.',
		'Do NOT run `git checkout -- `, `git restore`, `git reset`, `git clean`, or',
		'`git stash`, and do not otherwise revert or discard working-tree changes you',
		'did not make. Tree may carry concurrent edits — board promotions, other in-',
		'flight work — not yours to undo. Reproduce and fix failure in place; "at HEAD"',
		'means current committed state, not sanitized tree.',
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
		// Archive before unlinking. The match is on the signature alone, so it can
		// suppress a *second*, unrelated failure that happens to live in the same
		// test file; keeping the text makes that recoverable instead of gone, and
		// naming the matched signature is what lets a reader see the misfire.
		const suppressed = join(logsDir, `pre-existing-error.suppressed.${stamp()}.log`);
		await writeFile(suppressed, report, 'utf-8').catch(() => {});
		console.log(
			`\n  ⚠  Pre-existing test failure reported — matched \`${known.signature}\`, already tracked in ${known.slug} (${known.state}); skipping re-triage.`,
		);
		console.log(`     Suppressed report: ${suppressed}`);
		await unlink(reportPath(ticketsDir)).catch(() => {});
		return true;
	}

	const logFile = join(logsDir, `pre-existing-error.${stamp()}.log`);
	console.log(`\n  ⚠  Pre-existing test failure reported — dispatching triage agent.`);
	console.log(`     Log: ${logFile}`);

	const { rules } = await readProjectRules(ticketsDir);
	const prompt = buildTriagePrompt(report, anchorsRequiredBy(rules) ? anchorFieldsOf(rules) : []);
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

	// Through commitAll like every other unscoped sweep the runner makes, so the triage agent's
	// output is covered by the same mass-deletion guard and the same working-tree probe.
	if (!opts.noCommit && commitAll(repoRoot, 'tess: triage pre-existing test failure', { context: 'pre-existing-failure triage' })) {
		console.log('     Committed triage result.');
	}
	return true;
}
