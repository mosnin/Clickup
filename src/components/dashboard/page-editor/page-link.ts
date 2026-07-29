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
// same ones convex/pages.ts and renderMarkdown already understand.

export type PageLinkChoice = { title: string };

export const PageLink = Node.create({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,

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
