import { api } from './api.js';
import type { Inbox, InboxLane } from './types.js';

/** The lanes that hold something for the human to answer or do. */
export const OPEN_LANES: readonly InboxLane[] = ['batch', 'think', 'do'];

/**
 * The blocked-ticket inbox, shared by the Decisions page and the nav's count
 * so an answer recorded on the page is reflected in both from one reload.
 */
class InboxStore {
	data: Inbox | null = $state(null);
	error: string | null = $state(null);
	loaded = $state(false);

	#loading: Promise<void> | null = null;

	get openCount(): number {
		return this.data?.entries.filter(entry => OPEN_LANES.includes(entry.lane)).length ?? 0;
	}

	/** Fetch the inbox; callers that overlap share one request. */
	load(): Promise<void> {
		this.#loading ??= this.#fetch().finally(() => { this.#loading = null; });
		return this.#loading;
	}

	/** Fetch again after a write: a request already in flight may predate it, so it is not reused. */
	async reload(): Promise<void> {
		await this.#loading;
		return this.load();
	}

	async #fetch() {
		try {
			this.data = await api.inbox();
			this.error = null;
		} catch (err: any) {
			this.error = err.message;
		} finally {
			this.loaded = true;
		}
	}
}

export const inbox = new InboxStore();
