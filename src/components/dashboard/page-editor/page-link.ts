"use client";

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import type { Editor, Range } from "@tiptap/core";
import { installPageTokens } from "./markdown-tokens";

// `[[Page title]]` — the app's internal link.
//
// It has to be a real node rather than plain bracket text, even though the
// stored form is plain markdown: prosemirror-markdown escapes `[` and `]` in
// text, so a hand-typed `[[Billing migration]]` would come back out of the
// editor as `\[\[Billing migration\]\]` and stop resolving. Owning the node
// means owning its serialization, which is what keeps the stored bytes the
// same ones convex/pages.ts already understands.
//
// The node also owns how the link *behaves*: a link you can write but not
// follow is half a feature, and a link to a page that doesn't exist yet has
// to look different from one that does — writing the name before the page
// exists is the point of a wiki link, but only if you can tell.

export type PageLinkChoice = { title: string };

export type PageLinkOptions = {
  /** Title → page id, or null when no page has that title yet. */
  resolve: ((title: string) => string | null) | null;
  /** Follow the link. `pageId` is null for a page that doesn't exist yet. */
  onOpen: ((title: string, pageId: string | null) => void) | null;
};

export const PageLink = Node.create<PageLinkOptions>({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,

  addOptions() {
    return { resolve: null, onOpen: null };
  },

  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (element) =>
          element.getAttribute("data-page-link") ?? element.textContent ?? "",
        renderHTML: (attributes) => ({
          "data-page-link": attributes.title as string,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-page-link]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "page-wikilink" }),
      node.attrs.title as string,
    ];
  },

  renderText({ node }) {
    return `[[${node.attrs.title as string}]]`;
  },

  addNodeView() {
    return ({ node }) => {
      const title = node.attrs.title as string;
      const pageId = this.options.resolve?.(title) ?? null;

      const dom = document.createElement("span");
      dom.setAttribute("data-page-link", title);
      dom.className = pageId
        ? "page-wikilink"
        : "page-wikilink page-wikilink-missing";
      dom.textContent = title;
      dom.title = pageId
        ? `Open ${title}`
        : `No page called "${title}" yet — click to create it`;
      // Mouse-down rather than click, and prevented, so the caret doesn't
      // land inside the link on the way to following it.
      dom.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onOpen?.(title, pageId);
      });
      return { dom };
    };
  },

  addStorage() {
    return {
      markdown: {
        // Registers the mention and wiki-link rules for the whole document —
        // both tokens are installed together by one guarded call.
        parse: { setup: installPageTokens },
        serialize(
          state: { write: (text: string) => void },
          node: { attrs: { title?: string } },
        ) {
          state.write(`[[${node.attrs.title ?? ""}]]`);
        },
      },
    };
  },
});

/** Distinct from the slash and mention keys — see SlashCommandsPluginKey. */
export const PageLinkPluginKey = new PluginKey("pageLinkSuggestion");

export const PageLinkSuggestion = Extension.create({
  name: "pageLinkSuggestion",
  addOptions() {
    return {
      suggestion: {
        pluginKey: PageLinkPluginKey,
        char: "[[",
        startOfLine: false,
        // Page titles have spaces in them, so the query can't stop at one.
        allowSpaces: true,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: Range;
          props: PageLinkChoice;
        }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "pageLink", attrs: { title: props.title } },
              { type: "text", text: " " },
            ])
            .run();
        },
      },
    };
  },
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  },
});
