import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "../convex/schema";
import { publicKeyFromSecret } from "../convex/buzz/_nostr";
import { RELAY_SEED_ENV } from "../convex/buzz/relay";
import { applyEditTagOverlay, projectTimeline } from "../src/lib/buzz/timeline";
import * as lib from "../src/lib/buzz/media";
import * as server from "../convex/buzz/media";

// `anyApi` rather than the generated `api`, for the reason every other buzz
// suite states: `convex/_generated/api.d.ts` is a hand-rolled stub that predates
// `convex/buzz/*` and only `npx convex dev` may rewrite it.
const modules = import.meta.glob("../convex/**/*.*s");
const channels = anyApi.buzz.channels;
const messages = anyApi.buzz.messages;
const media = anyApi.buzz.media;

const ALICE = { subject: "user_alice" };
const BOB = { subject: "user_bob" };
/** In no workspace at all. The tenancy fence's test subject. */
const OUTSIDER = { subject: "user_outsider" };

const KEYS: Record<string, string> = {
  [ALICE.subject]: "01".repeat(32),
  [BOB.subject]: "02".repeat(32),
  [OUTSIDER.subject]: "04".repeat(32),
};

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];
type Scope = { scopeType: "user" | "workspace"; scopeId: string };
type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};
type Page = { events: Event[] };

let previousSeed: string | undefined;

beforeAll(() => {
  previousSeed = process.env[RELAY_SEED_ENV];
  process.env[RELAY_SEED_ENV] = "test-relay-seed-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (previousSeed === undefined) delete process.env[RELAY_SEED_ENV];
  else process.env[RELAY_SEED_ENV] = previousSeed;
});

// ---------------------------------------------------------------------------
// The two copies of the grammar agree
// ---------------------------------------------------------------------------
//
// `convex/` deploys as its own bundle and cannot import from the Next tree, so
// the tag encoder and the limits exist twice (the same restatement pattern
// `messages.mentionedActorIds` uses). This block is what makes that safe: a
// drift of one space in the encoder would produce attachments the browser
// silently could not parse, and the failure would look like "images stopped
// appearing" weeks later.

describe("the browser's copy and the server's copy of the grammar", () => {
  it("agrees on every limit", () => {
    expect(server.LIMITS).toEqual(lib.LIMITS);
  });

  const mimes = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska",
    "image/svg+xml",
    "image/heic",
    "text/html",
    "text/javascript",
    "application/pdf",
    "application/zip",
    "application/octet-stream",
    "audio/mpeg",
    "audio/wav",
    "application/vnd.android.package-archive",
    "",
    "  IMAGE/PNG ; charset=binary",
  ];

  it("agrees on what every MIME type means", () => {
    for (const mime of mimes) {
      expect([mime, server.mediaKindOf(mime)]).toEqual([mime, lib.mediaKindOf(mime)]);
      expect([mime, server.isBlockedMime(mime)]).toEqual([mime, lib.isBlockedMime(mime)]);
      expect([mime, server.sizeCapFor(mime)]).toEqual([mime, lib.sizeCapFor(mime)]);
      expect([mime, server.normalizeMime(mime)]).toEqual([mime, lib.normalizeMime(mime)]);
    }
  });

  it("encodes an attachment to the same bytes", () => {
    const specimens: lib.MediaDescriptor[] = [
      { url: "https://x/1", mime: "image/png" },
      {
        url: "https://x/2",
        mime: "IMAGE/JPEG",
        sha256: "abc",
        sizeBytes: 1234,
        width: 800,
        height: 600,
        blurhash: "LKO2",
        thumbUrl: "https://x/2t",
        filename: "my holiday.jpg",
      },
      {
        url: "https://x/3",
        mime: "video/mp4",
        sizeBytes: 9,
        durationSecs: 61.6,
        posterUrl: "https://x/3p",
        width: 1920,
        height: 1080,
      },
      { url: "https://x/4", mime: "application/pdf", sizeBytes: 0, durationSecs: 0 },
    ];
    for (const specimen of specimens) {
      expect(server.formatImetaTag(specimen)).toEqual(lib.formatImetaTag(specimen));
      expect(server.formatMediaLine(specimen)).toEqual(lib.formatMediaLine(specimen));
      // And the server's decoder reads the browser's encoding.
      expect(server.parseImetaTag(lib.formatImetaTag(specimen))).toEqual(
        lib.parseImetaTag(server.formatImetaTag(specimen)),
      );
    }
  });

  it("sanitizes a filename the same way", () => {
    for (const raw of ["a.png", "C:\\Users\\ada\\pic.png", "/tmp/x/y.pdf", "", "  ", "x".repeat(400)]) {
      expect(server.sanitizeFilename(raw)).toEqual(lib.sanitizeFilename(raw));
    }
  });
});

// ---------------------------------------------------------------------------
// The tag
// ---------------------------------------------------------------------------

