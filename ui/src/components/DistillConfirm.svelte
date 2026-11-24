<script lang="ts">
	/**
	 * A button that starts several agent runs, and so asks first: clicking it
	 * opens an inline confirmation that says what will start and lets the reader
	 * cap it.  A single run needs none; its buttons call the store directly.
	 */
	let { verb, noun = '', count, primary = false, disabled = false, reason = null, onstart }: {
		/** "Distill", "Re-check": the button reads `<verb> <count> <noun>`. */
		verb: string;
		noun?: string;
		/** How many tickets it would start an agent for. */
		count: number;
		primary?: boolean;
		disabled?: boolean;
		/** Why it cannot be started now, shown beside the button. */
		reason?: string | null;
		/** Called with the cap the reader typed, or null for all of them. */
		onstart: (max: number | null) => void;
	} = $props();

	let open = $state(false);
	let first: number | null = $state(null);

	// The field takes anything typed into it; a cap is a whole number between 1 and the count.
	const max = $derived(typeof first === 'number' && Number.isInteger(first) && first >= 1 && first < count ? first : null);
	const runs = $derived(max ?? count);

	function start() {
		open = false;
		onstart(max);
		first = null;
	}
</script>

{#if open && !disabled}
	<span class="confirm">
		<span class="what">
			Starts {runs} agent run{runs === 1 ? '' : 's'}, one per ticket, a few minutes and some model cost each. Most-waited-on first.
		</span>
		<label class="first">
			only the first
			<input type="number" min="1" max={count} placeholder="all" bind:value={first} />
		</label>
		<button class="btn small primary" onclick={start}>Start</button>
		<button class="btn small" onclick={() => (open = false)}>Cancel</button>
	</span>
{:else}
	<button class="btn small" class:primary disabled={disabled || count === 0} onclick={() => (open = true)}>
		{verb} {count}{noun ? ` ${noun}` : ''}
	</button>
	{#if reason}<span class="reason">{reason}</span>{/if}
{/if}

<style>
	.confirm {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.375rem 0.625rem;
		background: var(--surface);
		border: 1px solid var(--primary);
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text);
	}
	.first { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--text-muted); white-space: nowrap; }
	.first input {
		width: 4.5rem;
		padding: 0.2rem 0.375rem;
		font: inherit;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.first input:focus { outline: none; border-color: var(--primary); }
	.reason { font-size: 0.78rem; color: var(--warning); }
</style>
