/**
 * Builds the per-ticket prompt: workflow rules + ticket contents + framing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NEXT_STAGE, formatSeq } from './tickets.mjs';

/** Build the full prompt for a ticket. */
export async function buildPrompt(ticket, tessRoot) {
	const rulesFile = join(tessRoot, 'agent-rules', 'tickets.md');
	const [content, rules] = await Promise.all([
		readFile(ticket.path, 'utf-8'),
		readFile(rulesFile, 'utf-8'),
	]);
	return [
		`# Ticket: ${ticket.file} (stage: ${ticket.stage}, sequence: ${formatSeq(ticket.sequence)})`,
		`# Next stage: ${NEXT_STAGE[ticket.stage]}`,
		'',
		'## Ticket workflow rules:',
		'',
		rules,
		'',
		`## Contents of \`${ticket.path}\`:`,
		'',
		content,
		'',
		'## End',
		'Work the ticket as described above.',
		'Do NOT commit — the runner handles commits after you complete.',
	].join('\n');
}
