"use client";

// The composer's schema.
//
// Same rule as the Pages editor, and for the same reason: **the body is
// markdown; Tiptap is only the surface.** Every keystroke is serialized back
// with `editor.storage.markdown.getMarkdown()` and that string is what
// `buzz/messages:post` stores — so an agent writing `**shipped**` over MCP and
// a person pressing ⌘B are producing the same bytes, and the transcript has one
// thing to render.
//
// Which means the constraint is inherited too: *a block that cannot round-trip
// is a block that deletes data*. Headings and horizontal rules have no button
// here — nobody writes an H1 in a chat message — but they stay in the schema,
// because a body that arrives containing `## Plan` must survive being loaded
// into this editor and written back out. Dropping them from the schema would
// not remove the syntax from the world, it would remove it from somebody's
// message.
//
// Mentions are the app's one grammar, `@[Name](actorId)` (`src/lib/mentions.ts`).
// Not a second one for chat: mentions are parsed server-side out of message
// bodies, and a chat-only spelling would be a mention that notifies nobody.

import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import { Extension, type AnyExtension, type Editor } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import { Markdown } from "tiptap-markdown";
import { createSuggestionRenderer, type MenuSection } from "@/components/dashboard/page-editor/suggestion-menu";
import { installChatMentionToken } from "./markdown-mention";

/** Somebody the composer can address: a teammate or an agent. */
export type ComposerMentionable = {
  id: string;
  name: string;
  kind: "user" | "agent";
};

/**
 * Its own plugin key.
 *
 * `Suggestion` defaults to `PluginKey("suggestion")` and ProseMirror throws on
 * construction when two plugins share one — the failure is the whole editor
 * refusing to mount, which is how the Pages editor found this the first time.
 * One suggestion lives here today; naming it now costs nothing and means the
 * second one cannot land as a crash.
 */
export const CHAT_MENTION_KEY = new PluginKey("chatMention");

/**
 * The app's token, in both directions.
 *
 * Serializing alone is half a round trip. Without the parse rule, a restored
 * draft reads `@[Ada](u_1)` as an "@" followed by an ordinary link, and the
 * next serialization escapes the bracket — the mention stops being a mention
 * while still looking like one, which is the quietest way this editor could
 * lose data. Both halves belong to the node that owns the token.
 */
const ChatMention = Mention.extend({
  addStorage() {
    return {
      markdown: {
        parse: { setup: installChatMentionToken },
        serialize(
          state: { write: (text: string) => void },
          node: { attrs: { id?: string; label?: string } },
        ) {
          state.write(`@[${node.attrs.label ?? "Someone"}](${node.attrs.id ?? ""})`);
        },
      },
    };
  },
});

/**
 * Enter sends, Shift-Enter breaks the line.
 *
 * The guard is the interesting part. When a suggestion menu is open, Enter
 * belongs to the menu — and *which* handler ProseMirror consults first depends
 * on plugin order, which is an implementation detail of two libraries and not
 * something the send key should be wagered on. So the composer tells this
 * extension whether a menu is open and it declines outright. Deterministic,
 * and it stays true if the extension list is ever reordered.
 */
const SendOnEnter = Extension.create<{
  onSend: () => boolean;
  isMenuOpen: () => boolean;
}>({
  name: "chatSendOnEnter",
  addOptions() {
    return { onSend: () => false, isMenuOpen: () => false };
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (this.options.isMenuOpen()) return false;
        return this.options.onSend();
      },
      // Both spellings of "new line, don't send", because muscle memory
      // differs and neither is wrong.
      "Shift-Enter": ({ editor }) => editor.commands.setHardBreak(),
      "Mod-Enter": () => {
        if (this.options.isMenuOpen()) return false;
        return this.options.onSend();
      },
    };
  },
});

/** Whether a suggestion popup currently owns the keyboard. */
export type MenuFlag = { open: boolean };

/**
 * The shared suggestion renderer, wrapped so the composer can see it open.
 *
 * Wrapped rather than reimplemented: the popup, the ↑/↓/Enter/Esc contract and
 * the caret positioning are already decided in
 * `page-editor/suggestion-menu.tsx`, and a second keyboard contract in the same
 * application is how Enter comes to mean two different things.
 */
function trackedRenderer<T>(
  config: { emptyLabel: string; buildSections: (query: string) => MenuSection<T>[] },
  flag: MenuFlag,
) {
  const make = createSuggestionRenderer<T>(config);
  return () => {
    const inner = make();
    return {
      ...inner,
      onStart(props: Parameters<ReturnType<typeof make>["onStart"]>[0]) {
        flag.open = true;
        inner.onStart(props);
      },
      onKeyDown(props: { event: KeyboardEvent }) {
        const handled = inner.onKeyDown(props);
        // Escape dismisses the popup while the suggestion plugin stays active
        // (it keeps matching until the caret leaves the token). From that
        // moment Enter is the composer's again, so the flag has to fall here
        // and not wait for `onExit`.
        if (props.event.key === "Escape" && handled) flag.open = false;
        return handled;
      },
      onExit() {
        flag.open = false;
        inner.onExit();
      },
    };
  };
}

export function buildComposerExtensions(opts: {
  placeholder: string;
  /** Read through a ref by the caller: the list changes, the schema is built once. */
  mentionables: () => ComposerMentionable[];
  onSend: () => boolean;
  menuFlag: MenuFlag;
}): AnyExtension[] {
  const suggestion = {
    char: "@",
    pluginKey: CHAT_MENTION_KEY,
    items: ({ query }: { query: string }) => matchMentions(opts.mentionables(), query),
    render: trackedRenderer<ComposerMentionable>(
      {
        emptyLabel: "Nobody by that name in this community.",
        buildSections: (query) => {
          const matches = matchMentions(opts.mentionables(), query);
          return [
            {
              heading: "People",
              rows: matches
                .filter((m) => m.kind === "user")
                .map((m) => ({ key: m.id, label: m.name, value: m })),
            },
            {
              // Agents are members, not a separate address book — but the room
              // still says which is which before you address one.
              heading: "Agents",
              rows: matches
                .filter((m) => m.kind === "agent")
                .map((m) => ({ key: m.id, label: m.name, meta: "agent", value: m })),
            },
          ];
        },
      },
      opts.menuFlag,
    ),
    command: ({
      editor,
      range,
      props,
    }: {
      editor: Editor;
      range: { from: number; to: number };
      props: ComposerMentionable;
    }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: { id: props.id, label: props.name } },
          { type: "text", text: " " },
        ])
        .run();
    },
  };

  return [
    StarterKit.configure({
      // Kept in the schema, kept off the toolbar — see the header comment.
      heading: { levels: [1, 2, 3] },
      codeBlock: { HTMLAttributes: { class: "chat-code-block" } },
    }),
    Markdown.configure({
      html: false,
      linkify: true,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ["http", "https", "mailto"],
      HTMLAttributes: { rel: "noopener noreferrer" },
    }),
    Placeholder.configure({
      placeholder: opts.placeholder,
      showOnlyWhenEditable: true,
    }),
    ChatMention.configure({
      HTMLAttributes: { class: "chat-mention" },
      suggestion: suggestion as never,
    }),
    SendOnEnter.configure({ onSend: opts.onSend, isMenuOpen: () => opts.menuFlag.open }),
  ] as AnyExtension[];
}

function matchMentions(all: ComposerMentionable[], query: string): ComposerMentionable[] {
  const needle = query.toLowerCase();
  return all.filter((m) => m.name.toLowerCase().includes(needle)).slice(0, 8);
}
