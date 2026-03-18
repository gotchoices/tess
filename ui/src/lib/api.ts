import type { PipelineCounts, TicketSummary, TicketDetail, SiblingInfo } from './types.js';

async function get<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

export const api = {
	pipeline: () => get<PipelineCounts>('/api/pipeline'),
	stage: (name: string) => get<TicketSummary[]>(`/api/stages/${encodeURIComponent(name)}`),
	ticket: (stage: string, filename: string) =>
		get<TicketDetail>(`/api/tickets/${encodeURIComponent(stage)}/${encodeURIComponent(filename)}`),
	sibling: () => get<SiblingInfo | null>('/api/sibling'),
};
