import { api } from './api.js';
import { inbox } from './inbox.svelte.js';
import type { DistillJob, DistillStart, DistillState } from './types.js';

/** How often a running pass is read. */
const POLL_MS = 2000;

const DISMISSED_KEY = 'tess.distill.dismissed';

function remembered(): string | null {
	try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

/**
 * The distill pass as the dashboard sees it: which blocked tickets are due,
 * the job this server is running or last ran, and whether the runner is in the
 * way.  While a job runs the store keeps reading it, and reloads the inbox as
 * each ticket finishes, so cards arrive in their lanes one by one.
 */
class DistillStore {
	state: DistillState | null = $state(null);
	error: string | null = $state(null);
	/**
	 * Id of the finished job whose result the reader has dismissed.  Kept in this
	 * browser, since the server goes on reporting its last job: without it a
	 * result dismissed yesterday would be back on every page load.
	 */
	dismissed: string | null = $state(remembered());

	/** slug → why the pass would work that ticket now. */
	due = $derived(new Map((this.state?.due ?? []).map(item => [item.slug, item.reasons])));

	#timer: ReturnType<typeof setTimeout> | undefined;

	get job(): DistillJob | null {
		return this.state?.job ?? null;
	}

	get running(): boolean {
		return this.job?.status === 'running';
	}

	get runner() {
		return this.state?.runner ?? null;
	}

	/** Whether there is a job to show: a running one, or a result not yet dismissed. */
	get shown(): boolean {
		return this.job !== null && this.job.id !== this.dismissed;
	}

	/** Read the pass's state, and keep reading while a job runs. */
	async load(): Promise<void> {
		const before = this.job;
		try {
			this.state = await api.distill();
			this.error = null;
		} catch (err: any) {
			this.error = err.message;
		}
		this.#follow(before);
	}

	/** Start a pass.  Throws with the server's reason when it refuses: one is running, or the runner is at work. */
	async start(start: DistillStart): Promise<void> {
		try {
			const job = await api.distillStart(start);
			this.state = { due: this.state?.due ?? [], runner: null, job };
			this.#follow(null);
		} catch (err) {
			await this.load();  // the refusal says something this copy of the state did not know
			throw err;
		}
	}

	/** Ask the running pass to stop once the ticket it is on has finished. */
	async stop(): Promise<void> {
		const { job } = await api.distillStop();
		if (this.state && job) this.state.job = job;
	}

	dismiss() {
		if (!this.job) return;
		this.dismissed = this.job.id;
		try { localStorage.setItem(DISMISSED_KEY, this.job.id); } catch { /* storage is unavailable: dismissed for this page load only */ }
	}

	#follow(before: DistillJob | null) {
		const job = this.job;
		// Another ticket is behind the pass, or the pass has ended: its brief is on disk now.
		if (job && before && job.id === before.id && (job.done !== before.done || job.status !== before.status)) inbox.reload();
		clearTimeout(this.#timer);
		if (this.running) this.#timer = setTimeout(() => this.load(), POLL_MS);
	}
}

export const distill = new DistillStore();