describe("the imeta tag", () => {
  it("always carries url and m, and nothing it does not know", () => {
    expect(lib.formatImetaTag({ url: "https://x/a.png", mime: "image/png" })).toEqual([
      "imeta",
      "url https://x/a.png",
      "m image/png",
    ]);
  });

  it("omits x and size rather than emitting empty ones", () => {
    // §2.7: a relay validator rejects a literal `"x "` or `"size 0"`.
    const tag = lib.formatImetaTag({
      url: "https://x/a.png",
      mime: "image/png",
      sizeBytes: 0,
      sha256: "",
    });
    expect(tag.some((part) => part.startsWith("size"))).toBe(false);
    expect(tag.some((part) => part.startsWith("x "))).toBe(false);
  });

  it("keeps one fixed field order, because the order is part of the event id", () => {
    expect(
      lib.formatImetaTag({
        // Deliberately supplied in a scrambled order; the encoder decides.
        filename: "a.png",
        durationSecs: 12,
        thumbUrl: "https://x/t",
        blurhash: "L1",
        height: 2,
        width: 1,
        sizeBytes: 3,
        sha256: "deadbeef",
        mime: "image/png",
        url: "https://x/a.png",
        posterUrl: "https://x/p",
      }),
    ).toEqual([
      "imeta",
      "url https://x/a.png",
      "m image/png",
      "x deadbeef",
      "size 3",
      "dim 1x2",
      "blurhash L1",
      "thumb https://x/t",
      "duration 12",
      "image https://x/p",
      "filename a.png",
    ]);
  });

  it("round-trips every field", () => {
    const original: lib.MediaDescriptor = {
      url: "https://example.test/api/storage/abc",
      mime: "video/mp4",
      sha256: "ZmFrZQ==",
      sizeBytes: 4096,
      width: 1920,
      height: 1080,
      thumbUrl: "https://example.test/t",
      posterUrl: "https://example.test/p",
      durationSecs: 42,
      blurhash: "LKO2?U",
      filename: "clip one.mp4",
    };
    expect(lib.parseImetaTag(lib.formatImetaTag(original))).toEqual(original);
  });

  it("keeps a filename that contains spaces", () => {
    // The value is split on the FIRST space only; anything else eats filenames.
    const parsed = lib.parseImetaTag(
      lib.formatImetaTag({ url: "https://x/a", mime: "image/png", filename: "a b c.png" }),
    );
    expect(parsed?.filename).toBe("a b c.png");
  });

  it("reads a minimal cross-client tag rather than dropping it", () => {
    expect(lib.parseImetaTag(["imeta", "url https://x/a", "m image/png"])).toEqual({
      url: "https://x/a",
      mime: "image/png",
    });
  });

  it("refuses anything that is not an attachment", () => {
    expect(lib.parseImetaTag(["p", "abc"])).toBeNull();
    expect(lib.parseImetaTag(["imeta"])).toBeNull();
    expect(lib.parseImetaTag(["imeta", "m image/png"])).toBeNull();
    expect(lib.parseImetaTag(["imeta", "url https://x/a"])).toBeNull();
    expect(lib.parseImetaTag(["imeta", "urlhttps://x/a", "m image/png"])).toBeNull();
  });

  it("deduplicates by url, first occurrence winning", () => {
    const tags = [
      ["imeta", "url https://x/a", "m image/png", "dim 10x10"],
      ["h", "chan"],
      ["imeta", "url https://x/a", "m image/png", "dim 99x99"],
      ["imeta", "url https://x/b", "m image/png"],
    ];
    const parsed = lib.parseImetaTags(tags);
    expect(parsed.map((entry) => entry.url)).toEqual(["https://x/a", "https://x/b"]);
    expect(parsed[0].width).toBe(10);
  });

  it("knows a message carries a video", () => {
    expect(lib.hasVideoAttachment([["imeta", "url https://x/a", "m video/mp4"]])).toBe(true);
    expect(lib.hasVideoAttachment([["imeta", "url https://x/a", "m image/png"]])).toBe(false);
    expect(lib.hasVideoAttachment([["h", "chan"]])).toBe(false);
  });

  it("strips everything that is not a media tag", () => {
    expect(
      lib.mediaTagsOnly([
        ["h", "elsewhere"],
        ["imeta", "url https://x/a", "m image/png"],
        ["p", "victim"],
        ["e", "someone-elses-thread", "", "reply"],
      ]),
    ).toEqual([["imeta", "url https://x/a", "m image/png"]]);
  });
});

// ---------------------------------------------------------------------------
// The property that keeps attachments alive across an edit
// ---------------------------------------------------------------------------

