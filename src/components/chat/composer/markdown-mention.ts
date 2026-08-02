// Reading `@[Name](actorId)` back out of markdown.
//
// The serializer is only half a round trip. Without a parse rule, markdown-it
// reads the token as an "@" followed by an ordinary link whose href is a Clerk
// id — and the serializer then writes that back as `@\[Name\](id)`, because
// prosemirror-markdown escapes `[` in text. The mention stops being a mention
// the first time a draft is restored or a message is opened for editing, and
// nothing says so: the text still *reads* right.
//
// That is the rule this codebase already learned on the Pages editor — a
// construct that cannot round-trip is a construct that deletes data — applied
// to the one token Chat shares with the rest of the product.
//
// **Why this is not `installPageTokens`.** That function installs two rules,
// and the second one claims `[[Anything In Brackets]]` for a page-link node the
// chat schema does not have. An unknown node is dropped on parse, so borrowing
// it wholesale would delete `[[wip]]` out of somebody's message. The mention
// rule is ~20 lines; a shared function that is wrong for one of its two callers
// is worse than two right ones.

import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

const AT = 0x40; // @
const OPEN_BRACKET = 0x5b; // [
const CLOSE_PAREN = 0x29; // )

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
  // Brackets inside the label mean we mis-paired with a later token.
  if (!label || /[[\]]/.test(label)) return false;

  let idEnd = labelEnd + 2;
  while (idEnd < state.posMax && state.src.charCodeAt(idEnd) !== CLOSE_PAREN) {
    idEnd += 1;
  }
  if (idEnd >= state.posMax) return false;
  const id = state.src.slice(labelEnd + 2, idEnd);
  // An id with whitespace in it is a link somebody wrote, not an actor.
  if (!id || /\s/.test(id)) return false;

  if (!silent) {
    const token = state.push("chat_mention", "", 0);
    token.meta = { id, label };
  }
  state.pos = idEnd + 1;
  return true;
}

/**
 * Install the rule on a markdown-it instance.
 *
 * tiptap-markdown runs each extension's `parse.setup` on every parse, so this
 * is guarded: registering the same rule name twice leaves markdown-it holding
 * two copies of it.
 */
export function installChatMentionToken(md: MarkdownIt): void {
  const flagged = md as MarkdownIt & { __chatMentionToken?: boolean };
  if (flagged.__chatMentionToken) return;
  flagged.__chatMentionToken = true;

  // Before "link", so `@[x](y)` is claimed as a mention rather than parsed as a
  // link with a stray "@" in front of it.
  md.inline.ruler.before("link", "chat_mention", mentionRule);

  // The shape Tiptap's Mention node parses back — one span, attributes only.
  md.renderer.rules.chat_mention = (tokens, idx) => {
    const { id, label } = tokens[idx].meta as { id: string; label: string };
    return `<span data-type="mention" data-id="${escapeAttr(id)}" data-label="${escapeAttr(label)}">@${escapeAttr(label)}</span>`;
  };
}
