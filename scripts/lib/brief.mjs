/**
 * The decision brief: the header fields that say, in a fixed shape, what a
 * `blocked/` ticket needs from a human, and the fields a human's answer is
 * written back into.
 *
 * A blocked ticket's prose already holds the proposal, the alternatives and the
 * cost of doing nothing (agent-rules/tickets.md § *Before you file a ticket*).
 * The brief restates that in fields a dashboard can render, sort and batch, so
 * the ticket stays the only place the question and its answer are recorded:
 *
 *   needs: decision               decision | action | observation | upstream
 *   question: May a failed preview read stop a customer from cancelling?
 *   options:
 *     - A: Let them confirm anyway; say the history check could not run. → implement
 *     - B: Keep the block as it is and close this. → complete
 *   recommend: A — cancelling is the customer's way out.
 *   if-nothing: Today's block goes live with the next promotion.
 *   reversible: yes — one condition, one sentence, one test assertion.
 *   confidence: high
 *   checked: 2026-11-23
 *
 * An option's `→ stage` says where the ticket goes if that option is chosen;
 * `then: <stage>` says it for every answer that names none (`destinationFor`).
 *
 * Once a human has answered, the dashboard writes these and moves the ticket
 * to that stage in the same commit (lib/inbox.mjs), so `blocked/` only ever
 * holds what still waits on a human:
 *
 *   decision: A
 *   decision-note: Paige words the sentence.
 *   decided: Nate, 2026-11-23
 *
 * `ask:` holds a question the human sent back instead of an answer; the distill
 * pass (scripts/distill.mjs) answers it by revising the brief.
 *
 * Everything here is pure over ticket text.  What waits on a ticket and how
 * long it has sat in `blocked/` are derived, not stored: lib/inbox.mjs.
 */

import { fieldRunEnd, headerField, parseListField, trustedHeader, trustedHeaderBounds } from './tickets.mjs';

/** What a blocked ticket can need from a human. */
export const NEEDS = ['decision', 'action', 'observation', 'upstream'];
/** How hard the recommended answer is to take back. */
export const REVERSIBLE = ['yes', 'costly', 'no'];
/** How sure the filing agent is of its own recommendation. */
export const CONFIDENCE = ['high', 'low'];

/**
 * The stages an answered ticket can be sent to.  `backlog` may name a release
 * folder (`backlog/GA`); whether that folder is a listed release is checked
 * when the ticket is moved (lib/inbox.mjs), not here.
 */
export const DESTINATION_STAGES = ['fix', 'plan', 'implement', 'review', 'complete', 'backlog'];

/** The fields an agent writes: the brief proper. */
export const BRIEF_FIELDS = ['needs', 'question', 'options', 'recommend', 'if-nothing', 'then', 'reversible', 'confidence', 'checked'];
/** The fields a human's answer is written into. */
export const ANSWER_FIELDS = ['decision', 'decision-note', 'decided'];
/** A question sent back to the distill pass instead of an answer. */
export const ASK_FIELD = 'ask';

/** `decision:` values with a meaning of their own, beside an option key. */
export const DECISION_OTHER = 'other';   // the answer is the note, not a listed option
export const DECISION_DONE = 'done';     // the human performed the step, or made the observation
const RESERVED_DECISIONS = [DECISION_OTHER, DECISION_DONE];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPTION_KEY_RE = /^[A-Za-z0-9]{1,12}$/;

/** `A — why` / `yes - why` / `high` as `{ head, why }`: the first word, and whatever follows a dash or colon. */
function headAndWhy(value) {
	if (!value) return null;
	const match = value.match(/^([A-Za-z0-9]+)[\s:,.—–-]*(.*)$/);
	if (!match) return null;
	return { head: match[1], why: match[2].trim() };
}

/**
 * A destination as written — `implement`, `Complete`, `backlog/GA` — in its
 * canonical spelling (stage lowercased, a release folder kept as written), or
 * null when it names no stage an answered ticket can be sent to.
 */
export function parseDestination(value) {
	const match = String(value ?? '').trim().match(/^([A-Za-z]+)(?:\/([A-Za-z0-9]+))?\/?$/);
	if (!match) return null;
	const stage = match[1].toLowerCase();
	if (!DESTINATION_STAGES.includes(stage) || (match[2] && stage !== 'backlog')) return null;
	return match[2] ? `${stage}/${match[2]}` : stage;
}

/** An option's trailing `→ stage` (or `->`), which says where the ticket goes if that option is chosen. */
const OPTION_DESTINATION_RE = /\s*(?:→|->|=>)\s*(\S+?)\.?\s*$/;

