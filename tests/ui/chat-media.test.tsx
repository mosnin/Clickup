import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The media surfaces' contract.
//
// jsdom cannot say whether a lightbox looks like the picture growing out of the
// message — that is what a real browser and a screenshot are for. What it *can*
// say, and what breaks silently, is the set of rules these components ARE: that
// the body a reader sees does not contain the URL of the picture beside it, that
// a timecode pill seeks to the second it claims, that "Comment at current frame"
// puts the frame in the body and unchecking it does not, that a reply inherits
// its parent's moment instead of stamping a new one, and that reserved
// attachment slots stay in the order they were picked. Every one of those has
// exactly one right answer and no visual signal when it is wrong.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

import { MessageRow } from "@/components/chat/transcript/message-row";
import { MessageMedia } from "@/components/chat/media/message-media";
import { AttachmentTray } from "@/components/chat/media/attachment-tray";
import { VideoReviewPanel } from "@/components/chat/media/video-review";
import { frameBox } from "@/components/chat/media/progressive-image";
import {
  flipFrom,
  lightboxTarget,
  stepInGallery,
  zoomAfterWheel,
} from "@/components/chat/media/lightbox-geometry";
import { useMediaUpload } from "@/components/chat/media/use-media-upload";
import {
  appendMediaLines,
  formatImetaTag,
  type MediaDescriptor,
} from "@/lib/buzz/media";
import type { ChatMessage } from "@/lib/buzz/message-types";

const PICTURE: MediaDescriptor = {
  url: "https://store.test/api/storage/pic",
  mime: "image/png",
  width: 800,
  height: 600,
  thumbUrl: "https://store.test/api/storage/pic-thumb",
  filename: "chart.png",
};

const CLIP: MediaDescriptor = {
  url: "https://store.test/api/storage/clip",
  mime: "video/mp4",
  width: 1920,
  height: 1080,
  durationSecs: 90,
  posterUrl: "https://store.test/api/storage/clip-poster",
  filename: "walkthrough.mp4",
};

const REPORT: MediaDescriptor = {
  url: "https://store.test/api/storage/doc",
  mime: "application/pdf",
  sizeBytes: 2048,
  filename: "q3.pdf",
};

function messageWith(body: string, media: MediaDescriptor[]): ChatMessage {
  return {
    id: "evt1",
    renderKey: "evt1",
    createdAt: 1_700_000_000,
    pubkey: "aa",
    signerPubkey: "aa",
    author: "Ada",
    isAgent: false,
    body: appendMediaLines(body, media),
    tags: [["h", "chan"], ["p", "aa"], ...media.map(formatImetaTag)],
    kind: 9,
    depth: 0,
    edited: false,
    pending: false,
    mine: true,
    reactions: [],
  };
}

function renderRow(message: ChatMessage, overrides: Record<string, unknown> = {}) {
  return render(
    <MessageRow
      message={message}
      grouped={false}
      summary={null}
      canManage
      canCopy
      editing={false}
      highlightToken={0}
      onToggleReaction={() => {}}
      onReply={() => {}}
      onOpenThread={() => {}}
      onStartEdit={() => {}}
      onCancelEdit={() => {}}
      onSubmitEdit={() => {}}
      onDelete={() => {}}
      onCopyMessage={() => {}}
      onCopyLink={() => {}}
      {...overrides}
    />,
  );
}

// ---------------------------------------------------------------------------

describe("a message with attachments", () => {
  it("draws the picture and does not also print its URL", () => {
    // §2.7 puts a markdown line in the body beside the tag so a text-only client
    // sees something. A client that draws the picture must take it back off, or
    // every screenshot arrives with a 70-character storage URL under it.
    const { container } = renderRow(messageWith("look at this", [PICTURE]));
    expect(screen.getByText("look at this")).toBeTruthy();
    expect(container.textContent).not.toContain("api/storage/pic");
    expect(container.querySelector("[data-message-media]")).toBeTruthy();
    expect(container.querySelector("[data-image-lightbox-trigger]")).toBeTruthy();
  });

  it("draws a picture with no caption at all without an empty paragraph", () => {
    const { container } = renderRow(messageWith("", [PICTURE]));
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("[data-image-lightbox-trigger]")).toBeTruthy();
  });

  it("seeds the edit box with the words, never with the markdown", () => {
    renderRow(messageWith("look at this", [PICTURE]), { editing: true });
    const box = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
    expect(box.value).toBe("look at this");
  });

  it("lets an edit clear the caption of a message that is only a picture", () => {
    const onSubmitEdit = vi.fn();
    renderRow(messageWith("oops", [PICTURE]), { editing: true, onSubmitEdit });
    const box = screen.getByLabelText("Edit message");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmitEdit).toHaveBeenCalledWith("");
  });

  it("still cancels an empty edit on a message that has no attachments", () => {
    const onSubmitEdit = vi.fn();
    const onCancelEdit = vi.fn();
    renderRow(messageWith("oops", []), { editing: true, onSubmitEdit, onCancelEdit });
    const box = screen.getByLabelText("Edit message");
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmitEdit).not.toHaveBeenCalled();
    expect(onCancelEdit).toHaveBeenCalled();
  });
});

