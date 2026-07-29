import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

// The two tokens the app writes into markdown that CommonMark knows nothing
// about:
//
//   @[Ada Lovelace](u1)   a mention — the exact token src/lib/mentions.ts uses
//   [[Billing migration]] a page link — what convex/pages.ts resolves into
//                          stored backlinks
//
// Without these rules markdown-it reads the first as an "@" followed by an
// ordinary link (href="u1", which goes nowhere) and the second as literal
// bracket text that the serializer then escapes to `\[\[…\]\]`. Either way an
// agent-authored token would be quietly destroyed the first time a person
// edited the page. These rules turn both into HTML the editor's schema
// recognizes, so they survive a full round trip.

const AT = 0x40; // @
const OPEN_BRACKET = 0x5b; // [
const CLOSE_PAREN = 0x29; // )

/** markdown-it's own escaper, reached without importing its internals twice. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mentionRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== AT) return false;
  if (state.src.charCodeAt(start + 1) !== OPEN_BRACKET) return false;

  const labelEnd = state.src.indexOf("](", start + 2);
  if (labelEnd < 0 || labelEnd >= state.posMax) return false;
  const label = state.src.slice(start + 2, labelEnd);
  // A label containing brackets means we've mis-paired with a later token.
  if (!label || /[[\]]/.test(label)) return false;

  let idEnd = labelEnd + 2;
  while (idEnd < state.posMax && state.src.charCodeAt(idEnd) !== CLOSE_PAREN) {
    idEnd += 1;
  }
  if (idEnd >= state.posMax) return false;
  const id = state.src.slice(labelEnd + 2, idEnd);
  if (!id || /\s/.test(id)) return false;

  if (!silent) {
    const token = state.push("page_mention", "", 0);
    token.meta = { id, label };
  }
  state.pos = idEnd + 1;
  return true;
}

function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== OPEN_BRACKET) return false;
  if (state.src.charCodeAt(start + 1) !== OPEN_BRACKET) return false;

  const close = state.src.indexOf("]]", start + 2);
  if (close < 0 || close >= state.posMax) return false;
  const title = state.src.slice(start + 2, close).trim();
  if (!title || /[[\]]/.test(title)) return false;

  if (!silent) {
    const token = state.push("page_wiki_link", "", 0);
    token.meta = { title };
  }
  state.pos = close + 2;
  return true;
}

/**
 * Installs both rules on a markdown-it instance.
 *
 * tiptap-markdown calls each extension's `parse.setup` on every parse, so this
 * is guarded — registering the same rule name twice leaves markdown-it with
 * two copies of it.
 */
export function installPageTokens(md: MarkdownIt): void {
  const flagged = md as MarkdownIt & { __pageTokens?: boolean };
  if (flagged.__pageTokens) return;
  flagged.__pageTokens = true;

  // Before "link" so `@[x](y)` is claimed as a mention rather than parsed as
  // a link with a stray "@" in front of it.
  md.inline.ruler.before("link", "page_mention", mentionRule);
  md.inline.ruler.before("link", "page_wiki_link", wikiLinkRule);

  md.renderer.rules.page_mention = (tokens, idx) => {
    const { id, label } = tokens[idx].meta as { id: string; label: string };
    return `<span data-type="mention" data-id="${escapeAttr(id)}" data-label="${escapeAttr(label)}">@${escapeAttr(label)}</span>`;
  };
  md.renderer.rules.page_wiki_link = (tokens, idx) => {
    const { title } = tokens[idx].meta as { title: string };
    const safe = escapeAttr(title);
    return `<span data-page-link="${safe}">${safe}</span>`;
  };
}
