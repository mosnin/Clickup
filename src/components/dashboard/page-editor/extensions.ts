"use client";

import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import type { AnyExtension } from "@tiptap/react";
import { SlashCommands } from "./slash-commands";
import { PageLink, type PageLinkOptions } from "./page-link";
import { ImageDrop, PageImage, type ImageUploader } from "./image";
import { Callout, ToggleBlock, ToggleSummary } from "./blocks";
import { DragHandle } from "./drag-handle";

// The editor's schema.
//
// The load-bearing decision: markdown stays the stored format. Tiptap is the
// editing *surface*, not the storage model — every change is serialized back
// to markdown before it is saved, which is what keeps an agent writing
// `## Heading` and a person pressing the H2 button editing the same bytes.
//
// Everything the editor can express therefore needs a markdown spelling:
//   - structure, lists, quotes, code   → standard markdown
//   - tables                           → GFM pipe tables
//   - checkboxes                       → GFM task list items
//   - mentions                         → @[Name](actorId), the exact token
//     the comment composer already uses (src/lib/mentions.ts)
//   - page links                       → [[Page title]]
// Nothing in the toolbar creates something markdown cannot round-trip.

/** Serializes a mention to the app's existing token rather than to HTML. */
const PageMention = Mention.extend({
  addStorage() {
    return {
      markdown: {
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

export type MentionSuggestion = {
  id: string;
  name: string;
  kind: "user" | "agent";
};

export function buildExtensions(opts: {
  placeholder: string;
  mentionSuggestion: Record<string, unknown>;
  slashSuggestion: Record<string, unknown>;
  pageLink: PageLinkOptions;
  uploadImage: ImageUploader | null;
}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Pages rarely need h4–h6, and capping the set keeps the type scale
      // legible instead of offering six sizes that look the same.
      heading: { levels: [1, 2, 3] },
      codeBlock: { HTMLAttributes: { class: "page-code-block" } },
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
      HTMLAttributes: { rel: "noopener noreferrer", class: "page-link" },
    }),
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === "heading" ? "Heading" : opts.placeholder,
      showOnlyWhenEditable: true,
    }),
    PageMention.configure({
      HTMLAttributes: { class: "page-mention" },
      suggestion: opts.mentionSuggestion as never,
    }),
    Table.configure({
      resizable: false,
      HTMLAttributes: { class: "page-table" },
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList.configure({ HTMLAttributes: { class: "page-task-list" } }),
    TaskItem.configure({ nested: true }),
    PageImage,
    ImageDrop.configure({ upload: opts.uploadImage }),
    ToggleBlock,
    ToggleSummary,
    Callout,
    DragHandle,
    PageLink.configure(opts.pageLink),
    SlashCommands.configure({ suggestion: opts.slashSuggestion as never }),
  ] as AnyExtension[];
}