describe("the media renderer", () => {
  it("gives each kind its own treatment", () => {
    const { container } = render(
      <MessageMedia tags={[PICTURE, CLIP, REPORT].map(formatImetaTag)} />,
    );
    expect(container.querySelector("[data-image-lightbox-trigger]")).toBeTruthy();
    expect(container.querySelector("video")).toBeTruthy();
    const download = container.querySelector("a[download]") as HTMLAnchorElement;
    expect(download.getAttribute("download")).toBe("q3.pdf");
    expect(download.textContent).toContain("2 KB");
  });

  it("degrades a type it cannot draw to a download rather than an inline frame", () => {
    // The mutation refuses these, but a tag written by another client — or by an
    // older build — must not become an `<img>` with an arbitrary MIME.
    const { container } = render(
      <MessageMedia
        tags={[formatImetaTag({ url: "https://x/evil", mime: "text/html" })]}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("a[download]")).toBeTruthy();
  });

  it("draws nothing at all when there is no media", () => {
    const { container } = render(<MessageMedia tags={[["h", "chan"]]} />);
    expect(container.firstChild).toBeNull();
  });

  it("gives the video a poster so there is something before it decodes", () => {
    const { container } = render(<MessageMedia tags={[formatImetaTag(CLIP)]} />);
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("poster")).toBe(CLIP.posterUrl);
    expect(video.getAttribute("preload")).toBe("metadata");
  });
});