/**
 * The `options:` list as `{ key, text, to }`.  An item is `KEY: text`, the key
 * a short alphanumeric token; an item with no key takes the first letter no
 * other option uses, so a brief written as plain sentences still gets
 * choosable options and no two options ever answer to the same key.  `to` is
 * the destination a trailing `→ stage` names, or null; an arrow followed by
 * anything that is not a destination is left in the text as prose.
 */
function parseOptions(header) {
	const parsed = parseListField(header, 'options').map(item => {
		const arrow = item.match(OPTION_DESTINATION_RE);
		const to = arrow ? parseDestination(arrow[1]) : null;
		const body = to ? item.slice(0, arrow.index).trim() : item;
		const colon = body.indexOf(':');
		const key = colon === -1 ? '' : body.slice(0, colon).trim();
		return OPTION_KEY_RE.test(key) ? { key, text: body.slice(colon + 1).trim(), to } : { key: null, text: body, to };
	});
	const taken = new Set(parsed.map(o => o.key?.toLowerCase()));
	let next = 0;
	for (const option of parsed) {
		if (option.key != null) continue;
		while (taken.has(String.fromCharCode(97 + next))) next++;
		option.key = String.fromCharCode(65 + next);
		taken.add(option.key.toLowerCase());
	}
	return parsed;
}

/**
 * Parse a ticket's brief and answer fields.  Every field is null (or `[]`)
 * when absent or empty; values are kept as written, so an unrecognised
 * `needs:` is reported by `briefProblems` rather than silently dropped.  Read
 * from the trusted part of the header only (lib/tickets.mjs
 * `trustedHeaderBounds`), so prose in an unfenced ticket is never an answer.
 */
export function parseBrief(content) {
	const header = trustedHeader(content);
	const text = name => headerField(header, name) || null;
	const graded = name => {
		const parsed = headAndWhy(text(name));
		return parsed && { level: parsed.head.toLowerCase(), why: parsed.why };
	};
	const recommend = headAndWhy(text('recommend'));
	return {
		needs: text('needs')?.toLowerCase() ?? null,
		question: text('question'),
		options: parseOptions(header),
		recommend: recommend && { key: recommend.head, why: recommend.why },
		ifNothing: text('if-nothing'),
		then: text('then'),
		reversible: graded('reversible'),
		confidence: graded('confidence'),
		checked: text('checked'),
		decision: text('decision'),
		decisionNote: text('decision-note'),
		decided: text('decided'),
		ask: text(ASK_FIELD),
	};
}

/** The option a key names, compared without case, or null. */
export function optionFor(brief, key) {
	if (!key) return null;
	return brief.options.find(o => o.key.toLowerCase() === key.toLowerCase()) ?? null;
}

/**
 * What a brief lacks, as a list of plain statements — empty when a dashboard
 * can render the ticket as a card without reading its body.  A ticket with
 * problems is *undistilled*: the distill pass picks it up.
 *
 * Only a `decision` needs options and a recommendation; an `action`, an
 * `observation` or an `upstream` wait is described by its `question:` line
 * (what to do, what to look at, what is awaited) and its steps stay in the body.
 */
export function briefProblems(brief) {
	const problems = [];
	if (!brief.needs) problems.push('no needs: field');
	else if (!NEEDS.includes(brief.needs)) problems.push(`needs: ${brief.needs} is not one of ${NEEDS.join(', ')}`);
	if (!brief.question) problems.push('no question: field');
	if (!brief.checked) problems.push('no checked: date');
	else if (!DATE_RE.test(brief.checked)) problems.push(`checked: ${brief.checked} is not a YYYY-MM-DD date`);
	if (brief.then && !parseDestination(brief.then)) problems.push(`then: ${brief.then} is not one of ${DESTINATION_STAGES.join(', ')} (or backlog/<CODE>)`);

	if (brief.needs === 'decision') {
		if (brief.options.length < 2) problems.push('a decision needs at least two options:');
		for (const { key } of brief.options) {
			if (RESERVED_DECISIONS.includes(key.toLowerCase())) problems.push(`option key ${key} is reserved for an answer that names no option — use a letter`);
		}
		if (!brief.recommend) problems.push('no recommend: field');
		else if (brief.options.length > 0 && !optionFor(brief, brief.recommend.key)) {
			problems.push(`recommend: ${brief.recommend.key} names no option`);
		}
		if (!brief.ifNothing) problems.push('no if-nothing: field');
		for (const [name, graded, allowed] of [['reversible', brief.reversible, REVERSIBLE], ['confidence', brief.confidence, CONFIDENCE]]) {
			if (!graded) problems.push(`no ${name}: field`);
			else if (!allowed.includes(graded.level)) problems.push(`${name}: ${graded.level} is not one of ${allowed.join(', ')}`);
		}
	}
	return problems;
}

