export interface TicketSummary {
	filename: string;
	stage: string;
	priority: number;
	slug: string;
	description: string;
	dependencies?: string;
	files?: string[];
}

export interface TicketDetail extends TicketSummary {
	body: string;
	raw: string;
}

export interface PipelineCounts {
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
