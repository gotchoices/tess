<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { api } from '../lib/api.js';
	import { inbox } from '../lib/inbox.svelte.js';
	import { distill } from '../lib/distill.svelte.js';
	import { renderMarkdown } from '../lib/markdown.js';
	import DistillStrip from './DistillStrip.svelte';
	import DistillConfirm from './DistillConfirm.svelte';
	import type { Brief, BriefGrade, BriefOption, InboxEntry, InboxLane, InboxWriteResult } from '../lib/types.js';

	interface Notice {
		id: number;
		kind: 'info' | 'warning' | 'error';
		text: string;
	}

	/** How long a confirmation ("sent to implement/") stays up; warnings and errors stay until dismissed. */
	const CONFIRMATION_MS = 6000;

	// What the human has entered on a ticket and not yet sent, keyed by ticket file.
	let choice: Record<string, string> = $state({});        // the option picked, where it is not the lane's default
	let sendTo: Record<string, string> = $state({});        // a destination picked by hand, where it is not the answer's own
	let note: Record<string, string> = $state({});
	let noteHint: Record<string, string> = $state({});      // why a submit was refused
	let askOpen: Record<string, boolean> = $state({});
	let askText: Record<string, string> = $state({});
	let answerOpen: Record<string, boolean> = $state({});   // undistilled rows: the free-text answer is shown
	let expanded: Record<string, boolean> = $state({});     // quick-decision rows opened into a full card
	let ticketOpen: Record<string, boolean> = $state({});
	let bodies: Record<string, { html?: string; error?: string }> = $state({});

	let undistilledOpen = $state(false);                    // the "Not yet distilled" rows are shown
	let focused: string | null = $state(null);              // the card the keyboard acts on
	let busy = $state(false);
	let notices: Notice[] = $state([]);
	let nextNoticeId = 0;

	/** Most-awaited first, then longest-waiting (unknown age last), then by slug. */
	function byUrgency(a: InboxEntry, b: InboxEntry): number {
		return b.waiting.length - a.waiting.length
			|| (b.ageDays ?? -1) - (a.ageDays ?? -1)
			|| a.slug.localeCompare(b.slug);
	}

	const lanes = $derived.by(() => {
		const by: Record<InboxLane, InboxEntry[]> = { batch: [], think: [], do: [], decided: [], waiting: [], undistilled: [] };
		// A lane this page does not know is shown with the tickets that have no usable brief.
		for (const entry of inbox.data?.entries ?? []) (by[entry.lane] ?? by.undistilled).push(entry);
		for (const list of Object.values(by)) list.sort(byUrgency);
		return by;
	});

	/** The cards `j`/`k` step through, in page order. */
	const cards = $derived([...lanes.think, ...lanes.do]);
	const openCount = $derived(lanes.batch.length + lanes.think.length + lanes.do.length);

	/** The option a key names, compared without case, as brief.mjs `optionFor` does. */
	function optionFor(brief: Brief, key: string | null | undefined): BriefOption | null {
		if (!key) return null;
		return brief.options.find(option => option.key.toLowerCase() === key.toLowerCase()) ?? null;
	}

	const recommended = (entry: InboxEntry) => optionFor(entry.brief, entry.brief.recommend?.key);

	/** The option selected on a ticket: a quick decision starts on the recommended one, every other card on none. */
	function chosen(entry: InboxEntry): BriefOption | null {
		return optionFor(entry.brief, choice[entry.file]) ?? (entry.lane === 'batch' ? recommended(entry) : null);
	}

	const noteOf = (entry: InboxEntry) => (note[entry.file] ?? '').trim();

	// ─── Destinations ────────────────────────────────────────────────────────
	// Answering a ticket moves it out of blocked/.  `option` is the chosen option, or null for "Other" and "Done".

	/** Where an answer sends the ticket by itself: the option's own destination, else the entry's default. */
	const ownDestination = (entry: InboxEntry, option: BriefOption | null) => option?.to ?? entry.defaultTo;

	/** Where it will be sent: a destination picked by hand wins. */
	const destination = (entry: InboxEntry, option: BriefOption | null) => sendTo[entry.file] ?? ownDestination(entry, option);

	/** The `to` a request carries: a hand-picked destination, and only when it is not the answer's own. */
	function toOverride(entry: InboxEntry, option: BriefOption | null): string | undefined {
		const picked = sendTo[entry.file];
		return picked && picked !== ownDestination(entry, option) ? picked : undefined;
	}

	/** Picking the answer's own destination again takes the override off, and the select follows the choice once more. */
	function pickDestination(entry: InboxEntry, option: BriefOption | null, value: string) {
		if (value === ownDestination(entry, option)) delete sendTo[entry.file];
		else sendTo[entry.file] = value;
	}

	/** The board's destinations, plus any a brief names that the board does not list, so the select can show it. */
	function destinationChoices(...named: string[]): string[] {
		return [...new Set([...(inbox.data?.destinations ?? []), ...named])];
	}

	const closes = (to: string) => to === 'complete';
	const destinationTitle = (to: string) => (closes(to) ? 'Closes the ticket: it goes to complete/ and nothing further is done' : `Sends the ticket to ${to}/`);

	/** `stage` or `stage/folder`: where a ticket sits now. */
	const placeOf = (entry: InboxEntry) => (entry.folder ? `${entry.stage}/${entry.folder}` : entry.stage);

	const noteId = (file: string) => `note-${file}`;
	const askId = (file: string) => `ask-${file}`;
	const cardId = (file: string) => `card-${file}`;

	async function focusElement(id: string) {
		await tick();  // the element may only just have been revealed
		document.getElementById(id)?.focus();
	}

	// ─── Writes ──────────────────────────────────────────────────────────────

	function notify(kind: Notice['kind'], text: string) {
		const id = nextNoticeId++;
		notices.push({ id, kind, text });
		if (kind === 'info') setTimeout(() => dismiss(id), CONFIRMATION_MS);
	}

	function dismiss(id: number) {
		notices = notices.filter(notice => notice.id !== id);
	}

	/** Say so when a write was not committed, or — for one item of a batch — not made at all. */
	function report(result: InboxWriteResult, file?: string) {
		if (result.committed || !result.error) return;
		if (result.changed) notify('warning', `Saved to the ticket but not committed: ${result.error}`);
		else notify('error', `Not saved${file ? ` (${file})` : ''}: ${result.error}`);
	}

	/** "Sent to implement/": where a moved ticket went, in the words the confirmation uses. */
	const sentTo = (place: string) => (closes(place) ? 'sent to complete/ (closed)' : `sent to ${place}/`);

	function clearDraft(file: string) {
		for (const drafts of [choice, sendTo, note, noteHint, askOpen, askText, answerOpen, expanded]) delete drafts[file];
	}

	/** Send an answer, then reload the inbox with the reader left where they were. */
	async function write(send: () => Promise<void>) {
		if (busy) return;
		busy = true;
		const scrollY = window.scrollY;
		const focusedIndex = cards.findIndex(entry => entry.file === focused);
		try {
			await send();
		} catch (err: any) {
			notify('error', err.message);
		}
		await inbox.reload();
		distill.load();  // an answer takes a ticket off the pass's list, a question puts one on it
		// An answered card has left the list: the ring moves to the card that took its place.
		if (focused && !cards.some(entry => entry.file === focused)) {
			focused = cards[Math.min(focusedIndex, cards.length - 1)]?.file ?? null;
		}
		await tick();
		window.scrollTo({ top: scrollY });
		busy = false;
	}

	/** Record an answer: `option` is the one chosen, or null for "other" and "done". */
	function decide(entry: InboxEntry, decision: string, option: BriefOption | null = null) {
		return write(async () => {
			const result = await api.decide(entry.file, { decision, note: noteOf(entry) || undefined, to: toOverride(entry, option) });
			report(result);
			if (result.movedTo) notify('info', `${entry.slug} ${sentTo(result.movedTo)}`);
			clearDraft(entry.file);
		});
	}

	function decideChosen(entry: InboxEntry) {
		const option = chosen(entry);
		if (option) decide(entry, option.key, option);
	}

	/** "Other": the note is the answer, so there must be one. */
	function decideOther(entry: InboxEntry) {
		if (noteOf(entry)) return decide(entry, 'other');
		answerOpen[entry.file] = true;
		noteHint[entry.file] = 'Write your answer in the note first: with "Other", the note is the decision.';
		focusElement(noteId(entry.file));
	}

	/** Take an answer back: the ticket returns to blocked/ from wherever the answer sent it. */
	function withdraw(entry: InboxEntry) {
		write(async () => {
			const result = await api.withdraw(entry.file);
			report(result);
			if (!result.movedTo) return;
			// An answer typed into the ticket by hand never moved it, so there is nothing to bring back.
			notify('info', entry.stage === result.movedTo ? `${entry.slug}: answer withdrawn` : `${entry.slug} is back in ${result.movedTo}/`);
		});
	}

	function toggleAsk(entry: InboxEntry) {
		askOpen[entry.file] = !askOpen[entry.file];
		if (askOpen[entry.file]) focusElement(askId(entry.file));
	}

	function sendAsk(entry: InboxEntry) {
		const question = (askText[entry.file] ?? '').trim();
		if (!question) return;
		write(async () => {
			report(await api.ask(entry.file, question));
			delete askOpen[entry.file];
			delete askText[entry.file];
		});
	}

	/** Show or hide the whole ticket; it is fetched on every opening, since the distill pass rewrites bodies. */
	async function toggleTicket(file: string) {
		ticketOpen[file] = !ticketOpen[file];
		if (!ticketOpen[file]) return;
		try {
			bodies[file] = { html: renderMarkdown((await api.ticket('blocked', file)).body) };
		} catch (err: any) {
			bodies[file] = { error: err.message };
		}
	}

	// ─── Keyboard ────────────────────────────────────────────────────────────

	/** Whether a key press belongs to the element it landed on: text fields and selects, not radios or checkboxes. */
	function isTyping(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
		return target instanceof HTMLInputElement && target.type !== 'radio' && target.type !== 'checkbox';
	}

	async function moveFocus(step: 1 | -1) {
		if (cards.length === 0) return;
		const index = cards.findIndex(entry => entry.file === focused);
		const next = index === -1 ? (step === 1 ? 0 : cards.length - 1) : Math.max(0, Math.min(cards.length - 1, index + step));
		focused = cards[next].file;
		await tick();
		document.getElementById(cardId(cards[next].file))?.scrollIntoView({ block: 'nearest' });
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target;
		if (isTyping(target)) {
			if (event.key === 'Escape') (target as HTMLElement).blur();
			return;
		}
		if (event.key === 'j' || event.key === 'k') {
			event.preventDefault();
			moveFocus(event.key === 'j' ? 1 : -1);
			return;
		}
		const entry = cards.find(candidate => candidate.file === focused);
		if (!entry) return;

		if (/^[1-9]$/.test(event.key)) {
			const option = entry.brief.options[Number(event.key) - 1];
			if (option) choice[entry.file] = option.key;
		} else if (event.key === 'Enter') {
			// A focused button, link or summary takes Enter itself.
			if (target instanceof HTMLElement && target.closest('button, a, summary')) return;
			if (chosen(entry) && !busy) {
				event.preventDefault();
				decideChosen(entry);
			}
		} else if (event.key === 'o') {
			toggleTicket(entry.file);
		} else if (event.key === 'n') {
			event.preventDefault();  // or the key lands in the note it focuses
			focusElement(noteId(entry.file));
		}
	}

	// ─── Labels ──────────────────────────────────────────────────────────────

	const ageLabel = (days: number) => (days === 0 ? 'today' : `${days} d`);
	const ageTitle = (days: number) => (days === 0 ? 'Arrived in blocked/ today' : `${days} day${days === 1 ? '' : 's'} in blocked/`);
	const waitingTitle = (entry: InboxEntry) => entry.waiting.map(waiter => `${waiter.slug} (${waiter.stage})`).join('\n');

	/** A recorded decision in words: the option it names when it names one. */
	function decisionLabel(entry: InboxEntry): string {
		const decision = entry.brief.decision ?? '';
		const option = optionFor(entry.brief, decision);
		if (option) return `${option.key}: ${option.text}`;
		if (decision.toLowerCase() === 'other') return 'Other';
		if (decision.toLowerCase() === 'done') return 'Done';
		return decision;
	}

	// How alarming a grade is: an irreversible or unsure recommendation is what the human should weigh.
	const GRADE_TONE: Record<string, string> = { yes: 'good', high: 'good', costly: 'caution', low: 'caution', no: 'danger' };

	/** A project field that says the ticket holds something up (`blocks-deploy: true`). */
	const isBlocking = (name: string, value: string) => name.startsWith('blocks-') && value !== 'false';

	// ─── Distill pass ────────────────────────────────────────────────────────
	// One agent per ticket writes or re-checks its brief (scripts/distill.mjs); lib/distill.svelte.ts follows the job.

	/** Why no pass can be started now, when the reason is one the reader cannot see on the page. */
	const distillBlocked = $derived(distill.runner
		? `The runner is working ${distill.runner.stage}/${distill.runner.slug} in this checkout — distilling now would get swept into its commit.`
		: null);
	const distillDisabled = $derived(!distill.state || distill.running || distill.runner !== null);

	/** The tickets without a usable brief that a pass would write one for. */
	const undistilledDue = $derived(lanes.undistilled.filter(entry => distill.due.has(entry.slug)));
	/** The tickets that have a brief the pass would check again: a file they name changed, or a question was sent back. */
	const stale = $derived([...lanes.batch, ...lanes.think, ...lanes.do, ...lanes.waiting].filter(entry => distill.due.has(entry.slug)));

	/** Start a pass over exactly these tickets, so the count on the button is the number of agent runs. */
	async function startDistill(entries: InboxEntry[], max: number | null = null) {
		try {
			await distill.start({ only: entries.map(entry => entry.slug), max });
		} catch (err: any) {
			notify('error', `The distill pass did not start: ${err.message}`);
		}
	}

	/** The runner and the distill pass change `blocked/` behind the page: read it again when the tab is returned to. */
	function refresh() {
		if (busy) return;
		inbox.load();
		distill.load();
	}

	onMount(refresh);
