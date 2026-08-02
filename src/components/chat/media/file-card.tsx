"use client";

// Everything that is not a picture or a video.
//
// A card, not an inline preview, and that is a security position rather than a
// design one (§2.3, §2.8): the renderer draws only the image and video types it
// can name, and everything else — PDFs included — is a download. A PDF rendered
// in an iframe is an HTML surface with a scripting engine in it, served from a
// URL somebody else chose the bytes for.
//
// The download is a plain link, because we are a web app and not Buzz's Tauri
// shell — its `download_file` command exists because a bare link navigates a
// *webview* to the blob and escapes to the OS browser. In a browser tab, a link
// with `download` is the right and only mechanism.

import { Download } from "lucide-react";
import { formatBytes, type MediaDescriptor } from "@/lib/buzz/media";

export function FileCard({ media }: { media: MediaDescriptor }) {
  const name = media.filename ?? "file";
  return (
    <a
      href={media.url}
      download={name}
      rel="noopener noreferrer"
      className="bento tap-target flex max-w-sm items-center gap-3 rounded-xl px-3 py-2 no-underline"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium">{name}</span>
        <span className="chat-quiet block text-[0.6875rem]">
          {media.sizeBytes ? formatBytes(media.sizeBytes) : media.mime}
        </span>
      </span>
      {/* An affordance, not an ornament: this glyph *is* the download control. */}
      <Download aria-hidden className="size-4 shrink-0" />
    </a>
  );
}
