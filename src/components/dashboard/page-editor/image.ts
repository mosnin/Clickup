"use client";

import Image from "@tiptap/extension-image";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

// Images.
//
// The stored form is a plain `![alt](url)` — the bytes live in Convex file
// storage and the markdown holds the storage URL, so an image is still
// something an agent can read, write and move to another page by copying
// text. StarterKit has no image node at all, which is why `![x](y)` used to
// parse to an empty paragraph and silently delete itself.

export const PageImage = Image.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (text: string) => void },
          node: { attrs: { src?: string; alt?: string; title?: string } },
        ) {
          const alt = (node.attrs.alt ?? "").replace(/[[\]]/g, "");
          const title = node.attrs.title
            ? ` "${node.attrs.title.replace(/"/g, "")}"`
            : "";
          state.write(`![${alt}](${node.attrs.src ?? ""}${title})`);
        },
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: { class: "page-image" },
});

export type ImageUploader = (file: File) => Promise<string | null>;

/**
 * Drop or paste an image straight into the page.
 *
 * Reaching for a file dialog to move a screenshot from the clipboard into a
 * document is the kind of friction that makes people stop pasting
 * screenshots. Both gestures route through the same uploader as the slash
 * command, so there is one upload path to get right.
 */
export const ImageDrop = Extension.create<{ upload: ImageUploader | null }>({
  name: "pageImageDrop",
  addOptions() {
    return { upload: null };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;

    function handleFiles(files: File[], at?: number): boolean {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0 || !options.upload) return false;
      void (async () => {
        for (const file of images) {
          const url = await options.upload!(file);
          if (!url) continue;
          const chain = editor.chain().focus();
          if (at !== undefined) chain.setTextSelection(at);
          chain.setImage({ src: url, alt: file.name }).run();
        }
      })();
      return true;
    }

    return [
      new Plugin({
        key: new PluginKey("pageImageDrop"),
        props: {
          handlePaste(view, event) {
            const files = Array.from(event.clipboardData?.files ?? []);
            return handleFiles(files);
          },
          handleDrop(view, event) {
            const files = Array.from(
              (event as DragEvent).dataTransfer?.files ?? [],
            );
            if (files.length === 0) return false;
            const at = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            })?.pos;
            return handleFiles(files, at);
          },
        },
      }),
    ];
  },
});
