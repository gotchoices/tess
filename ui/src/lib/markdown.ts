/**
 * A small markdown renderer for ticket bodies, which are written one paragraph
 * per line.  The source is HTML-escaped before anything else looks at it, so
 * every tag in the output is one this file wrote; the patterns below therefore
 * match escaped text (a blockquote marker is `&gt;`, not `>`).
 *
 * Supported: `#`–`######` headings, paragraphs, `-`/`*`/`+` and `1.` lists
 * (nested by indentation, with `[ ]`/`[x]` task markers), fenced code blocks,
 * inline code, `**bold**`, `*italic*`, `[text](http(s)://…)` links, `>`
 * blockquotes, `---` rules and pipe tables.  Anything else stays text —
 * including a link to any other scheme, and raw HTML.
 */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Render markdown to HTML that is safe to place with `{@html}`. */
export function renderMarkdown(src: string): string {
	// NUL delimits the inline placeholders below, so none may come in with the source.
	return renderBlocks(escapeHtml(src.replace(/\u0000/g, '')).split(/\r?\n/), 0);
}

// ─── Inline ──────────────────────────────────────────────────────────────────

const CODE_SPAN_RE = /(?<![\\`])(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const BACKSLASH_ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|])/g;
// The URL may hold one level of balanced parentheses; `&` arrives as `&amp;`, which is what an href wants.
const LINK_RE = /\[([^[\]]+)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g;
const HELD_RE = /\u0000(\d+)\u0000/g;

function emphasis(text: string): string {
	return text
		.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
		.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
		.replace(/(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?![\w*])/g, '<em>$1</em>');
}

function renderInline(text: string): string {
	// Code spans, escaped characters and links are set aside as placeholders, so
	// the emphasis pass cannot read markup into a URL or a piece of code.
	const held: string[] = [];
	const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
	const restore = (html: string): string => html.replace(HELD_RE, (_, index) => restore(held[Number(index)]));

	const marked = text
		.replace(CODE_SPAN_RE, (_, _ticks, code: string) => hold(`<code>${code.trim()}</code>`))
		.replace(BACKSLASH_ESCAPE_RE, (_, ch: string) => hold(ch))
		.replace(LINK_RE, (_, label: string, url: string) =>
			hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`));
	return restore(emphasis(marked));
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

// A backtick fence's info string holds no backtick, which keeps a line of inline code from opening a block.
const FENCE_RE = /^([ \t]*)(?:(`{3,})[^`]*|(~{3,}).*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}&gt; ?/;
const ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/;
const TABLE_RULE_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TASK_RE = /^\[([ xX])\][ \t]+/;

// Deeper nesting than this is rendered as text rather than recursed into.
const MAX_DEPTH = 8;

interface Taken {
	html: string;
	/** Index of the first line after the block. */
	next: number;
}

const isBlank = (line: string) => line.trim() === '';

/** Leading whitespace as a column count, a tab being four. */
function indentWidth(line: string): number {
	return line.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;
}

/** `line` without up to `width` columns of leading whitespace. */
function stripIndent(line: string, width: number): string {
	let i = 0;
	for (let column = 0; i < line.length && column < width; i++) {
		if (line[i] === ' ') column += 1;
		else if (line[i] === '\t') column += 4;
		else break;
	}
	return line.slice(i);
}

function takeFence(lines: string[], i: number): Taken | null {
	const open = lines[i].match(FENCE_RE);
	if (!open) return null;
	const marker = open[2] ?? open[3];
	const close = new RegExp(`^[ \\t]*${marker[0]}{${marker.length},}[ \\t]*$`);
	const indent = indentWidth(lines[i]);
	const body: string[] = [];
	let j = i + 1;
	for (; j < lines.length && !close.test(lines[j]); j++) body.push(stripIndent(lines[j], indent));
	// An unclosed fence runs to the end, as it does everywhere else markdown is rendered.
	return { html: `<pre><code>${body.join('\n')}</code></pre>`, next: Math.min(j + 1, lines.length) };
}

