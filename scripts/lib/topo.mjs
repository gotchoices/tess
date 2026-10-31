/**
 * Topological sort over the ticket snapshot.
 *
 * Tickets may declare `prereq: <slug>` pointing at other tickets that must land
 * first.  Within the snapshot, we verify the DAG and sort so prereqs run before
 * dependents.  Explicit sequence numbers that conflict with a prereq edge (prereq
 * has a larger sequence than its dependent) are a hard error — the human needs
 * to re-number.  Cycles are also a hard error.
 */

import { byQueueOrder } from './tickets.mjs';

/**
 * Kahn's algorithm, picking among ready tickets in in-stage queue order
 * (sequence, then arrival) and, past that, in the order they were given —
 * discovery's, so the topo sort only ever moves a ticket to satisfy a prereq.
 */
export function topoSortAndCheck(tickets) {
	const position = new Map(tickets.map((t, i) => [t, i]));
	const bySlug = new Map();
	for (const t of tickets) {
		// If two tickets in the batch share a slug (different stages), index by
		// the first-seen copy; prereqs resolve to whichever is present.
		if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
	}
	const graph = new Map(tickets.map(t => [t, []]));        // prereq-ticket → dependent-tickets
	const indegree = new Map(tickets.map(t => [t, 0]));

	for (const t of tickets) {
		for (const ref of t.prereqs) {
			const pt = bySlug.get(ref);
			if (!pt || pt === t) continue;  // prereq outside snapshot (likely already complete) — ignore
			graph.get(pt).push(t);
			indegree.set(t, indegree.get(t) + 1);
			if (pt.sequence != null && t.sequence != null && pt.sequence > t.sequence) {
				throw new Error(
					`Sequence conflict: "${pt.file}" (seq ${pt.sequence}) is a prereq of ` +
					`"${t.file}" (seq ${t.sequence}) but has a later sequence number. ` +
					`Re-number so the prereq comes first.`
				);
			}
		}
	}

	const queue = tickets.filter(t => indegree.get(t) === 0);
	const sorted = [];
	while (queue.length > 0) {
		queue.sort((a, b) => byQueueOrder(a, b) || position.get(a) - position.get(b));
		const next = queue.shift();
		sorted.push(next);
		for (const dep of graph.get(next)) {
			indegree.set(dep, indegree.get(dep) - 1);
			if (indegree.get(dep) === 0) queue.push(dep);
		}
	}

	if (sorted.length < tickets.length) {
		const cyclic = tickets.filter(t => indegree.get(t) > 0).map(t => t.file).join(', ');
		throw new Error(`Cycle detected in ticket prereqs involving: ${cyclic}`);
	}

	return sorted;
}