describe("a media tag through an edit", () => {
  const image = lib.formatImetaTag({
    url: "https://x/a.png",
    mime: "image/png",
    width: 8,
    height: 6,
  });
  const other = lib.formatImetaTag({ url: "https://x/b.png", mime: "image/png" });

  const original = [["p", "author"], ["h", "chan"], image, ["e", "root", "", "reply"]];

  it("survives an edit that re-emits it", () => {
    const overlaid = applyEditTagOverlay(original, [["h", "chan"], ["e", "target"], image]);
    expect(lib.parseImetaTags(overlaid)).toEqual(lib.parseImetaTags(original));
  });

  it("is replaced wholesale when the edit carries a different set", () => {
    const overlaid = applyEditTagOverlay(original, [["e", "target"], other]);
    expect(lib.parseImetaTags(overlaid).map((entry) => entry.url)).toEqual(["https://x/b.png"]);
  });

  it("is removed by an edit that carries none — which is why the edit path re-emits", () => {
    // Not a bug in the overlay: this is exactly what it is specified to do, and
    // it is the reason `buzz/media.edit` exists rather than `buzz/messages.edit`
    // being used on a message with attachments.
    const overlaid = applyEditTagOverlay(original, [["e", "target"]]);
    expect(lib.parseImetaTags(overlaid)).toEqual([]);
  });

  it("cannot smuggle a room, a mention or a thread through the edit", () => {
    const overlaid = applyEditTagOverlay(original, [
      ["h", "somewhere-else"],
      ["p", "victim"],
      ["e", "another-thread", "", "reply"],
      image,
    ]);
    expect(overlaid.filter((tag) => tag[0] === "h")).toEqual([["h", "chan"]]);
    expect(overlaid.filter((tag) => tag[0] === "p")).toEqual([["p", "author"]]);
    expect(overlaid.filter((tag) => tag[0] === "e")).toEqual([["e", "root", "", "reply"]]);
  });
});

// ---------------------------------------------------------------------------
// The body lines
// ---------------------------------------------------------------------------