/** A table row's cells: split on `|`, a `\|` being a literal pipe. */
function splitRow(line: string): string[] {
	const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
	return inner.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

/** A table starts where a row with a pipe sits over a `---|---` line of as many cells. */
function isTableStart(lines: string[], i: number): boolean {
	return i + 1 < lines.length && lines[i].includes('|') && TABLE_RULE_RE.test(lines[i + 1])
		&& splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

function takeTable(lines: string[], i: number): Taken | null {
	if (!isTableStart(lines, i)) return null;
	const head = splitRow(lines[i]);
	const rule = splitRow(lines[i + 1]);

	const aligns = rule.map(cell => (cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : cell.startsWith(':') ? 'left' : null));
	const cells = (row: string[], tag: 'th' | 'td') => head
		.map((_, column) => {
			const align = aligns[column] ? ` style="text-align:${aligns[column]}"` : '';
			return `<${tag}${align}>${renderInline(row[column] ?? '')}</${tag}>`;
		})
		.join('');

	const body: string[] = [];
	let j = i + 2;
	for (; j < lines.length && !isBlank(lines[j]) && lines[j].includes('|'); j++) {
		body.push(`<tr>${cells(splitRow(lines[j]), 'td')}</tr>`);
	}
	const html = `<div class="table-wrap"><table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`;
	return { html, next: j };
}

function takeQuote(lines: string[], i: number, depth: number): Taken | null {
	if (!QUOTE_RE.test(lines[i])) return null;
	const inner: string[] = [];
	let j = i;
	for (; j < lines.length && QUOTE_RE.test(lines[j]); j++) inner.push(lines[j].replace(QUOTE_RE, ''));
	return { html: `<blockquote>${renderBlocks(inner, depth + 1)}</blockquote>`, next: j };
}

/**
 * A list: consecutive items at one indentation and of one kind.  An item owns
 * the lines indented deeper than its marker — a nested list, a second
 * paragraph, a code block — which are rendered as blocks of their own.
 */
function takeList(lines: string[], i: number, depth: number): Taken | null {
	const first = lines[i].match(ITEM_RE);
	if (!first) return null;
	const base = indentWidth(lines[i]);
	const isOrdered = (marker: string) => /\d/.test(marker);
	const ordered = isOrdered(first[2]);
	const sibling = (index: number) => {
		const item = index < lines.length ? lines[index].match(ITEM_RE) : null;
		return item && indentWidth(lines[index]) === base && isOrdered(item[2]) === ordered ? item : null;
	};
	const nextNonBlank = (index: number) => {
		while (index < lines.length && isBlank(lines[index])) index++;
		return index;
	};

	const items: string[] = [];
	let j = i;
	for (let item = sibling(j); item; item = sibling(j)) {
		const text = item[3].replace(TASK_RE, (_, mark: string) => (mark === ' ' ? '☐ ' : '☑ '));
		const owned: string[] = [];
		for (j++; j < lines.length; j++) {
			if (isBlank(lines[j])) {
				// A blank line stays in the item only when what follows it is still indented under the marker.
				const after = nextNonBlank(j);
				if (after === lines.length || indentWidth(lines[after]) <= base) break;
			} else if (indentWidth(lines[j]) <= base) {
				break;
			}
			owned.push(lines[j]);
		}
		const ownedIndent = Math.min(...owned.filter(line => !isBlank(line)).map(indentWidth));
		const content = [text, ...owned.map(line => stripIndent(line, ownedIndent))];
		items.push(`<li>${renderBlocks(content, depth + 1)}</li>`);

		// Blank lines between two items of the same list do not end it.
		const after = nextNonBlank(j);
		if (after > j && sibling(after)) j = after;
	}

	const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : '';
	const tag = ordered ? 'ol' : 'ul';
	return { html: `<${tag}${start}>${items.join('')}</${tag}>`, next: j };
}

function takeHeading(lines: string[], i: number): Taken | null {
	const heading = lines[i].match(HEADING_RE);
	if (!heading) return null;
	const level = heading[1].length;
	return { html: `<h${level}>${renderInline(heading[2])}</h${level}>`, next: i + 1 };
}

function takeRule(lines: string[], i: number): Taken | null {
	return RULE_RE.test(lines[i]) ? { html: '<hr>', next: i + 1 } : null;
}

/** The block that starts at line `i`, when one does; a paragraph is whatever is left. */
function takeBlock(lines: string[], i: number, depth: number): Taken | null {
	return takeFence(lines, i)
		?? takeHeading(lines, i)
		?? takeRule(lines, i)   // before lists: `- - -` and `* * *` are rules
		?? takeQuote(lines, i, depth)
		?? takeList(lines, i, depth)
		?? takeTable(lines, i);
}

/** Whether a block other than a paragraph starts at line `i`: what ends the paragraph above it. */
function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i];
	return FENCE_RE.test(line) || HEADING_RE.test(line) || RULE_RE.test(line) || QUOTE_RE.test(line) || ITEM_RE.test(line)
		|| isTableStart(lines, i);
}

function renderBlocks(lines: string[], depth: number): string {
	if (depth > MAX_DEPTH) return `<p>${lines.map(renderInline).join('<br>')}</p>`;
	const out: string[] = [];
	for (let i = 0; i < lines.length;) {
		if (isBlank(lines[i])) {
			i++;
			continue;
		}
		const block = takeBlock(lines, i, depth);
		if (block) {
			out.push(block.html);
			i = block.next;
			continue;
		}
		// Bodies are not hard-wrapped, so a line break inside a paragraph was meant as one.
		const paragraph = [lines[i++]];
		while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) paragraph.push(lines[i++]);
		out.push(`<p>${paragraph.map(line => renderInline(line.trim())).join('<br>')}</p>`);
	}
	return out.join('\n');
}
