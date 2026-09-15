/**
 * Project rules addenda: `tickets/rules/*.md`.
 *
 * A project adds its own ticket rules to every agent prompt, and declares
 * extra anchor header fields, without editing tess.  Each `.md` file directly
 * inside `tickets/rules/` is one addendum, taken in code-unit filename order.
 *
 * A file declares something only when its first line is a fence: the header
 * then runs to the next fence, by the same fence rules as a ticket header, and
 * the body is everything after it.  With no opening fence the whole file is
 * body.  (A ticket's unfenced-header rule would read an addendum's leading
 * prose as fields.)  The one header field tess reads is `anchor-fields:`; any
 * other field is left to other tools.
 *
 * Anchors are opt-in.  A board requires every worked ticket to name one only
 * once some addendum lists at least one field under `anchor-fields:` — that
 * is how rubric's init turns the rule on, and `anchor-fields: architecture`
 * is how a project with no other spec turns it on with tess's own field
 * alone.  A project with no addenda, or none that lists a field, never sees
 * an anchor problem: `architecture:` is then just a header field agents may
 * fill.
 *
 * A body may carry the same `<!-- stage:NAME -->` blocks as
 * agent-rules/tickets.md; the prompt builders filter them
 * (lib/prompt.mjs `projectRuleSections`).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { byName, headerBounds, parseListField } from './tickets.mjs';

/** Addenda folder, relative to the tickets directory. */
export const RULES_DIR = 'rules';

/** The anchor field tess owns; projects declare the rest, or list this one alone to opt in. */
export const TESS_ANCHOR_FIELD = 'architecture';

/** How errors name the folder — the runner always works on `<repo>/tickets`. */
const DISPLAY_DIR = `tickets/${RULES_DIR}`;
const FIELD_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Parse one addendum.  Returns `{ rule: { name, body, anchorFields }, errors }`.
 * A rule with errors is still returned with what could be read; the board
 * check decides what the errors mean.  Line endings are normalised to LF and a
 * byte-order mark is dropped, so the fence on line 1 is found either way.
 */
export function parseProjectRule(name, text) {
	const path = `${DISPLAY_DIR}/${name}`;
	const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
	const { lines, opened, start, end, closed } = headerBounds(normalized);

	if (!opened) return { rule: { name, body: normalized, anchorFields: [] }, errors: [] };
	if (!closed) {
		return {
			rule: { name, body: '', anchorFields: [] },
			errors: [`${path}: unterminated header — line 1 is a fence with no closing fence, so the file appends and declares nothing`],
		};
	}

	const errors = [];
	const anchorFields = [];
	for (const field of parseListField(lines.slice(start, end).join('\n'), 'anchor-fields')) {
		if (!FIELD_NAME_RE.test(field)) {
			errors.push(`${path}: anchor-fields: "${field}" is not a field name — use a lowercase letter followed by lowercase letters, digits or hyphens`);
		} else {
			anchorFields.push(field);
		}
	}
	return { rule: { name, body: lines.slice(end + 1).join('\n'), anchorFields }, errors };
}

/**
 * Read every addendum.  Returns `{ rules, errors }`, rules in code-unit
 * filename order.  No folder → no rules and no errors.
 */
export async function readProjectRules(ticketsDir) {
	const dir = join(ticketsDir, RULES_DIR);
	let dirents;
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (err.code === 'ENOENT') return { rules: [], errors: [] };
		if (err.code === 'ENOTDIR') return { rules: [], errors: [`${DISPLAY_DIR} is a file — project rules are .md files inside a ${DISPLAY_DIR}/ folder`] };
		throw err;
	}

	const rules = [];
	const errors = [];
	for (const name of dirents.filter(d => !d.isDirectory() && d.name.endsWith('.md')).map(d => d.name).sort(byName)) {
		let text;
		try {
			text = await readFile(join(dir, name), 'utf-8');
		} catch (err) {
			if (err.code === 'ENOENT') continue;  // raced with a remove
			throw err;
		}
		const parsed = parseProjectRule(name, text);
		rules.push(parsed.rule);
		errors.push(...parsed.errors);
	}
	return { rules, errors };
}

/** Every header field that counts as an anchor: `architecture`, then each declared field in file order, de-duplicated. */
export function anchorFieldsOf(rules) {
	return [...new Set([TESS_ANCHOR_FIELD, ...rules.flatMap(r => r.anchorFields)])];
}

/** True once any addendum lists at least one field under `anchor-fields:` — the board then requires an anchor on every worked ticket. */
export function anchorsRequiredBy(rules) {
	return rules.some(r => r.anchorFields.length > 0);
}
