/**
 * Per-ticket agent log file management.  Logs live in tickets/.logs/ (git-ignored).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Return the .logs dir path, ensuring it exists. */
export async function ensureLogsDir(ticketsDir) {
	const logsDir = join(ticketsDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

/** Build a log file path for a ticket run. */
export function logPath(logsDir, ticket) {
	const name = ticket.file.replace(/\.md$/, '');
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${name}.${ticket.stage}.${ts}.log`);
}
