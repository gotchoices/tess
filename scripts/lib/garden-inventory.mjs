/**
 * The backlog inventory the gardener works from: every ticket in `backlog/`
 * and its sub-folders, grouped in the order the gardener ranks them, with one
 * summary of header facts per ticket.
 *
 * Everything here is pure over discovered tickets (`discoverTickets(…,
 * { includeFolders: true })`) and the board context, so the grouping and the
 * columns are testable without an agent; garden.mjs does the reading and the
 * printing.
 */

import { ageInDays } from './backlog-age.mjs';
import { hasAnchor } from './board-check.mjs';
import { RELEASES_FILE, currentRelease, rankOf } from './releases.mjs';
import { byName, headerField } from './tickets.mjs';

const RELEASES_PATH = `tickets/${RELEASES_FILE}`;
const DESCRIPTION_LIMIT = 200;

const ticketCount = n => `${n} ticket${n === 1 ? '' : 's'}`;
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A top-level ticket's age has reached the decline threshold. */
const proposesDecline = (ageDays, declineAfterDays) => ageDays != null && ageDays >= declineAfterDays;

function topHeading(releases) {
	if (!releases.present) return `backlog/ (no ${RELEASES_PATH})`;
	const current = currentRelease(releases);
	return current == null
		? `backlog/ (${RELEASES_PATH} lists no releases — everything is current)`
		: `Current release (${current}) — backlog/`;
}

/** What a sub-folder that is not a later release is. */
function otherFolderLabel(releases, name) {
	if (!releases.present) return 'curated folder';
	return name === currentRelease(releases) ? 'named after the current release' : 'not a release code';
}

/**
 * The inventory's groups, as `[{ heading, tickets }]`: the top level of
 * `backlog/` first (always, even when empty — it is the promotable queue),
 * then each later release's folder in `releases.md` order, then every other
 * folder by name.  Tickets keep their discovery order within a group.
 */
export function inventoryGroups(tickets, releases) {
	const byFolder = new Map();
	for (const ticket of tickets) {
		const folder = ticket.folder ?? null;
		if (!byFolder.has(folder)) byFolder.set(folder, []);
		byFolder.get(folder).push(ticket);
	}
	const take = folder => {
		const members = byFolder.get(folder) ?? [];
		byFolder.delete(folder);
		return members;
	};

	const groups = [{ heading: topHeading(releases), tickets: take(null) }];
	for (const { code } of releases.entries) {
		if (rankOf(releases, code) > 0 && byFolder.has(code)) {
			groups.push({ heading: `Deferred to ${code} — backlog/${code}/`, tickets: take(code) });
		}
	}
	for (const name of [...byFolder.keys()].sort(byName)) {
		groups.push({ heading: `backlog/${name}/ (${otherFolderLabel(releases, name)})`, tickets: take(name) });
	}
	return groups;
}

/**
 * One ticket's entry: its path under `backlog/`, its description, and a
 * bracket of header facts.  The anchor fact appears only on a board that
 * requires anchors; elsewhere there is nothing to be missing.  Age applies to
 * top-level tickets only: `ageDays` is a number of days, or null when no
 * commit has put the ticket there.
 */
export function inventoryLine(ticket, { anchorFields, anchorsRequired, ageDays = null, declineAfterDays }) {
	const value = name => headerField(ticket.header, name) || null;
	const facts = [];
	if (ticket.slug.startsWith('bug-')) {
		facts.push(`severity: ${value('severity') ?? 'MISSING'}`, `likelihood: ${value('likelihood') ?? 'MISSING'}`);
	}
	facts.push(`tradeoffs: ${value('tradeoffs') ? 'present' : 'MISSING'}`);
	if (anchorsRequired) facts.push(`anchor: ${hasAnchor(ticket.header, anchorFields) ? 'present' : 'MISSING'}`);
	if (ticket.folder == null) {
		facts.push(`age: ${ageDays == null ? 'new' : `${ageDays}d`}`);
		if (proposesDecline(ageDays, declineAfterDays)) facts.push('PROPOSE-DECLINE');
	}
	const path = ticket.folder == null ? ticket.file : `${ticket.folder}/${ticket.file}`;
	const description = truncate(value('description') ?? '(no description: header)', DESCRIPTION_LIMIT);
	return `- ${path} — ${description}\n  [${facts.join(' | ')}]`;
}

/**
 * The whole inventory, as `{ groups: [{ heading, entries }], counts: { top,
 * folders, proposed } }`.  `arrivals` is lib/backlog-age.mjs
 * `topLevelArrivals`' map; `nowSeconds` is the moment ages are measured to.
 */
export function buildInventory(tickets, { releases, anchorFields, anchorsRequired, arrivals, nowSeconds, declineAfterDays }) {
	let proposed = 0;
	const groups = inventoryGroups(tickets, releases).map(({ heading, tickets: members }) => ({
		heading,
		entries: members.map(ticket => {
			const arrival = ticket.folder == null ? arrivals.get(ticket.slug) : undefined;
			const ageDays = arrival == null ? null : ageInDays(arrival, nowSeconds);
			if (proposesDecline(ageDays, declineAfterDays)) proposed++;
			return inventoryLine(ticket, { anchorFields, anchorsRequired, ageDays, declineAfterDays });
		}),
	}));
	const top = groups[0].entries.length;
	return { groups, counts: { top, folders: tickets.length - top, proposed } };
}

/** The inventory as lines: a `###` heading per group, its entries (or `(none)`), then a blank line. */
export function inventoryText(groups) {
	return groups.flatMap(({ heading, entries }) => [
		`### ${heading} · ${ticketCount(entries.length)}`,
		'',
		...(entries.length > 0 ? entries : ['(none)']),
		'',
	]);
}

/** One line saying what the release list holds. */
export function releaseSummary(releases) {
	if (!releases.present) return `Release list: none — no ${RELEASES_PATH}, so there is no release tier and backlog sub-folders are curated folders`;
	if (releases.entries.length === 0) return `Release list: ${RELEASES_PATH} lists no releases — everything is current`;
	const describe = ({ code, due }, i) => {
		const notes = [...(i === 0 ? ['current'] : []), ...(due ? [`due ${due}`] : [])];
		return notes.length > 0 ? `${code} (${notes.join(', ')})` : code;
	};
	return `Release list: ${releases.entries.map(describe).join(', ')}`;
}

/** A board check's findings as lines, errors first — empty when it found nothing. */
export function boardCheckLines({ errors, warnings }) {
	return [
		...(errors.length > 0 ? ['Errors:', ...errors.map(e => `- ${e}`)] : []),
		...(warnings.length > 0 ? ['Warnings:', ...warnings.map(w => `- ${w}`)] : []),
	];
}
