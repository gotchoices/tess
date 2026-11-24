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

export interface SearchMatch {
	path: string;
	start_line: number;
	end_line: number;
	text: string;
	score: number;
}

export interface SearchResults {
	query: string;
	k: number;
	pathFilter: string | null;
	matches: SearchMatch[];
}

export interface RefMatch {
	path: string;
	start_line: number;
	end_line: number;
	text: string;
}

export interface RefResults {
	symbol: string;
	max: number;
	pathFilter: string | null;
	rows: RefMatch[];
}

export interface ChunkResult {
	path: string;
	start: number;
	end: number;
	text: string;
}

export interface IndexStatus {
	exists: boolean;
	dbPath: string;
	files?: number;
	chunks?: number;
	dim?: number;
	modelId?: string;
	schemaVersion?: string;
	dbSizeBytes?: number;
	dbModifiedMs?: number;
}

export interface IndexConfig {
	source: string | null;
	defaults: { exclude: string[]; extensions: string[] };
	project: { exclude: string[]; include: string[]; extensions: string[] };
	effective: { exclude: string[]; include: string[]; extensions: string[] };
}

export interface IndexJob {
	id: string;
	kind: 'refresh' | 'rebuild';
	status: 'running' | 'success' | 'error';
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	logTail: string[];
}

// ─── Inbox (the Decisions page) ──────────────────────────────────────────────
// Shapes are those of scripts/lib/inbox.mjs `readInbox` and scripts/lib/brief.mjs
// `parseBrief`, less the absolute `path` the server does not send.

export type InboxLane = 'batch' | 'think' | 'do' | 'waiting' | 'undistilled' | 'decided';

export interface BriefOption {
	key: string;
	text: string;
	/** Where the ticket goes if this option is chosen (`implement`, `complete`, `backlog/GA`), or null: the entry's `defaultTo`. */
	to: string | null;
}

export interface BriefGrade {
	level: string;
	why: string;
}

export interface Brief {
	needs: string | null;
	question: string | null;
	options: BriefOption[];
	recommend: { key: string; why: string } | null;
	ifNothing: string | null;
	/** The brief's own default destination, as written. */
	then: string | null;
	reversible: BriefGrade | null;
	confidence: BriefGrade | null;
	checked: string | null;
	decision: string | null;
	decisionNote: string | null;
	decided: string | null;
	ask: string | null;
}

export interface InboxWaiter {
	slug: string;
	stage: string;
}

export interface InboxEntry {
	file: string;
	slug: string;
	sequence: number | null;
	/** Where the ticket sits now: `blocked`, or the stage an answer sent it to. */
	stage: string;
	/** Its backlog release folder, when it sits in one. */
	folder: string | null;
	title: string | null;
	description: string | null;
	brief: Brief;
	problems: string[];
	lane: InboxLane;
	/** Where an answer sends the ticket when the chosen option names no destination of its own. */
	defaultTo: string;
	waiting: InboxWaiter[];
	ageDays: number | null;
	prereqs: string[];
	fields: Record<string, string>;
}

export interface Inbox {
	who: string;
	commits: boolean;
	/** Every destination an answer can be sent to on this board: the stages, plus `backlog/<CODE>` per later release. */
	destinations: string[];
	/** The tickets in `blocked/`, then the answered ones that have left it (lane `decided`, `stage` where they went). */
	entries: InboxEntry[];
}

/** One write's outcome: the ticket changed, where it now sits, and whether the commit that should follow did. */
export interface InboxWriteResult {
	changed: boolean;
	/** `stage` or `stage/folder` the ticket was moved to; null when the write moves nothing (an ask) or failed. */
	movedTo: string | null;
	committed: boolean;
	error: string | null;
}

export interface InboxDecision {
	decision: string;
	note?: string;
	/** A destination chosen by hand, when it is not the one the answer names by itself. */
	to?: string;
}

// ─── Distill pass (scripts/distill.mjs, run from the Decisions page) ─────────

/** A blocked ticket the pass would work now, and why (scripts/lib/inbox.mjs `dueForDistill`). */
export interface DistillDue {
	file: string;
	slug: string;
	reasons: string[];
}

/** One run of the pass, followed from the script's output. */
export interface DistillJob {
	id: string;
	status: 'running' | 'success' | 'error';
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	/** The run only listed what it would do. */
	dryRun: boolean;
	/** Tickets this run works; null until the script has said. */
	total: number | null;
	/** While running, tickets behind the current one; once ended, tickets whose agent finished. */
	done: number;
	/** Slug of the ticket being worked, or null. */
	current: string | null;
	/** Slugs whose agent failed or timed out. */
	failed: string[];
	stopRequested: boolean;
	logTail: string[];
}

export interface DistillState {
	due: DistillDue[];
	/** The running pass, or the last one this server ran. */
	job: DistillJob | null;
	/** The ticket the runner is working in this checkout; the pass refuses to start meanwhile. */
	runner: { stage: string; slug: string } | null;
}

/** What to start: nothing named means every due ticket. */
export interface DistillStart {
	/** Slugs to work, due or not. */
	only?: string[] | null;
	/** Re-check every unanswered ticket. */
	all?: boolean;
	/** Stop after this many tickets. */
	max?: number | null;
	dryRun?: boolean;
}

export interface ApiError {
	error: string;
	message?: string;
}