/**
 * Where a ticket goes once it is answered with `decision`, most specific
 * source first: the chosen option's own `→ stage`, then the brief's `then:`,
 * then the default — `fix` for a `bug-` slug, otherwise `plan`, the two stages
 * whose job is to turn a settled question into implement tickets.  An agent
 * names a destination when it knows better: a ticket that was already being
 * implemented when it was blocked goes back to `implement`, and an option
 * that leaves nothing to do goes to `complete`.
 */
export function destinationFor(brief, decision, slug) {
	// `other` and `done` are answers in their own right, never an option's key (`briefProblems` says so).
	const option = RESERVED_DECISIONS.includes(String(decision ?? '').toLowerCase()) ? null : optionFor(brief, decision);
	return option?.to
		?? parseDestination(brief.then)
		?? (slug.startsWith('bug-') ? 'fix' : 'plan');
}

/** The dashboard's lanes, in the order it shows them. */
export const LANES = ['batch', 'think', 'do', 'waiting', 'undistilled', 'decided'];

/**
 * Which lane a blocked ticket sits in:
 *
 *   decided      a human has answered; the runner applies it on its next pass
 *   undistilled  the brief is missing or incomplete; nothing to render yet
 *   waiting      an upstream dependency; nothing for the human to do
 *   do           a step or an observation only the human can supply
 *   batch        a decision that is cheap to take back and confidently recommended
 *   think        every other decision: costly or irreversible, or the agent is unsure
 *
 * `problems` is `briefProblems(brief)`, passed in by a caller that already has it.
 */
export function laneOf(brief, problems = briefProblems(brief)) {
	if (brief.decision) return 'decided';
	if (problems.length > 0) return 'undistilled';
	if (brief.needs === 'upstream') return 'waiting';
	if (brief.needs === 'action' || brief.needs === 'observation') return 'do';
	return brief.reversible.level === 'yes' && brief.confidence.level === 'high' ? 'batch' : 'think';
}

const oneLine = value => String(value).replace(/\s*\r?\n\s*/g, ' ').trim();

/**
 * Return `content` with header fields set or removed.  `updates` maps a field
 * name to a string (a single-line field), an array (an indented `- item`
 * list), or null (remove the field).  A field already present is replaced
 * where it stands; a new one joins the run of fields at the top of the header
 * — not its end, which in an unfenced ticket can be deep in the prose.
 * Everything else — the fence shape, the other fields, the body, the file's
 * line endings — is left byte-for-byte as it was.  Only the trusted part of
 * the header is searched, so a prose line that begins with a field's name is
 * never taken for the field and removed.
 */
export function setHeaderFields(content, updates) {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const { lines, start, end } = trustedHeaderBounds(content);
	const header = lines.slice(start, end);

	for (const [name, value] of Object.entries(updates)) {
		// `[ \t]` written literally: see `headerFieldLines` in lib/tickets.mjs.
		const field = new RegExp(`^${name}:[ \t]*(.*)$`, 'i');
		let at = -1;
		for (let i = header.findIndex(line => field.test(line)); i !== -1; i = header.findIndex(line => field.test(line))) {
			// An empty field owns the indented list items under it; a field with a value owns only its line.
			let count = 1;
			if (header[i].match(field)[1].trim() === '') {
				while (i + count < header.length && /^[ \t]+-/.test(header[i + count])) count++;
			}
			header.splice(i, count);
			if (at === -1) at = i;
		}
		if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
		const written = Array.isArray(value)
			? [`${name}:`, ...value.map(item => `  - ${oneLine(item)}`)]
			: [`${name}: ${oneLine(value)}`];
		header.splice(at === -1 ? fieldRunEnd(header, 0, header.length) : at, 0, ...written);
	}

	return [...lines.slice(0, start), ...header, ...lines.slice(end)].join(eol);
}

/**
 * Every single-line header field of a ticket that is not part of the brief or
 * the answer, as `name → value` in file order — what a project keeps in the
 * header for its own tools (`blocks-deploy: true`), shown beside the brief so
 * nothing the project considers urgent is hidden by the card.  List-valued
 * fields report an empty string; `exclude` names further fields to leave out.
 */
export function otherHeaderFields(content, exclude = []) {
	const skip = new Set([...BRIEF_FIELDS, ...ANSWER_FIELDS, ASK_FIELD, ...exclude].map(name => name.toLowerCase()));
	const { lines, start, end } = trustedHeaderBounds(content);
	const fields = {};
	for (const line of lines.slice(start, end)) {
		const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/);
		if (!match) continue;
		const name = match[1].toLowerCase();
		if (!skip.has(name) && !(name in fields)) fields[name] = match[2].trim();
	}
	return fields;
}
