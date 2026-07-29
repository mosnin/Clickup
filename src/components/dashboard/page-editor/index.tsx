"use client";

import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { buildExtensions, type MentionSuggestion } from "./extensions";
import { SelectionToolbar } from "./selection-toolbar";
import { PageLinkSuggestion, type PageLinkChoice } from "./page-link";
import {
  createSuggestionRenderer,
  type MenuSection,
} from "./suggestion-menu";
import {
  filterSlashItems,
  groupSlashItems,
  type SlashItem,
} from "./slash-commands";

// The page editing surface.
//
// Rich editing over a markdown document: every keystroke updates the Tiptap
// doc, and what gets saved is `editor.storage.markdown.getMarkdown()`. The
// parent owns persistence and debouncing; this component's only job is to be
// a good editor and hand back markdown.

const PLACEHOLDER = "Write, or press '/' for blocks and '@' to mention someone";

export function PageBodyEditor({
  markdown,
  editable = true,
  mentionables,
  pageTitles,
  onChange,
  onFocusChange,
  onReady,
  onOpenPageLink,
  uploadImage,
}: {
  markdown: string;
  editable?: boolean;
  mentionables: MentionSuggestion[];
  pageTitles: { pageId: string; title: string }[];
  onChange: (markdown: string) => void;
  onFocusChange?: (focused: boolean) => void;
  /** The Tiptap instance, once it exists — for callers that need to drive it. */
  onReady?: (editor: Editor) => void;
  /** Follow a [[link]]. `pageId` is null when no page has that title yet. */
  onOpenPageLink?: (title: string, pageId: string | null) => void;
  /** Store an image and return its URL, or null if the upload failed. */
  uploadImage?: (file: File) => Promise<string | null>;
}) {
  // The suggestion menus read these on every keystroke. Refs, not closure
  // captures, because the extensions are built once and would otherwise
  // pin the first render's lists forever.
  const mentionsRef = useRef(mentionables);
  mentionsRef.current = mentionables;
  const titlesRef = useRef(pageTitles);
  titlesRef.current = pageTitles;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const openLinkRef = useRef(onOpenPageLink);
  openLinkRef.current = onOpenPageLink;
  const uploadRef = useRef(uploadImage);
  uploadRef.current = uploadImage;

  const extensions = useMemo(() => {
    const mentionSuggestion = {
      char: "@",
      items: ({ query }: { query: string }) => {
        const needle = query.toLowerCase();
        return mentionsRef.current
          .filter((m) => m.name.toLowerCase().includes(needle))
          .slice(0, 8);
      },
      render: createSuggestionRenderer<MentionSuggestion>({
        emptyLabel: "Nobody by that name in this workspace.",
        buildSections: (query) => {
          const needle = query.toLowerCase();
          const matches = mentionsRef.current
            .filter((m) => m.name.toLowerCase().includes(needle))
            .slice(0, 8);
          const sections: MenuSection<MentionSuggestion>[] = [
            {
              heading: "People",
              rows: matches
                .filter((m) => m.kind === "user")
                .map((m) => ({ key: m.id, label: m.name, value: m })),
            },
            {
              heading: "Agents",
              rows: matches
                .filter((m) => m.kind === "agent")
                .map((m) => ({
                  key: m.id,
                  label: m.name,
                  meta: "agent",
                  value: m,
                })),
            },
          ];
          return sections;
        },
      }),
      command: ({
        editor,
        range,
        props,
      }: {
        editor: Editor;
        range: { from: number; to: number };
        props: MentionSuggestion;
      }) => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "mention",
              attrs: { id: props.id, label: props.name },
            },
            { type: "text", text: " " },
          ])
          .run();
      },
    };

    const slashSuggestion = {
      char: "/",
      startOfLine: true,
      items: ({ query }: { query: string }) => filterSlashItems(query),
      render: createSuggestionRenderer<SlashItem>({
        emptyLabel: "No block matches that.",
        buildSections: (query) =>
          groupSlashItems(filterSlashItems(query)).map((g) => ({
            heading: g.group,
            rows: g.items.map((item) => ({
              key: item.title,
              label: item.title,
              hint: item.hint,
              icon: item.icon,
              value: item,
            })),
          })),
      }),
      command: ({
        editor,
        range,
        props,
      }: {
        editor: Editor;
        range: { from: number; to: number };
        props: SlashItem;
      }) => props.run(editor, range),
    };

    const pageLinkSuggestion = {
      char: "[[",
      allowSpaces: true,
      items: ({ query }: { query: string }) => {
        const needle = query.toLowerCase();
        return titlesRef.current
          .filter((p) => p.title.toLowerCase().includes(needle))
          .slice(0, 8)
          .map((p) => ({ title: p.title }));
      },
      render: createSuggestionRenderer<PageLinkChoice>({
        emptyLabel: "No page by that name yet — keep typing to name a new one.",
        buildSections: (query) => {
          const needle = query.toLowerCase();
          return [
            {
              heading: "Link to page",
              rows: titlesRef.current
                .filter((p) => p.title.toLowerCase().includes(needle))
                .slice(0, 8)
                .map((p) => ({
                  key: p.pageId,
                  label: p.title,
                  value: { title: p.title },
                })),
            },
          ];
        },
      }),
    };

    return [
      ...buildExtensions({
        placeholder: PLACEHOLDER,
        mentionSuggestion,
        slashSuggestion,
        pageLink: {
          // Read through the refs on every call: the title index changes as
          // pages are created, and the extensions are built once.
          resolve: (title) =>
            titlesRef.current.find(
              (p) => p.title.toLowerCase() === title.toLowerCase(),
            )?.pageId ?? null,
          onOpen: (title, pageId) => openLinkRef.current?.(title, pageId),
        },
        uploadImage: (file) =>
          uploadRef.current?.(file) ?? Promise.resolve(null),
      }),
      PageLinkSuggestion.configure({ suggestion: pageLinkSuggestion }),
    ];
  }, []);

  const editor = useEditor({
    extensions,
    content: markdown,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "page-prose page-editor-surface focus:outline-none",
        "aria-label": "Page body",
      },
    },
    onUpdate: ({ editor: ed }) => {
      const storage = ed.storage as { markdown?: { getMarkdown(): string } };
      onChangeRef.current(storage.markdown?.getMarkdown() ?? "");
    },
    onFocus: () => onFocusChange?.(true),
    onBlur: () => onFocusChange?.(false),
  });

  // Adopt content that changed underneath us — an agent writing to the page
  // while it's open — without stomping on what the person is typing. The
  // guard is the comparison: if the editor's own markdown already matches,
  // this was our own echo coming back.
  useEffect(() => {
    if (!editor) return;
    const storage = editor.storage as { markdown?: { getMarkdown(): string } };
    if ((storage.markdown?.getMarkdown() ?? "") === markdown) return;
    if (editor.isFocused) return;
    editor.commands.setContent(markdown, false);
  }, [editor, markdown]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  if (!editor) return <div className="page-prose min-h-[24rem]" />;

  return (
    <>
      <SelectionToolbar editor={editor} />
      <EditorContent editor={editor} />
    </>
  );
}