describe("media lines in the body", () => {
  const picture: lib.MediaDescriptor = { url: "https://x/a.png", mime: "image/png" };
  const clip: lib.MediaDescriptor = { url: "https://x/a.mp4", mime: "video/mp4" };
  const doc: lib.MediaDescriptor = {
    url: "https://x/a.pdf",
    mime: "application/pdf",
    filename: "report.pdf",
  };

  it("draws each kind in its own form", () => {
    expect(lib.formatMediaLine(picture)).toBe("![image](https://x/a.png)");
    expect(lib.formatMediaLine(clip)).toBe("![video](https://x/a.mp4)");
    expect(lib.formatMediaLine(doc)).toBe("[report.pdf](https://x/a.pdf)");
  });

  it("escapes a filename that would break the link", () => {
    expect(
      lib.formatMediaLine({ ...doc, filename: "a [b] c\\d.pdf" }),
    ).toBe("[a \\[b\\] c\\\\d.pdf](https://x/a.pdf)");
  });

  it("round-trips: appended lines come back off", () => {
    const body = "look at this";
    const withMedia = lib.appendMediaLines(body, [picture, clip]);
    expect(withMedia).toBe(
      "look at this\n![image](https://x/a.png)\n![video](https://x/a.mp4)",
    );
    expect(lib.stripMediaLines(withMedia, [picture, clip])).toBe(body);
  });

  it("carries a picture with no words at all", () => {
    expect(lib.appendMediaLines("", [picture])).toBe("![image](https://x/a.png)");
    expect(lib.stripMediaLines("![image](https://x/a.png)", [picture])).toBe("");
  });

  it("stops at the first line that is not a media line", () => {
    // The link in the middle of the sentence is the one people actually write.
    const body = "see ![image](https://x/a.png) here\n![image](https://x/a.png)";
    expect(lib.stripMediaLines(body, [picture])).toBe("see ![image](https://x/a.png) here");
  });

  it("leaves a link to something that is not attached alone", () => {
    const body = "notes\n[elsewhere](https://evil.test/x)";
    expect(lib.stripMediaLines(body, [picture])).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe("what may be attached", () => {
  const ok = (over: Partial<lib.AttachmentCandidate> = {}) =>
    lib.checkAttachment({ mime: "image/png", sizeBytes: 1000, ...over });

  it("accepts an ordinary image", () => {
    expect(ok()).toBeNull();
  });

  it("refuses active content and executables", () => {
    for (const mime of [
      "text/html",
      "image/svg+xml",
      "application/javascript",
      "application/x-msdownload",
      "application/vnd.android.package-archive",
    ]) {
      expect(ok({ mime })).toMatch(/cannot be attached/);
    }
  });

  it("refuses audio outright — there is no player and no sanitizer", () => {
    expect(ok({ mime: "audio/mpeg" })).toMatch(/cannot be attached/);
    expect(ok({ mime: "audio/anything" })).toMatch(/cannot be attached/);
  });

  it("refuses an image or video type it cannot draw, rather than filing it as a file", () => {
    expect(ok({ mime: "image/heic" })).toMatch(/cannot be attached/);
    expect(ok({ mime: "video/quicktime" })).toMatch(/cannot be attached/);
  });

  it("caps a GIF below the image cap", () => {
    expect(ok({ mime: "image/gif", sizeBytes: lib.LIMITS.gifBytes })).toBeNull();
    expect(ok({ mime: "image/gif", sizeBytes: lib.LIMITS.gifBytes + 1 })).toMatch(/GIFs/);
    // The same bytes as a JPEG are fine — the cap is per type, not per pixel.
    expect(ok({ mime: "image/jpeg", sizeBytes: lib.LIMITS.gifBytes + 1 })).toBeNull();
  });

  it("caps each kind at its own size", () => {
    expect(ok({ sizeBytes: lib.LIMITS.imageBytes + 1 })).toMatch(/Images/);
    expect(ok({ mime: "video/mp4", sizeBytes: lib.LIMITS.videoBytes + 1 })).toMatch(/Videos/);
    expect(ok({ mime: "application/pdf", sizeBytes: lib.LIMITS.fileBytes + 1 })).toMatch(/Files/);
  });

  it("guards against an image bomb", () => {
    expect(ok({ width: 30000, height: 30000 })).toMatch(/megapixels/);
    expect(ok({ width: 4000, height: 4000 })).toBeNull();
  });

  it("bounds a video's length and its frame", () => {
    const video = { mime: "video/mp4", sizeBytes: 1000 };
    expect(lib.checkAttachment({ ...video, durationSecs: 601 })).toMatch(/minutes/);
    expect(lib.checkAttachment({ ...video, durationSecs: 599 })).toBeNull();
    expect(lib.checkAttachment({ ...video, width: 7680, height: 4320 })).toMatch(/limited to/);
  });

  it("refuses an empty file", () => {
    expect(ok({ sizeBytes: 0 })).toMatch(/empty/);
  });

  it("keeps only the final path segment of a filename", () => {
    expect(lib.sanitizeFilename("C:\\Users\\ada\\holiday snap.png")).toBe("holiday snap.png");
    expect(lib.sanitizeFilename("/var/tmp/x.pdf")).toBe("x.pdf");
    expect(lib.sanitizeFilename("")).toBe("file");
    expect(lib.sanitizeFilename("a\u0000b\u001fc.png")).toBe("abc.png");
    expect(lib.sanitizeFilename("x".repeat(400)).length).toBe(lib.LIMITS.filenameChars);
  });

  it("formats a size a person can read", () => {
    expect(lib.formatBytes(0)).toBe("0 B");
    expect(lib.formatBytes(900)).toBe("900 B");
    expect(lib.formatBytes(1024)).toBe("1 KB");
    expect(lib.formatBytes(1536)).toBe("1.5 KB");
    expect(lib.formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });
});

// ---------------------------------------------------------------------------
// The timecode grammar (§2.10) — the distinctive feature's whole trick
// ---------------------------------------------------------------------------

describe("reading a timecode", () => {
  it("accepts the three written forms", () => {
    expect(lib.parseTimecodedComment("[01:23] the logo pops here")).toEqual({
      seconds: 83,
      timecode: "01:23",
      text: "the logo pops here",
    });
    expect(lib.parseTimecodedComment("[00:07.5] audio clips")).toEqual({
      seconds: 7.5,
      timecode: "00:07.5",
      text: "audio clips",
    });
    expect(lib.parseTimecodedComment("[1:02:03] the second act")).toEqual({
      seconds: 3723,
      timecode: "1:02:03",
      text: "the second act",
    });
  });

  it("tolerates space before the bracket and none after it", () => {
    expect(lib.parseTimecodedComment("  [01:23]no space").seconds).toBe(83);
    expect(lib.parseTimecodedComment("[01:23]no space").text).toBe("no space");
  });

  // The near-misses. Each of these is somebody's ordinary sentence, and each of
  // them must come back untouched.
  it("leaves a bracketed number that is not a timecode completely alone", () => {
    for (const body of [
      "[12] apples left",
      "[3] see the appendix",
      "[TODO] ship it",
      "[v2] rewrite",
      "[1:2] not a timecode",
      "[100:00] too many minutes",
      "[ 01:23] a space inside",
      "[01:23 unclosed",
      "01:23] no opening",
      "the logo pops at [01:23]",
      "",
    ]) {
      const parsed = lib.parseTimecodedComment(body);
      expect([body, parsed.seconds]).toEqual([body, null]);
      expect([body, parsed.text]).toEqual([body, body]);
    }
  });

  it("rejects a one-part or four-part timecode at the parse step", () => {
    expect(lib.parseTimecode("12")).toBeNull();
    expect(lib.parseTimecode("1:2:3:4")).toBeNull();
    expect(lib.parseTimecode("")).toBeNull();
    expect(lib.parseTimecode("1:")).toBeNull();
  });

  it("matches the regex on a bare pair of digits but refuses to read it", () => {
    // The regex cannot exclude `[12]` without excluding the colon forms it is
    // built from. The exclusion is one step later, which is why nothing calls
    // the regex on its own.
    expect(lib.TIMECODE_RE.test("[12] apples")).toBe(true);
    expect(lib.parseTimecodedComment("[12] apples").seconds).toBeNull();
  });
});

describe("writing a timecode", () => {
  it("writes minutes and seconds, and hours only when there are hours", () => {
    expect(lib.formatTimecode(0)).toBe("00:00");
    expect(lib.formatTimecode(83)).toBe("01:23");
    expect(lib.formatTimecode(3599)).toBe("59:59");
    expect(lib.formatTimecode(3600)).toBe("1:00:00");
    expect(lib.formatTimecode(3723)).toBe("1:02:03");
  });

  it("drops a zero fraction and keeps a real one", () => {
    expect(lib.formatCommentTimecode(83)).toBe("01:23");
    expect(lib.formatCommentTimecode(7.5)).toBe("00:07.5");
    expect(lib.formatCommentTimecode(7.04)).toBe("00:07");
  });

  it("carries a rounded fraction into the minute rather than writing 00:60", () => {
    // The classic version of this bug only shows on the last frame of a minute,
    // which is exactly where people leave comments.
    expect(lib.formatCommentTimecode(59.96)).toBe("01:00");
    expect(lib.formatCommentTimecode(3599.99)).toBe("1:00:00");
  });

  it("clamps nonsense to zero instead of writing NaN:NaN", () => {
    expect(lib.formatCommentTimecode(Number.NaN)).toBe("00:00");
    expect(lib.formatCommentTimecode(-5)).toBe("00:00");
    expect(lib.formatCommentTimecode(Number.POSITIVE_INFINITY)).toBe("00:00");
  });

  it("round-trips every tenth of a second across an hour and a bit", () => {
    for (let tenths = 0; tenths <= 40000; tenths += 7) {
      const seconds = tenths / 10;
      const body = lib.stampComment(seconds, "note");
      const parsed = lib.parseTimecodedComment(body);
      expect([seconds, parsed.seconds]).toEqual([seconds, seconds]);
      expect(parsed.text).toBe("note");
    }
  });

  it("refuses to stamp a comment twice", () => {
    expect(lib.stampComment(3, "[00:05] I know when it is")).toBe("[00:05] I know when it is");
    expect(lib.alreadyStamped("[00:05] x")).toBe(true);
    expect(lib.alreadyStamped("[5] x")).toBe(false);
  });

  it("stamps an ordinary sentence", () => {
    expect(lib.stampComment(83, "  the logo pops here  ")).toBe("[01:23] the logo pops here");
  });
});

// ---------------------------------------------------------------------------
// Threading the comments
// ---------------------------------------------------------------------------

describe("a video's comments", () => {
  const at = (id: string, body: string, createdAt: number, parentId?: string) => ({
    id,
    body,
    createdAt,
    ...(parentId ? { parentId } : {}),
  });

  it("attaches a reply-to-a-reply to the video too", () => {
    const comments = [
      at("c1", "[00:10] one", 10, "video"),
      at("c2", "answering c1", 20, "c1"),
      at("c3", "answering c2", 30, "c2"),
    ];
    const byRoot = lib.commentsByRoot(comments);
    expect(byRoot.get("video")?.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(byRoot.get("c1")?.map((c) => c.id)).toEqual(["c2", "c3"]);
  });

  it("does not hang on a cycle", () => {
    const comments = [at("a", "x", 1, "b"), at("b", "y", 2, "a")];
    expect(() => lib.commentsByRoot(comments)).not.toThrow();
  });

  it("sorts stamped comments by moment and un-stamped ones last", () => {
    const comments = [
      at("d", "no timecode", 5),
      at("a", "[00:30] late", 1),
      at("b", "[00:05] early", 2),
      at("c", "[00:05] also early", 3),
      at("e", "another with none", 4),
    ];
    expect(lib.sortTimecodedComments(comments).map((c) => c.id)).toEqual([
      "b",
      "c",
      "a",
      "e",
      "d",
    ]);
  });

  it("flattens a deep chain to one level under its top ancestor", () => {
    const comments = [
      at("c1", "[00:10] one", 10, "video"),
      at("c2", "answering c1", 20, "c1"),
      at("c3", "answering c2", 30, "c2"),
      at("c4", "[00:01] separate", 40, "video"),
    ];
    const nested = lib.nestOneLevel(comments, "video");
    expect(nested.map((entry) => entry.comment.id)).toEqual(["c4", "c1"]);
    expect(nested[1].replies.map((c) => c.id)).toEqual(["c2", "c3"]);
  });

  it("treats a reply whose parent was not loaded as top-level", () => {
    const nested = lib.nestOneLevel([at("c9", "orphan", 1, "gone")], "video");
    expect(nested.map((entry) => entry.comment.id)).toEqual(["c9"]);
  });
});

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx: Ctx) => {
    for (const person of [ALICE, BOB, OUTSIDER]) {
      await ctx.db.insert("users", {
        clerkId: person.subject,
        email: `${person.subject}@example.test`,
        name: person.subject,
      });
      await ctx.db.insert("buzzKeys", {
        principalType: "user",
        principalId: person.subject,
        pubkey: publicKeyFromSecret(KEYS[person.subject]),
        secretKey: KEYS[person.subject],
        createdAt: Date.now(),
      });
    }
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Acme",
      slug: "acme",
      ownerClerkId: ALICE.subject,
      createdAt: Date.now(),
    });
    for (const [subject, role] of [
      [ALICE.subject, "owner"],
      [BOB.subject, "member"],
    ] as const) {
      await ctx.db.insert("memberships", {
        userClerkId: subject,
        workspaceId,
        role,
        joinedAt: Date.now(),
      });
    }
    return { workspaceId };
  });
  const scope: Scope = { scopeType: "workspace", scopeId: ids.workspaceId };
  const channelId = (
    (await t.withIdentity(ALICE).mutation(channels.create, {
      ...scope,
      name: "general",
    })) as { channelId: string }
  ).channelId;
  return { t, scope, channelId };
}

type Harness = ReturnType<typeof convexTest>;

async function store(
  t: Harness,
  bytes: Uint8Array,
  type: string,
): Promise<string> {
  return (await t.run(async (ctx: Ctx) =>
    ctx.storage.store(new Blob([bytes as unknown as BlobPart], { type })),
  )) as string;
}

const tiny = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function imetaOf(event: Event): lib.MediaDescriptor[] {
  return lib.parseImetaTags(event.tags);
}

describe("the upload door", () => {
  it("is closed to somebody outside the community", async () => {
    const { t, scope, channelId } = await seed();
    await expect(
      t.withIdentity(OUTSIDER).mutation(media.generateUploadUrl, { ...scope, channelId }),
    ).rejects.toThrow();
  });

  it("is closed to somebody who has not joined an open room", async () => {
    const { t, scope, channelId } = await seed();
    // Bob is in the community and can read #general, but has not joined it.
    await expect(
      t.withIdentity(BOB).mutation(media.generateUploadUrl, { ...scope, channelId }),
    ).rejects.toThrow(/Join this channel/);
  });

  it("opens for a member", async () => {
    const { t, scope, channelId } = await seed();
    const url = await t
      .withIdentity(ALICE)
      .mutation(media.generateUploadUrl, { ...scope, channelId });
    expect(typeof url).toBe("string");
  });

  it("is closed on an archived room", async () => {
    const { t, scope, channelId } = await seed();
    await t
      .withIdentity(ALICE)
      .mutation(channels.setArchived, { ...scope, channelId, archived: true });
    await expect(
      t.withIdentity(ALICE).mutation(media.generateUploadUrl, { ...scope, channelId }),
    ).rejects.toThrow(/archived/);
  });
});

describe("posting with an attachment", () => {
  it("writes one imeta tag and one body line, and the body line points at the tag", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "image/png");
    await t.withIdentity(ALICE).mutation(media.post, {
      ...scope,
      channelId,
      body: "look at this",
      attachments: [
        { storageId, filename: "/tmp/holiday snap.png", mimeType: "image/png", width: 8, height: 6 },
      ],
    });

    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as Page;
    const posted = page.events.find((event) => event.kind === 9);
    expect(posted).toBeDefined();

    const parsed = imetaOf(posted!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].mime).toBe("image/png");
    expect(parsed[0].width).toBe(8);
    expect(parsed[0].height).toBe(6);
    // The size and the checksum come from the store, never from the caller.
    expect(parsed[0].sizeBytes).toBe(8);
    expect(parsed[0].sha256).toBeTruthy();
    // The filename is the final segment.
    expect(parsed[0].filename).toBe("holiday snap.png");

    expect(posted!.content).toContain("look at this");
    expect(posted!.content).toContain(`![image](${parsed[0].url})`);
    expect(lib.stripMediaLines(posted!.content, parsed)).toBe("look at this");
  });

  it("lets a picture be the whole message", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "image/png");
    await t.withIdentity(ALICE).mutation(media.post, {
      ...scope,
      channelId,
      body: "",
      attachments: [{ storageId, filename: "a.png", mimeType: "image/png" }],
    });
    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as Page;
    expect(imetaOf(page.events.find((event) => event.kind === 9)!)).toHaveLength(1);
  });

  it("refuses a message with neither words nor files", async () => {
    const { t, scope, channelId } = await seed();
    await expect(
      t
        .withIdentity(ALICE)
        .mutation(media.post, { ...scope, channelId, body: "", attachments: [] }),
    ).rejects.toThrow();
  });

  it("refuses somebody outside the community, whatever they uploaded", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "image/png");
    await expect(
      t.withIdentity(OUTSIDER).mutation(media.post, {
        ...scope,
        channelId,
        body: "mine now",
        attachments: [{ storageId, filename: "a.png", mimeType: "image/png" }],
      }),
    ).rejects.toThrow();
  });

  it("refuses a blocked type server-side, whatever the UI would have allowed", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "text/html");
    for (const mimeType of ["text/html", "image/svg+xml", "audio/mpeg", "video/quicktime"]) {
      await expect(
        t.withIdentity(ALICE).mutation(media.post, {
          ...scope,
          channelId,
          body: "",
          attachments: [{ storageId, filename: "x", mimeType }],
        }),
      ).rejects.toThrow(/cannot be attached/);
    }
  });

  it("refuses more attachments than a message may carry", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "image/png");
    const one = { storageId, filename: "a.png", mimeType: "image/png" };
    await expect(
      t.withIdentity(ALICE).mutation(media.post, {
        ...scope,
        channelId,
        body: "",
        attachments: Array.from({ length: server.LIMITS.attachmentsPerMessage + 1 }, () => one),
      }),
    ).rejects.toThrow(/at most/);
  });

  it("refuses an upload that does not exist", async () => {
    const { t, scope, channelId } = await seed();
    const real = await store(t, tiny(), "image/png");
    // A well-formed id for a row that was never written.
    const missing = real.replace(/^.{4}/, "9999");
    await expect(
      t.withIdentity(ALICE).mutation(media.post, {
        ...scope,
        channelId,
        body: "",
        attachments: [{ storageId: missing, filename: "a.png", mimeType: "image/png" }],
      }),
    ).rejects.toThrow();
  });

  it("refuses an image bomb and an over-long video from the declared metadata", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "image/png");
    await expect(
      t.withIdentity(ALICE).mutation(media.post, {
        ...scope,
        channelId,
        body: "",
        attachments: [
          { storageId, filename: "a.png", mimeType: "image/png", width: 30000, height: 30000 },
        ],
      }),
    ).rejects.toThrow(/too large/);

    await expect(
      t.withIdentity(ALICE).mutation(media.post, {
        ...scope,
        channelId,
        body: "",
        attachments: [
          { storageId, filename: "a.mp4", mimeType: "video/mp4", durationSecs: 3600 },
        ],
      }),
    ).rejects.toThrow(/minutes/);
  });

  it("takes the size from the store, and applies the GIF cap rather than the image cap", async () => {
    const { t, scope, channelId } = await seed();
    // The smallest cap in the table, so this is the cheapest honest proof that a
    // limit is enforced where the bytes are rather than where the UI is.
    const oversize = new Uint8Array(server.LIMITS.gifBytes + 1);
    const storageId = await store(t, oversize, "image/gif");

    await expect(
      t.withIdentity(ALICE).mutation(media.post, {
        ...scope,
        channelId,
        body: "",
        attachments: [{ storageId, filename: "a.gif", mimeType: "image/gif" }],
      }),
    ).rejects.toThrow(/larger than/);

    // The same bytes, under the image cap, go through.
    await t.withIdentity(ALICE).mutation(media.post, {
      ...scope,
      channelId,
      body: "",
      attachments: [{ storageId, filename: "a.jpg", mimeType: "image/jpeg" }],
    });
    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as Page;
    expect(imetaOf(page.events.find((event) => event.kind === 9)!)[0].sizeBytes).toBe(
      server.LIMITS.gifBytes + 1,
    );
  }, 30_000);

  it("carries a video's poster and a thumbnail as their own blobs", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "video/mp4");
    const posterStorageId = await store(t, new Uint8Array([9, 9, 9]), "image/jpeg");
    await t.withIdentity(ALICE).mutation(media.post, {
      ...scope,
      channelId,
      body: "",
      attachments: [
        {
          storageId,
          posterStorageId,
          filename: "clip.mp4",
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSecs: 12,
        },
      ],
    });
    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as Page;
    const parsed = imetaOf(page.events.find((event) => event.kind === 9)!)[0];
    expect(parsed.posterUrl).toBeTruthy();
    expect(parsed.posterUrl).not.toBe(parsed.url);
    expect(parsed.durationSecs).toBe(12);
    expect(page.events.find((event) => event.kind === 9)!.content).toContain("![video](");
  });
});