</script>

<svelte:window onkeydown={onKeydown} onfocus={refresh} />

{#snippet stateChips(entry: InboxEntry)}
	{#if entry.waiting.length > 0}
		<span class="chip caution" title={waitingTitle(entry)}>{entry.waiting.length} waiting</span>
	{/if}
	{#if entry.ageDays !== null}
		<span class="chip" title={ageTitle(entry.ageDays)}>{ageLabel(entry.ageDays)}</span>
	{/if}
	<!-- A brief the pass would check again; a ticket with no brief says so by its section. -->
	{#if entry.lane !== 'undistilled' && distill.due.has(entry.slug)}
		<span class="chip caution" title={distill.due.get(entry.slug)?.[0]}>due for re-check</span>
	{/if}
{/snippet}

<!-- One ticket, one agent run: started at once.  `label` is "Distill" for a first brief, "Re-check" for a brief that exists. -->
{#snippet distillButton(entry: InboxEntry, label: string, quiet: boolean = false)}
	<button
		class="btn small"
		class:quiet
		disabled={distillDisabled}
		title="Starts one agent run: it checks this ticket against the code and {label === 'Distill' ? 'writes' : 'rewrites'} its brief"
		onclick={() => startDistill([entry])}
	>
		{label}
	</button>
{/snippet}

<!-- Where an answer sends the ticket; `changed` when a hand-picked destination replaced the answer's own. -->
{#snippet destinationChip(to: string, changed: boolean = false)}
	<span class="chip to" class:closes={closes(to)} class:changed title={destinationTitle(to)}>→ {to}</span>
{/snippet}

<!-- The override: starts on the answer's own destination and follows the choice until one is picked by hand. -->
{#snippet sendToSelect(entry: InboxEntry, option: BriefOption | null)}
	{@const own = ownDestination(entry, option)}
	{@const current = destination(entry, option)}
	<label class="send-to">
		<span class="label">Send to</span>
		<select
			class:changed={current !== own}
			class:closes={closes(current)}
			value={current}
			title={destinationTitle(current)}
			onchange={(event) => pickDestination(entry, option, event.currentTarget.value)}
		>
			{#each destinationChoices(own, current) as choice}
				<option value={choice}>{choice}</option>
			{/each}
		</select>
		{#if current !== own}<span class="why changed">instead of {own}</span>{/if}
	</label>
{/snippet}

{#snippet slugLink(entry: InboxEntry)}
	<a class="slug" href="#/ticket/blocked/{encodeURIComponent(entry.file)}">{entry.slug}</a>
{/snippet}

{#snippet grade(name: string, value: BriefGrade | null)}
	{#if value}
		<div class="grade">
			<span class="chip {GRADE_TONE[value.level] ?? ''}">{name}: {value.level}</span>
			{#if value.why}<span class="grade-why">{value.why}</span>{/if}
		</div>
	{/if}
{/snippet}

{#snippet waitingList(entry: InboxEntry)}
	{#if entry.waiting.length > 0}
		<div class="waiting-on">
			<span class="label">Waiting on this</span>
			{#each entry.waiting as waiter}
				<span class="waiter">{waiter.slug} <span class="waiter-stage">{waiter.stage}</span></span>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet fieldChips(entry: InboxEntry)}
	{@const fields = Object.entries(entry.fields)}
	{#if fields.length > 0}
		<div class="fields">
			{#each fields as [name, value]}
				<span class="field" class:blocking={isBlocking(name, value)}>{name}{value ? `: ${value}` : ''}</span>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet noteBox(entry: InboxEntry, placeholder: string)}
	<textarea
		id={noteId(entry.file)}
		class="note"
		rows="2"
		{placeholder}
		aria-label="Note"
		bind:value={note[entry.file]}
		oninput={() => delete noteHint[entry.file]}
	></textarea>
	{#if noteHint[entry.file]}<p class="note-hint">{noteHint[entry.file]}</p>{/if}
{/snippet}

{#snippet askButton(entry: InboxEntry)}
	<button class="btn" onclick={() => toggleAsk(entry)} aria-expanded={!!askOpen[entry.file]}>Ask a question</button>
{/snippet}

{#snippet ticketButton(entry: InboxEntry)}
	<button class="btn" onclick={() => toggleTicket(entry.file)} aria-expanded={!!ticketOpen[entry.file]}>Full ticket</button>
{/snippet}

{#snippet askBox(entry: InboxEntry)}
	{#if entry.brief.ask}
		<p class="asked">You asked: {entry.brief.ask}, waiting for the distill pass</p>
	{/if}
	{#if askOpen[entry.file]}
		<form class="ask" onsubmit={(event) => { event.preventDefault(); sendAsk(entry); }}>
			<input
				id={askId(entry.file)}
				type="text"
				placeholder="What do you need to know before you can answer?"
				aria-label="Question"
				bind:value={askText[entry.file]}
			/>
			<button class="btn primary" type="submit" disabled={busy || !(askText[entry.file] ?? '').trim()}>Send question</button>
		</form>
	{/if}
{/snippet}

{#snippet fullTicket(entry: InboxEntry)}
	{#if ticketOpen[entry.file]}
		{@const body = bodies[entry.file]}
		<div class="full-ticket">
			{#if body?.error}
				<p class="note-hint">Could not load the ticket: {body.error}</p>
			{:else if body?.html !== undefined}
				<div class="markdown">{@html body.html}</div>
			{:else}
				<p class="muted">Loading…</p>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- Everything a decision card holds under its heading; also what a quick-decision row opens into. -->
{#snippet decisionBody(entry: InboxEntry)}
	{@const brief = entry.brief}
	{@const selected = chosen(entry)}
	{#if entry.description}<p class="context">{entry.description}</p>{/if}

	<div class="options" role="radiogroup" aria-label="Options">
		{#each brief.options as option, index}
			{@const isRecommended = option.key === recommended(entry)?.key}
			<label class="option" class:selected={selected?.key === option.key}>
				<input
					type="radio"
					name="choice-{entry.file}"
					value={option.key}
					checked={selected?.key === option.key}
					onchange={() => (choice[entry.file] = option.key)}
				/>
				<span class="option-body">
					<span class="option-line">
						<span class="option-key">{option.key}</span>
						<span>{option.text}</span>
						{@render destinationChip(ownDestination(entry, option))}
						{#if isRecommended}<span class="chip recommended">recommended</span>{/if}
						{#if index < 9}<kbd class="option-number">{index + 1}</kbd>{/if}
					</span>
					{#if isRecommended && brief.recommend?.why}<span class="why">{brief.recommend.why}</span>{/if}
				</span>
			</label>
		{/each}
	</div>

	{#if brief.ifNothing}
		<p class="if-nothing"><span class="label">If nothing is decided</span> {brief.ifNothing}</p>
	{/if}
	<div class="grades">
		{@render grade('reversible', brief.reversible)}
		{@render grade('confidence', brief.confidence)}
	</div>
	{@render waitingList(entry)}
	{@render fieldChips(entry)}
	{@render noteBox(entry, 'Note (optional) — goes into the ticket with your decision')}

	<div class="actions">
		<button class="btn primary" disabled={busy || !selected} onclick={() => decideChosen(entry)}>
			Decide{selected ? ` ${selected.key}` : ''}
		</button>
		<!-- "Other" names no option, so it goes to the entry's default: said on the button when the select shows a chosen option's different one. -->
		<button class="btn" disabled={busy} onclick={() => decideOther(entry)}>
			Other…{destination(entry, null) !== destination(entry, selected) ? ` → ${destination(entry, null)}` : ''}
		</button>
		{@render askButton(entry)}
		{@render ticketButton(entry)}
		{@render distillButton(entry, 'Re-check', true)}
		{@render sendToSelect(entry, selected)}
	</div>
	{@render askBox(entry)}
	{@render fullTicket(entry)}
{/snippet}

<div class="header">
	<h1 class="title">Decisions</h1>
	{#if inbox.data}
		<span class="caption">{openCount} open · answers are signed {inbox.data.who}</span>
	{/if}
	{#if stale.length > 0}
		<!-- The runner's reason goes beside the main Distill button; here only when that one is not on the page. -->
		<DistillConfirm
			verb="Re-check"
			noun="stale"
			count={stale.length}
			disabled={distillDisabled}
			reason={lanes.undistilled.length === 0 ? distillBlocked : null}
			onstart={(max) => startDistill(stale, max)}
		/>
	{/if}
	<a class="all-link" href="#/stage/blocked">All blocked tickets →</a>
</div>

<p class="keys">
	<kbd>j</kbd>/<kbd>k</kbd> move between cards · <kbd>1</kbd>–<kbd>9</kbd> choose an option · <kbd>Enter</kbd> decide ·
	<kbd>o</kbd> full ticket · <kbd>n</kbd> note · <kbd>Esc</kbd> leave a field
</p>

{#if inbox.data && !inbox.data.commits}
	<p class="standing-note">Answers are written to the ticket files but not committed (TESS_UI_NO_COMMIT=1).</p>
{/if}

<!-- Pinned under the nav: the pass's progress is seen wherever the reader has scrolled to. -->
{#if distill.shown}
	<div class="notices">
		<DistillStrip />
	</div>
{/if}

<!-- What a write just did floats in a corner, out of the page's flow.  A confirmation that pushed the
     cards down and let them spring back would move the next Accept button out from under the pointer. -->
{#if notices.length > 0}
	<div class="toasts">
		{#each notices as notice (notice.id)}
			<div class="notice {notice.kind}" role={notice.kind === 'info' ? 'status' : 'alert'}>
				<span>{notice.text}</span>
				<button class="dismiss" onclick={() => dismiss(notice.id)} aria-label="Dismiss">×</button>
			</div>
		{/each}
	</div>
{/if}

{#if !inbox.loaded}
	<div class="empty">Loading…</div>
{:else if !inbox.data}
	<div class="notice error">Could not read the inbox: {inbox.error}</div>
{:else if inbox.data.entries.length === 0}
	<div class="empty">Nothing is blocked.</div>
{:else}
	{#if inbox.error}
		<div class="notice warning">Could not refresh the inbox ({inbox.error}); this is the last copy read.</div>
	{/if}
	{#if openCount === 0}
		<div class="empty">
			Nothing needs you right now.
			{#if lanes.undistilled.length > 0}
				{lanes.undistilled.length} blocked ticket{lanes.undistilled.length === 1 ? ' has' : 's have'} no brief yet — see “Not yet distilled” below.
			{/if}
		</div>
	{/if}

	{#if lanes.batch.length > 0}
		<section class="section">
			<div class="section-head">
				<h2 class="section-title">Quick decisions <span class="count">{lanes.batch.length}</span></h2>
				<span class="section-hint">Cheap to take back and confidently recommended. Each is accepted on its own.</span>
			</div>
			<div class="rows">
				{#each lanes.batch as entry (entry.file)}
					{@const selected = chosen(entry)}
					{@const usual = recommended(entry)}
					<div class="row batch-row">
						<div class="row-main">
							<div class="row-question">{entry.brief.question}</div>
							<div class="row-answer">
								<select
									aria-label="Option"
									value={selected?.key}
									onchange={(event) => (choice[entry.file] = event.currentTarget.value)}
								>
									{#each entry.brief.options as option}
										<option value={option.key}>{option.key}{option.key === usual?.key ? ' (recommended)' : ''}</option>
									{/each}
								</select>
								<span class="row-option">{selected?.key}: {selected?.text}</span>
								{@render destinationChip(destination(entry, selected), destination(entry, selected) !== ownDestination(entry, selected))}
								{#if selected?.key === usual?.key}
									{#if entry.brief.recommend?.why}<span class="why">{entry.brief.recommend.why}</span>{/if}
								{:else}
									<span class="why changed">not the recommended option ({usual?.key})</span>
								{/if}
							</div>
						</div>
						<div class="row-chips">
							{@render stateChips(entry)}
							<button class="btn small" onclick={() => (expanded[entry.file] = !expanded[entry.file])} aria-expanded={!!expanded[entry.file]}>
								{expanded[entry.file] ? 'Less' : 'More'}
							</button>
							<!-- One answer per click: a row that arrived a moment ago is never swept up with the others. -->
							<button class="btn small primary" disabled={busy || !selected} onclick={() => decideChosen(entry)}>
								{selected?.key === usual?.key ? 'Accept' : `Record ${selected?.key ?? ''}`}
							</button>
						</div>
						{#if expanded[entry.file]}
							<div class="row-expanded">
								{@render slugLink(entry)}
								{@render decisionBody(entry)}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if lanes.think.length > 0}
		<section class="section">
			<div class="section-head">
				<h2 class="section-title">Needs thought <span class="count">{lanes.think.length}</span></h2>
				<span class="section-hint">Costly or impossible to take back, or the recommendation is unsure.</span>
			</div>
			{#each lanes.think as entry (entry.file)}
				<article class="card" class:focused={focused === entry.file} id={cardId(entry.file)} onfocusin={() => (focused = entry.file)}>
					<div class="card-head">
						<h3 class="question">{entry.brief.question}</h3>
						{@render stateChips(entry)}
					</div>
					{@render slugLink(entry)}
					{@render decisionBody(entry)}
				</article>
			{/each}
		</section>
	{/if}

	{#if lanes.do.length > 0}
		<section class="section">
			<div class="section-head">
				<h2 class="section-title">Yours to do <span class="count">{lanes.do.length}</span></h2>
				<span class="section-hint">A step or an observation only you can supply.</span>
			</div>
			{#each lanes.do as entry (entry.file)}
				{@const isObservation = entry.brief.needs === 'observation'}
				<article class="card" class:focused={focused === entry.file} id={cardId(entry.file)} onfocusin={() => (focused = entry.file)}>
					<div class="card-head">
						<h3 class="question">{entry.brief.question}</h3>
						<span class="chip needs">{entry.brief.needs}</span>
						{@render stateChips(entry)}
					</div>
					{@render slugLink(entry)}
					{#if entry.description}<p class="context">{entry.description}</p>{/if}
					{@render waitingList(entry)}
					{@render fieldChips(entry)}
					{@render noteBox(entry, isObservation ? 'What did you see? (required)' : 'Note (optional)')}
					<div class="actions">
						<button
							class="btn primary"
							disabled={busy || (isObservation && !noteOf(entry))}
							title={isObservation && !noteOf(entry) ? 'Write what you saw in the note first' : undefined}
							onclick={() => decide(entry, 'done')}
						>
							Done
						</button>
						{@render askButton(entry)}
						{@render ticketButton(entry)}
						{@render distillButton(entry, 'Re-check', true)}
						{@render sendToSelect(entry, null)}
					</div>
					{@render askBox(entry)}
					{@render fullTicket(entry)}
				</article>
			{/each}
		</section>
	{/if}

	{#if lanes.decided.length > 0}
		<section class="section">
			<div class="section-head">
				<h2 class="section-title">Decided — sent on <span class="count">{lanes.decided.length}</span></h2>
			</div>
			<p class="section-hint section-intro">
				An agent applies each answer when it picks the ticket up; until then it can be withdrawn. Tickets sent to complete/ or backlog/ stay listed for a week.
			</p>
			<div class="rows">
				<!-- Keyed by place as well as file: a slug filed twice must not collide. -->
				{#each lanes.decided as entry (`${placeOf(entry)}/${entry.file}`)}
					<div class="row decided-row">
						<div class="row-main">
							<div class="row-question">{entry.brief.question ?? entry.slug}</div>
							<div class="row-answer">
								<span class="row-option">{decisionLabel(entry)}</span>
								{#if entry.brief.decisionNote}<span class="decision-note">{entry.brief.decisionNote}</span>{/if}
								{#if entry.brief.decided}<span class="why">{entry.brief.decided}</span>{/if}
							</div>
						</div>
						<div class="row-chips">
							{#if entry.stage === 'blocked'}
								<span class="chip caution" title="The answer was written into the ticket by hand; nothing has moved it">still in blocked/</span>
							{:else}
								<span class="chip to" class:closes={closes(entry.stage)} title="Where the ticket is now">{placeOf(entry)}/</span>
							{/if}
							<button class="btn small" disabled={busy} title="Move it back to blocked/ without its answer" onclick={() => withdraw(entry)}>
								Withdraw
							</button>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if lanes.waiting.length > 0}
		<details class="section">
			<summary class="section-title">Waiting on something outside this repo <span class="count">{lanes.waiting.length}</span></summary>
			<div class="rows">
				{#each lanes.waiting as entry (entry.file)}
					<div class="row">
						<div class="row-main">
							<div class="row-question">{entry.brief.question}</div>
							{#if entry.description}<div class="row-description">{entry.description}</div>{/if}
						</div>
						<div class="row-chips">{@render stateChips(entry)}</div>
					</div>
				{/each}
			</div>
		</details>
	{/if}

	{#if lanes.undistilled.length > 0}
		<!-- Not a <details>: the Distill button must stay in reach while the rows are folded away. -->
		<section class="section">
			<div class="section-head">
				<button class="section-title section-toggle" aria-expanded={undistilledOpen} onclick={() => (undistilledOpen = !undistilledOpen)}>
					<span class="caret">{undistilledOpen ? '▾' : '▸'}</span>
					Not yet distilled <span class="count">{lanes.undistilled.length}</span>
				</button>
				<DistillConfirm
					verb="Distill"
					count={undistilledDue.length}
					primary
					disabled={distillDisabled}
					reason={distillBlocked}
					onstart={(max) => startDistill(undistilledDue, max)}
				/>
			</div>
			{#if undistilledOpen}
				<p class="section-hint distill-hint">
					These have no brief to show as a card. Distill runs <code>node tess/scripts/distill.mjs</code>: one agent per ticket checks it against the code and writes its brief.
				</p>
				<div class="rows">
					{#each lanes.undistilled as entry (entry.file)}
						<div class="row">
							<div class="row-main">
								<div class="row-question">{@render slugLink(entry)}</div>
								{#if entry.description}<div class="row-description">{entry.description}</div>{/if}
								{#if entry.problems.length > 0}
									<ul class="problems">
										{#each entry.problems as problem}<li>{problem}</li>{/each}
									</ul>
								{/if}
							</div>
							<div class="row-chips">
								{@render stateChips(entry)}
								{@render distillButton(entry, 'Distill')}
								{@render ticketButton(entry)}
								<button class="btn small" disabled={busy} onclick={() => decideOther(entry)}>Other…</button>
							</div>
							{#if answerOpen[entry.file] || ticketOpen[entry.file]}
								<div class="row-expanded">
									{#if answerOpen[entry.file]}
										{@render noteBox(entry, 'Your answer — recorded as the decision')}
										<div class="actions">
											<button class="btn primary" disabled={busy || !noteOf(entry)} onclick={() => decideOther(entry)}>Record answer</button>
											{@render sendToSelect(entry, null)}
										</div>
									{/if}
									{@render fullTicket(entry)}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
{/if}

<style>
	.header {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 0.5rem;
	}
	.title { font-size: 1.25rem; font-weight: 700; }
	.caption { font-size: 0.8rem; color: var(--text-muted); }
	.all-link { margin-left: auto; font-size: 0.8rem; }

	.keys, .standing-note {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}
	.standing-note {
		padding: 0.4rem 0.75rem;
		background: var(--warning-subtle);
		border: 1px solid var(--warning);
		border-radius: var(--radius);
		color: var(--text);
	}
	kbd {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--border);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--surface);
		color: var(--text-muted);
	}

	/* Below the sticky nav, so a pass's progress is seen wherever the reader has scrolled to. */
	.notices {
		position: sticky;
		top: 64px;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-bottom: 0.75rem;
	}
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius);
		font-size: 0.85rem;
		box-shadow: var(--shadow);
		margin-bottom: 0.75rem;
	}
	.toasts {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 200;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		width: min(28rem, calc(100vw - 2rem));
		pointer-events: none;  /* only the messages themselves take clicks, not the gaps between them */
	}
	.toasts .notice { pointer-events: auto; box-shadow: var(--shadow-lg); margin-bottom: 0; }
	.notice span { flex: 1; overflow-wrap: anywhere; }
	.notice.info { background: var(--success-subtle); border: 1px solid var(--success); }
	.notice.warning { background: var(--warning-subtle); border: 1px solid var(--warning); }
	.notice.error { background: var(--danger-subtle); border: 1px solid var(--danger); color: var(--danger); }
	.dismiss { font-size: 1.1rem; line-height: 1; padding: 0 0.25rem; color: var(--text-muted); }
	.dismiss:hover { color: var(--text); }

	.empty {
		text-align: center;
		padding: 2rem;
		color: var(--text-muted);
		font-style: italic;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin-bottom: 1rem;
	}

	.section { margin-bottom: 1.75rem; }
	.section-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.625rem;
	}
	.section-title {
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	summary.section-title { cursor: pointer; margin-bottom: 0.625rem; }
	.section-toggle { display: inline-flex; align-items: center; gap: 0.375rem; }
	.section-toggle:hover { color: var(--text); }
	.caret { font-size: 0.7rem; width: 0.7rem; }
	.count {
		font-size: 0.7rem;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--primary-subtle);
		color: var(--primary);
		letter-spacing: 0;
	}
	.section-hint { font-size: 0.78rem; color: var(--text-muted); }
	.distill-hint, .section-intro { margin-bottom: 0.625rem; }
	code {
		font-family: var(--font-mono);
		font-size: 0.85em;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 0.05rem 0.3rem;
	}

	/* ── Buttons and chips ── */
	/* `.btn` itself is in app.css, shared with the distill strip and confirm. */
	.row-chips .btn { font-size: 0.75rem; padding: 0.25rem 0.6rem; }

	.chip {
		display: inline-block;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-raised);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.chip.good { background: var(--success-subtle); border-color: var(--success); color: var(--success); }
	.chip.caution { background: var(--warning-subtle); border-color: var(--warning); color: var(--warning); }
	.chip.danger { background: var(--danger-subtle); border-color: var(--danger); color: var(--danger); }
	.chip.recommended, .chip.needs { background: var(--primary-subtle); border-color: var(--primary); color: var(--primary); }
	/* Where an answer sends the ticket: quiet, except complete (the answer closes the ticket) and a hand-picked destination. */
	.chip.to {
		font-family: var(--font-mono);
		font-weight: 500;
		background: none;
		border-style: dashed;
		color: var(--text-muted);
	}
	.chip.to.closes { border-style: solid; background: var(--success-subtle); border-color: var(--success); color: var(--success); }
	.chip.to.changed { border-style: solid; border-color: var(--warning); color: var(--warning); }

	/* ── Cards ── */
	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem 1.25rem;
		margin-bottom: 0.75rem;
		scroll-margin: 72px 0 16px;  /* clear of the sticky nav when j/k scrolls to it */
	}
	.card.focused { outline: 2px solid var(--primary); outline-offset: 2px; }
	.card-head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.question {
		flex: 1;
		font-size: 1rem;
		font-weight: 700;
		line-height: 1.4;
	}
	.slug {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--text-light);
		overflow-wrap: anywhere;
	}
	.context {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-top: 0.375rem;
	}
	.label {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		margin-right: 0.375rem;
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-top: 0.75rem;
	}
	.option {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
		transition: border-color var(--transition);
	}
	.option:hover { border-color: var(--primary); }
	.option.selected { border-color: var(--primary); background: var(--primary-subtle); }
	.option input { margin-top: 0.3rem; accent-color: var(--primary); }
	.option-body { flex: 1; display: flex; flex-direction: column; gap: 0.125rem; font-size: 0.875rem; }
	.option-line { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
	.option-line > span:nth-child(2) { flex: 1; min-width: 12rem; }
	.option-key { font-family: var(--font-mono); font-weight: 700; }
	.option-number { margin-left: auto; }
	.why { font-size: 0.8rem; color: var(--text-muted); }
	.why.changed { color: var(--warning); }

	.if-nothing { font-size: 0.85rem; margin-top: 0.75rem; }
	.grades { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.625rem; }
	.grades:empty { display: none; }
	.grade { display: flex; align-items: baseline; gap: 0.5rem; }
	.grade-why { font-size: 0.8rem; color: var(--text-muted); }

	.waiting-on {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.25rem 0.625rem;
		margin-top: 0.625rem;
		font-size: 0.8rem;
	}
	.waiter { font-family: var(--font-mono); font-size: 0.75rem; overflow-wrap: anywhere; }
	.waiter-stage { color: var(--text-light); }

	.fields { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.625rem; }
	.field {
		font-family: var(--font-mono);
		font-size: 0.68rem;
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-light);
		overflow-wrap: anywhere;
	}
	.field.blocking { border-color: var(--danger); background: var(--danger-subtle); color: var(--danger); font-weight: 700; }

	.send-to {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		margin-left: auto;
	}
	.send-to .label { margin-right: 0; }
	.send-to select {
		padding: 0.3rem 0.4rem;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.send-to select.closes { border-color: var(--success); color: var(--success); }
	.send-to select.changed { border-color: var(--warning); }

	.note, .ask input, .row-answer select {
		font-family: inherit;
		font-size: 0.85rem;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.note {
		display: block;
		width: 100%;
		margin-top: 0.75rem;
		padding: 0.5rem 0.625rem;
		resize: vertical;
	}
	.note:focus, .ask input:focus, .row-answer select:focus, .send-to select:focus { outline: none; border-color: var(--primary); }
	.note-hint { font-size: 0.8rem; color: var(--danger); margin-top: 0.25rem; }
	.muted { font-size: 0.85rem; color: var(--text-muted); }

	.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.625rem; }
	.asked {
		font-size: 0.85rem;
		margin-top: 0.625rem;
		padding: 0.4rem 0.75rem;
		background: var(--info-subtle);
		border: 1px solid var(--info);
		border-radius: var(--radius);
	}
	.ask { display: flex; gap: 0.5rem; margin-top: 0.625rem; }
	.ask input { flex: 1; padding: 0.4rem 0.625rem; }

	.full-ticket {
		margin-top: 0.75rem;
		padding: 1rem 1.25rem;
		background: var(--surface-raised);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		max-height: 70vh;
		overflow-y: auto;
	}

	/* ── Rows ── */
	.rows {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.625rem 0.875rem;
	}
	.row + .row { border-top: 1px solid var(--border); }
	.row-main { flex: 1; min-width: 0; }
	.row-question { font-size: 0.9rem; font-weight: 600; line-height: 1.4; }
	.row-description { font-size: 0.8rem; color: var(--text-muted); }
	.row-answer {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.25rem 0.625rem;
		margin-top: 0.125rem;
		font-size: 0.85rem;
	}
	.row-answer select { padding: 0.1rem 0.25rem; font-size: 0.78rem; }
	.decision-note { font-style: italic; }
	.row-chips { display: flex; align-items: center; gap: 0.375rem; }
	.row-expanded { flex: 1 1 100%; padding-bottom: 0.375rem; }
	.problems {
		margin-top: 0.25rem;
		padding-left: 1.1rem;
		font-size: 0.75rem;
		color: var(--warning);
	}
</style>
