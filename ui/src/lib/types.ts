export interface TicketSummary {
	filename: string;
	stage: string;
	sequence: number | null;
	slug: string;
	description: string;
	prereq?: string;
	files?: string[];
}

export interface TicketDetail extends TicketSummary {
	body: string;
	raw: string;
}

export interface PipelineCounts {
	backlog: number;
	fix: number;
	plan: number;
	implement: number;
	review: number;
	blocked: number;
	complete: number;
}

export interface SiblingInfo {
	name: string;
	url: string;
}