describe("editing a message that has attachments", () => {
  async function postWithImage() {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "image/png");
    const { eventId } = (await t.withIdentity(ALICE).mutation(media.post, {
      ...scope,
      channelId,
      body: "frist post",
      attachments: [{ storageId, filename: "a.png", mimeType: "image/png", width: 8, height: 6 }],
    })) as { eventId: string };
    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as Page;
    const original = page.events.find((event) => event.id === eventId)!;
    return { t, scope, channelId, eventId, media: imetaOf(original) };
  }

  /** What a reader would actually see, through the real projection. */
  async function rendered(t: Harness, scope: Scope, channelId: string, eventId: string) {
    const page = (await t
      .withIdentity(ALICE)
      .query(messages.list, { ...scope, channelId })) as Page;
    const rows = projectTimeline(page.events, {
      selfPubkey: publicKeyFromSecret(KEYS[ALICE.subject]),
    });
    for (const row of rows) {
      if (row.type === "message" && row.message.id === eventId) return row.message;
    }
    return null;
  }

  it("keeps the picture when only the words change", async () => {
    const { t, scope, channelId, eventId, media: attached } = await postWithImage();
    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "first post",
      keepUrls: attached.map((entry) => entry.url),
    });

    const shown = await rendered(t, scope, channelId, eventId);
    expect(shown?.edited).toBe(true);
    // The whole point of the phase, asserted through the real overlay rather
    // than through a unit test of the overlay.
    expect(lib.parseImetaTags(shown!.tags)).toEqual(attached);
    expect(lib.stripMediaLines(shown!.body, attached)).toBe("first post");
  });

  it("keeps the picture's dim and thumb rather than rebuilding them", async () => {
    const { t, scope, channelId, eventId, media: attached } = await postWithImage();
    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "first post",
      keepUrls: attached.map((entry) => entry.url),
    });
    const shown = await rendered(t, scope, channelId, eventId);
    expect(lib.parseImetaTags(shown!.tags)[0].width).toBe(8);
    expect(lib.parseImetaTags(shown!.tags)[0].sha256).toBe(attached[0].sha256);
  });

  it("drops an attachment the edit does not keep", async () => {
    const { t, scope, channelId, eventId } = await postWithImage();
    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "no picture after all",
      keepUrls: [],
    });
    const shown = await rendered(t, scope, channelId, eventId);
    expect(lib.parseImetaTags(shown!.tags)).toEqual([]);
    expect(shown!.body).toBe("no picture after all");
  });

  it("refuses to draw a url the message never carried", async () => {
    const { t, scope, channelId, eventId } = await postWithImage();
    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "look",
      keepUrls: ["https://tracker.test/pixel.png"],
    });
    const shown = await rendered(t, scope, channelId, eventId);
    expect(shown!.tags.some((tag) => JSON.stringify(tag).includes("tracker.test"))).toBe(false);
    expect(shown!.body).not.toContain("tracker.test");
  });

  it("adds a new upload beside the one it keeps", async () => {
    const { t, scope, channelId, eventId, media: attached } = await postWithImage();
    const second = await store(t, new Uint8Array([7, 7, 7, 7]), "image/png");
    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "two now",
      keepUrls: attached.map((entry) => entry.url),
      attachments: [{ storageId: second, filename: "b.png", mimeType: "image/png" }],
    });
    const shown = await rendered(t, scope, channelId, eventId);
    expect(lib.parseImetaTags(shown!.tags)).toHaveLength(2);
    expect(lib.parseImetaTags(shown!.tags)[0].url).toBe(attached[0].url);
  });

  it("survives a second edit — the keep-list reads the current media, not the original", async () => {
    const { t, scope, channelId, eventId, media: attached } = await postWithImage();
    const second = await store(t, new Uint8Array([7, 7, 7, 7]), "image/png");
    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "swapped",
      keepUrls: [],
      attachments: [{ storageId: second, filename: "b.png", mimeType: "image/png" }],
    });
    const afterFirst = await rendered(t, scope, channelId, eventId);
    const swapped = lib.parseImetaTags(afterFirst!.tags);
    expect(swapped).toHaveLength(1);
    expect(swapped[0].url).not.toBe(attached[0].url);

    await t.withIdentity(ALICE).mutation(media.edit, {
      ...scope,
      channelId,
      targetId: eventId,
      body: "swapped again",
      keepUrls: swapped.map((entry) => entry.url),
    });
    const afterSecond = await rendered(t, scope, channelId, eventId);
    expect(lib.parseImetaTags(afterSecond!.tags)).toEqual(swapped);
  });

  it("is refused for somebody who is not the author", async () => {
    const { t, scope, channelId, eventId, media: attached } = await postWithImage();
    await t.withIdentity(BOB).mutation(channels.join, { ...scope, channelId });
    await expect(
      t.withIdentity(BOB).mutation(media.edit, {
        ...scope,
        channelId,
        targetId: eventId,
        body: "not mine",
        keepUrls: attached.map((entry) => entry.url),
      }),
    ).rejects.toThrow(/author/);
  });
});

