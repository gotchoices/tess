<script lang="ts">
	import type { TicketSummary } from '../lib/types.js';

	let { ticket }: { ticket: TicketSummary } = $props();

	function priorityLabel(p: number): string {
		if (p >= 5) return 'critical';
		if (p >= 4) return 'high';
		if (p >= 3) return 'medium';
		if (p >= 2) return 'low';
		return 'minimal';
	}

	function priorityColor(p: number): string {
		if (p >= 5) return 'var(--danger)';
		if (p >= 4) return 'var(--warning)';
		if (p >= 3) return 'var(--primary)';
		return 'var(--text-light)';
	}
</script>

<a class="card" href="#/ticket/{ticket.stage}/{ticket.filename}">
	<div class="card-header">
		<span class="priority" style:color={priorityColor(ticket.priority)}>
			P{ticket.priority}
		</span>
		<span class="slug">{ticket.slug}</span>
	</div>
	<div class="description">{ticket.description}</div>
	<div class="card-footer">
		<span class="priority-label" style:color={priorityColor(ticket.priority)}>
			{priorityLabel(ticket.priority)}
		</span>
		{#if ticket.files?.length}
			<span class="file-count">{ticket.files.length} file{ticket.files.length !== 1 ? 's' : ''}</span>
		{/if}
	</div>
</a>

<style>
	.card {
		display: block;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.875rem 1rem;
		text-decoration: none;
		color: inherit;
		transition: all var(--transition);
	}
	.card:hover {
		border-color: var(--primary);
		box-shadow: var(--shadow-lg);
		transform: translateY(-1px);
		text-decoration: none;
	}
	.card-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}
	.priority {
		font-size: 0.7rem;
		font-weight: 700;
		font-family: var(--font-mono);
	}
	.slug {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text);
	}
	.description {
		font-size: 0.8rem;
		color: var(--text-muted);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.card-footer {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}
	.priority-label {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.file-count {
		font-size: 0.7rem;
		color: var(--text-light);
	}
</style>
