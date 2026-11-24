<script lang="ts">
	import { distill } from '../lib/distill.svelte.js';

	let showLog = $state(false);
	let logBox: HTMLPreElement | undefined = $state();

	const job = $derived(distill.job);
	const running = $derived(distill.running);
	const failed = $derived(job !== null && !running && (job.status === 'error' || job.failed.length > 0));
	const lastLine = $derived(job?.logTail.at(-1)?.trim() ?? '');

	const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

	/** The one line that says where the pass is, or how it ended. */
	const headline = $derived.by(() => {
		if (!job) return '';
		if (running) {
			if (job.total === null) return 'Distilling — starting…';
			if (job.current) return `Distilling ${job.done + 1} of ${job.total} · ${job.current}`;
			return `Distilling · ${job.done} of ${job.total} behind it`;
		}
		if (job.dryRun) return `Dry run: ${plural(job.total ?? 0, 'ticket')} would be distilled`;
		// The script never reached a ticket: it had nothing to do, or it refused to start.
		if (job.total === null) return job.status === 'success' ? lastLine || 'Nothing to distill.' : `The distill pass did not run (exit ${job.exitCode}): ${lastLine}`;
		const parts = [`Distilled ${job.done} of ${job.total}`];
		if (job.failed.length > 0) parts.push(`${job.failed.length} failed: ${job.failed.join(', ')}`);
		else if (job.status === 'error') parts.push(`the pass exited with code ${job.exitCode}`);
		if (job.stopRequested && job.done + job.failed.length < job.total) parts.push('stopped when asked');
		return parts.join(' · ');
	});

	const progress = $derived(job && job.total ? Math.round((job.done / job.total) * 100) : 0);

	// Keep the newest line of the log in view while it grows.
	$effect(() => {
		if (showLog && logBox && job?.logTail.length) logBox.scrollTop = logBox.scrollHeight;
	});
</script>

{#if job && distill.shown}
	<div class="strip" class:failed class:ended={!running} role="status">
		<div class="line">
			<span class="headline">{headline}</span>
			{#if running}
				<button class="btn small" disabled={job.stopRequested} onclick={() => distill.stop()}>
					{job.stopRequested ? 'Stopping after this ticket…' : 'Stop after this ticket'}
				</button>
			{/if}
			<button class="btn small" onclick={() => (showLog = !showLog)} aria-expanded={showLog}>Log</button>
			{#if !running}
				<button class="dismiss" onclick={() => distill.dismiss()} aria-label="Dismiss">×</button>
			{/if}
		</div>
		{#if running}
			<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
				<div class="fill" class:unknown={job.total === null} style:width="{Math.max(progress, 2)}%"></div>
			</div>
		{/if}
		{#if showLog}
			<pre class="log" bind:this={logBox}>{job.logTail.join('\n') || '(no output yet)'}</pre>
		{/if}
	</div>
{/if}

<style>
	.strip {
		padding: 0.5rem 0.75rem;
		background: var(--surface);
		border: 1px solid var(--primary);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		font-size: 0.85rem;
	}
	.strip.ended { border-color: var(--success); background: var(--success-subtle); }
	.strip.failed { border-color: var(--danger); background: var(--danger-subtle); color: var(--danger); }
	.line { display: flex; align-items: center; gap: 0.5rem; }
	.headline { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
	.dismiss { font-size: 1.1rem; line-height: 1; padding: 0 0.25rem; color: var(--text-muted); }
	.dismiss:hover { color: var(--text); }

	.bar {
		height: 3px;
		margin-top: 0.5rem;
		background: var(--border);
		border-radius: 2px;
		overflow: hidden;
	}
	.fill { height: 100%; background: var(--primary); transition: width 300ms ease; }
	/* Before the script has said how many tickets it works, there is no fraction to show. */
	.fill.unknown { opacity: 0.4; }

	.log {
		margin-top: 0.5rem;
		padding: 0.625rem;
		max-height: 260px;
		overflow: auto;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre;
	}
</style>