describe("the frame the image reserves", () => {
  it("keeps the real ratio, so nothing reflows when it lands", () => {
    expect(frameBox({ width: 800, height: 600 }, 400, 400)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it("never scales a small image up", () => {
    expect(frameBox({ width: 100, height: 50 }, 400, 400)).toEqual({
      width: 100,
      height: 50,
    });
  });

  it("falls back to a stable box rather than to no height", () => {
    // Zero height collapses the frame and then shoves the transcript down when
    // the picture arrives — the exact reflow this whole treatment exists to
    // avoid.
    expect(frameBox({}, 400, 400).height).toBeGreaterThan(0);
  });
});

describe("the lightbox geometry", () => {
  it("centres the image inside the viewport fraction, keeping its ratio", () => {
    const box = lightboxTarget({ width: 1000, height: 1000 }, { width: 800, height: 400 });
    expect(box.width).toBe(800);
    expect(box.height).toBe(400);
    expect(box.left).toBe(100);
    expect(box.top).toBe(300);
  });

  it("still produces a box on screen for an image whose size is unknown", () => {
    const box = lightboxTarget({ width: 1000, height: 800 }, { width: 0, height: 0 });
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it("inverts to exactly the thumbnail's box", () => {
    const from = { top: 100, left: 50, width: 200, height: 100 };
    const to = { top: 0, left: 0, width: 800, height: 400 };
    expect(flipFrom(from, to)).toEqual({ x: 50, y: 100, scaleX: 0.25, scaleY: 0.25 });
  });

  it("clamps zoom between one and three", () => {
    expect(zoomAfterWheel(1, 500)).toBe(1);
    expect(zoomAfterWheel(3, -5000)).toBe(3);
    expect(zoomAfterWheel(1, -100)).toBeGreaterThan(1);
  });

  it("clamps gallery navigation rather than wrapping", () => {
    // Wrapping at the last image reads as the viewer having jumped somewhere
    // else entirely.
    expect(stepInGallery(0, -1, 3)).toBe(0);
    expect(stepInGallery(2, 1, 3)).toBe(2);
    expect(stepInGallery(0, 1, 3)).toBe(1);
    expect(stepInGallery(0, 1, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Frame-anchored comments
// ---------------------------------------------------------------------------

const COMMENTS = [
  { id: "c1", author: "Ada", body: "[00:30] the logo pops here", createdAt: 100 },
  { id: "c2", author: "Bo", body: "[00:05] audio clips", createdAt: 200 },
  { id: "c3", author: "Cy", body: "looks good overall", createdAt: 300 },
  { id: "c4", author: "Dee", body: "agreed", createdAt: 400, parentId: "c1" },
];

function renderPanel(overrides: Record<string, unknown> = {}) {
  const onSeek = vi.fn();
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onAuthoringFocus = vi.fn();
  const utils = render(
    <VideoReviewPanel
      context={{ rootEventId: "video", comments: COMMENTS, onSend }}
      currentTime={3.4}
      duration={90}
      onSeek={onSeek}
      onAuthoringFocus={onAuthoringFocus}
      {...overrides}
    />,
  );
  return { ...utils, onSeek, onSend, onAuthoringFocus };
}

describe("the review panel", () => {
  it("orders stamped comments by moment and un-stamped ones last", () => {
    renderPanel();
    const shown = screen
      .getAllByText(/the logo pops here|audio clips|looks good overall/)
      .map((node) => node.textContent);
    expect(shown).toEqual(["audio clips", "the logo pops here", "looks good overall"]);
  });

  it("shows the timecode as a pill and hides it from the sentence", () => {
    renderPanel();
    expect(screen.getByLabelText("Seek to 00:30")).toBeTruthy();
    expect(screen.getByText("the logo pops here")).toBeTruthy();
    // The prefix is metadata, not prose.
    expect(screen.queryByText("[00:30] the logo pops here")).toBeNull();
  });

  it("seeks to the second the pill claims", () => {
    const { onSeek } = renderPanel();
    fireEvent.click(screen.getByLabelText("Seek to 00:30"));
    expect(onSeek).toHaveBeenCalledWith(30);
  });

  it("nests a reply one level under its top-level comment", () => {
    renderPanel();
    expect(screen.getByText("agreed")).toBeTruthy();
    // Two levels of indent in a 380px column is text four words wide.
    const lists = document.querySelectorAll("ul ul ul");
    expect(lists.length).toBe(0);
  });

  it("stamps what you type at the frame you are looking at", async () => {
    const { onSend } = renderPanel();
    const box = screen.getByLabelText("Comment on this video");
    fireEvent.change(box, { target: { value: "colour shifts" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    expect(onSend).toHaveBeenCalledWith("[00:03.4] colour shifts", "video");
  });

  it("does not stamp when the reader turns it off", async () => {
    const { onSend } = renderPanel();
    fireEvent.click(screen.getByLabelText(/Comment at current frame/i));
    fireEvent.change(screen.getByLabelText("Comment on this video"), {
      target: { value: "looks good, ship it" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    expect(onSend).toHaveBeenCalledWith("looks good, ship it", "video");
  });

  it("leaves a sentence that merely starts with a bracketed number alone", async () => {
    // The near-miss, end to end: `[12]` is not a timecode, so it stays in the
    // sentence and the real stamp goes in front of it.
    const { onSend } = renderPanel();
    fireEvent.change(screen.getByLabelText("Comment on this video"), {
      target: { value: "[12] apples left in the shot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    expect(onSend).toHaveBeenCalledWith("[00:03.4] [12] apples left in the shot", "video");
  });

  it("does not stamp a comment that already carries one", async () => {
    const { onSend } = renderPanel();
    fireEvent.change(screen.getByLabelText("Comment on this video"), {
      target: { value: "[00:59] I know when it is" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    expect(onSend).toHaveBeenCalledWith("[00:59] I know when it is", "video");
  });

  it("shows the moment it is about to stamp, and says when it will not", () => {
    renderPanel();
    expect(screen.getByTestId("timecode-chip").textContent).toBe("00:03.4");
    fireEvent.click(screen.getByLabelText(/Comment at current frame/i));
    // Still shown — the frame is still where you are — but no longer accented.
    expect(screen.getByTestId("timecode-chip").textContent).toBe("00:03.4");
  });

  it("bounds the stamp to the video's length", async () => {
    const { onSend } = renderPanel({ currentTime: 500, duration: 90 });
    fireEvent.change(screen.getByLabelText("Comment on this video"), {
      target: { value: "at the end" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    expect(onSend).toHaveBeenCalledWith("[01:30] at the end", "video");
  });

  it("a reply inherits the parent's moment and never re-stamps", async () => {
    const { onSend } = renderPanel();
    fireEvent.click(screen.getAllByLabelText("Reply to Ada")[0]);
    expect(screen.getByText("Replying to Ada")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Comment on this video"), {
      target: { value: "same here" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    expect(onSend).toHaveBeenCalledWith("same here", "c1");
  });

  it("pauses the video when the box is focused", () => {
    const { onAuthoringFocus } = renderPanel();
    fireEvent.focus(screen.getByLabelText("Comment on this video"));
    expect(onAuthoringFocus).toHaveBeenCalled();
  });

  it("puts a refused comment back in the box", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("You are not in this channel"));
    renderPanel({ context: { rootEventId: "video", comments: COMMENTS, onSend } });
    const box = screen.getByLabelText("Comment on this video") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "worth saying" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Comment"));
    });
    await waitFor(() => expect(box.value).toBe("worth saying"));
    expect(screen.getByRole("alert").textContent).toContain("not in this channel");
  });

  it("renders read-only when there are comments but no way to add one", () => {
    render(
      <VideoReviewPanel
        context={{ rootEventId: "video", comments: COMMENTS, disabledReason: "Read only" }}
        currentTime={0}
        duration={90}
        onSeek={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Comment on this video")).toBeNull();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.getByText("the logo pops here")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The composer's tray
// ---------------------------------------------------------------------------

describe("the attachment tray", () => {
  const slots = [
    {
      id: "s1",
      name: "one.png",
      kind: "image" as const,
      sizeBytes: 1024,
      status: "ready" as const,
      progress: 1,
    },
    {
      id: "s2",
      name: "two.mp4",
      kind: "video" as const,
      sizeBytes: 4096,
      status: "uploading" as const,
      progress: 0.42,
    },
    {
      id: "s3",
      name: "three.pdf",
      kind: "file" as const,
      sizeBytes: 8,
      status: "failed" as const,
      progress: 0,
      error: "Upload failed",
    },
  ];

  it("shows every slot in the order it was picked, whatever its state", () => {
    render(<AttachmentTray slots={slots} onRemove={() => {}} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.slice(0, 5))).toEqual([
      "one.p",
      "two.m",
      "three",
    ]);
  });

  it("says how far along an upload is, and why one failed", () => {
    render(<AttachmentTray slots={slots} onRemove={() => {}} />);
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Upload failed")).toBeTruthy();
    expect(screen.getByText("1 KB")).toBeTruthy();
  });

  it("removes the one that was asked for", () => {
    const onRemove = vi.fn();
    render(<AttachmentTray slots={slots} onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText("Remove two.mp4"));
    expect(onRemove).toHaveBeenCalledWith("s2");
  });

  it("draws nothing when there is nothing attached", () => {
    const { container } = render(<AttachmentTray slots={[]} onRemove={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("reserving upload slots", () => {
  function Harness({ onRefused }: { onRefused: (reason: string) => void }) {
    const uploads = useMediaUpload({
      requestUploadUrl: async () => "https://upload.test/x",
      onRefused,
    });
    return (
      <div>
        <button
          type="button"
          onClick={() =>
            uploads.add([
              file("a.png", "image/png"),
              file("b.png", "image/png"),
              file("c.png", "image/png"),
            ])
          }
        >
          pick three
        </button>
        <button type="button" onClick={() => uploads.add([file("x.html", "text/html")])}>
          pick html
        </button>
        <ol>
          {uploads.slots.map((slot) => (
            <li key={slot.id}>{slot.name}</li>
          ))}
        </ol>
      </div>
    );
  }

  const file = (name: string, type: string) =>
    new File([new Uint8Array([1, 2, 3])], name, { type });

  it("shows the picked files immediately, in picked order", () => {
    // §2.6: three concurrent uploads finish in whatever order the network
    // decides, and the attachments must not reorder themselves under the reader.
    render(<Harness onRefused={() => {}} />);
    act(() => {
      fireEvent.click(screen.getByText("pick three"));
    });
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
  });

  it("refuses a blocked type before a byte moves, and says which file", () => {
    const onRefused = vi.fn();
    render(<Harness onRefused={onRefused} />);
    act(() => {
      fireEvent.click(screen.getByText("pick html"));
    });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(onRefused.mock.calls[0][0]).toContain("x.html");
  });
});