describe("frame-anchored comments over the wire", () => {
  it("are ordinary thread replies — no new kind, no new field", async () => {
    const { t, scope, channelId } = await seed();
    const storageId = await store(t, tiny(), "video/mp4");
    const { eventId } = (await t.withIdentity(ALICE).mutation(media.post, {
      ...scope,
      channelId,
      body: "review please",
      attachments: [
        { storageId, filename: "clip.mp4", mimeType: "video/mp4", durationSecs: 30 },
      ],
    })) as { eventId: string };

    await t.withIdentity(ALICE).mutation(messages.post, {
      ...scope,
      channelId,
      body: lib.stampComment(7.5, "audio clips"),
      parentId: eventId,
    });

    const thread = (await t
      .withIdentity(ALICE)
      .query(messages.thread, { ...scope, channelId, rootId: eventId })) as Page;
    const reply = thread.events.find(
      (event) => event.kind === 9 && event.id !== eventId,
    );
    expect(reply).toBeDefined();
    expect(reply!.content).toBe("[00:07.5] audio clips");
    expect(lib.parseTimecodedComment(reply!.content)).toEqual({
      seconds: 7.5,
      timecode: "00:07.5",
      text: "audio clips",
    });
    // And the video it hangs off is found the ordinary way.
    expect(lib.hasVideoAttachment(thread.events.find((e) => e.id === eventId)!.tags)).toBe(true);
  });
});
