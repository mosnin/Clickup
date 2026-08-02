// Attachments: bytes in Convex file storage, an `imeta` tag on a signed event.
//
// There is no second uploader here and no second message path. `attachments.ts`
// already established how this app stores a file — a short-lived upload URL, the
// bytes straight into Convex storage, a row (or here, a tag) holding metadata
// that points at the blob — and `messages.postMessageCore` already established
// how anything gets said in a room. This file is the join between them, and it
// is deliberately thin:
//
//   upload URL (gated on the room)  →  storageId
//   storageId + declared metadata   →  validated descriptor
//   descriptors                     →  `imeta` tags + markdown body lines
//   both                            →  postMessageCore / editMessageCore
//
// **Why the edit path is here at all.** An edit is a 40003 that overlays the
// message, and `timeline.applyEditTagOverlay` replaces exactly the `imeta`
// family — so an edit published without them does not "leave the attachments
// alone", it removes them. Editing a caption would silently delete the picture.
// That is the same failure as the Pages editor's Image block, and the fix is the
// same: the write path that owns the media has to re-emit it.
//
// **What is honestly not here**, because we do not have it and a stub that
// produced nothing would be worse than an absence:
//
//   - *Magic-byte sniffing.* Buzz sniffs 4096 bytes and never trusts a declared
//     Content-Type (§2.3). A Convex mutation cannot read a stored blob at all —
//     only an action can — so the declared MIME is cross-checked against the
//     storage row's own `contentType` when the upload set one, and against an
//     allow-list either way. A file that lies about its type gets in; what it
//     cannot do is get *rendered*, because the renderer draws only the image and
//     video types and everything else is a download card.
//   - *Transcoding and server thumbnails.* No ffmpeg, no image library. The
//     thumbnail and the video poster are produced in the browser and uploaded as
//     ordinary blobs, so `thumb` and `image` point at real bytes — they are not
//     absent and they are not fabricated.
//   - *Blurhash.* Nothing generates one. The frame is sized from `dim` instead,
//     which is what stopped the reflow; the placeholder is a plain tint.
//   - *Orphan collection.* An upload that is never attached leaves bytes in
//     storage. There is deliberately no `discard` mutation: without an ownership
//     row, a delete-by-storage-id is a way for anybody holding an id to destroy
//     a blob a message still references. Orphans are the cheaper mistake.

import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireChannelAccess } from "./channels";
import { editMessageCore, postMessageCore } from "./messages";
import type { Scope } from "./log";

const scopeArgs = {
  scopeType: v.union(v.literal("user"), v.literal("workspace")),
  scopeId: v.string(),
};

/** The edit kind, so the "what does this message currently show" walk can find them. */
const KIND_STREAM_MESSAGE_EDIT = 40003;

// ---------------------------------------------------------------------------
// The rules, restated for the server
// ---------------------------------------------------------------------------
//
// `src/lib/buzz/media.ts` holds the same constants and the same tag encoder for
// the browser. Restated rather than imported because `convex/` deploys as its
// own bundle and its only edge into the Next tree is a type import — the same
// reason `mentionedActorIds` is restated in messages.ts.
//
// The duplication is real, and it is pinned rather than trusted:
// `tests/buzz-media.test.ts` imports both modules and asserts they agree on
// every limit, every MIME verdict and the exact bytes of an encoded tag. A tag
// encoder that drifted by one space would produce attachments the browser could
// not parse, so "the two files agree" is a property with a test rather than a
// convention with a comment.

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const VIDEO_MIME_TYPES = ["video/mp4", "video/webm"];
const BLOCKED_MIME_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/x-msdownload",
  "application/x-executable",
  "application/x-elf",
  "application/x-sharedlib",
  "application/x-msi",
  "application/vnd.android.package-archive",
  "application/x-apple-diskimage",
];

export const LIMITS = {
  imageBytes: 50 * 1024 * 1024,
  gifBytes: 10 * 1024 * 1024,
  videoBytes: 500 * 1024 * 1024,
  fileBytes: 100 * 1024 * 1024,
  imagePixels: 25 * 1_000_000,
  videoDurationSecs: 600,
  videoWidth: 3840,
  videoHeight: 2160,
  attachmentsPerMessage: 10,
  filenameChars: 255,
} as const;

/**
 * How many `imeta` tags may be kept from a message being edited.
 *
 * The keep-list is checked against what the message already carries, so this is
 * not a trust bound — it is the bound on how much of the log one edit reads.
 */
const MAX_EDIT_HISTORY = 64;

export type MediaKind = "image" | "video" | "file";

export function normalizeMime(mime: string): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

export function isBlockedMime(mime: string): boolean {
  const normal = normalizeMime(mime);
  if (!normal) return true;
  if (normal.startsWith("audio/")) return true;
  return BLOCKED_MIME_TYPES.includes(normal);
}

export function mediaKindOf(mime: string): MediaKind | null {
  const normal = normalizeMime(mime);
  if (!normal) return null;
  if (isBlockedMime(normal)) return null;
  if (IMAGE_MIME_TYPES.includes(normal)) return "image";
  if (VIDEO_MIME_TYPES.includes(normal)) return "video";
  if (normal.startsWith("image/") || normal.startsWith("video/")) return null;
  return "file";
}

export function sizeCapFor(mime: string): number {
  const normal = normalizeMime(mime);
  if (normal === "image/gif") return LIMITS.gifBytes;
  const kind = mediaKindOf(normal);
  if (kind === "image") return LIMITS.imageBytes;
  if (kind === "video") return LIMITS.videoBytes;
  return LIMITS.fileBytes;
}

export function sanitizeFilename(raw: string): string {
  const segment = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = segment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, LIMITS.filenameChars) || "file";
}

export type MediaDescriptor = {
  url: string;
  mime: string;
  sha256?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  thumbUrl?: string;
  posterUrl?: string;
  durationSecs?: number;
  blurhash?: string;
  filename?: string;
};

/**
 * The tag, byte for byte as the browser writes it.
 *
 * Field order is fixed because a Nostr event id is the hash of its tags: two
 * encodings of one attachment are two different messages, and a retried send
 * would stop being idempotent and post twice.
 */
export function formatImetaTag(media: MediaDescriptor): string[] {
  const parts: string[] = [`url ${media.url}`, `m ${normalizeMime(media.mime)}`];
  if (media.sha256) parts.push(`x ${media.sha256}`);
  if (media.sizeBytes && media.sizeBytes > 0) parts.push(`size ${Math.round(media.sizeBytes)}`);
  if (media.width && media.height) parts.push(`dim ${media.width}x${media.height}`);
  if (media.blurhash) parts.push(`blurhash ${media.blurhash}`);
  if (media.thumbUrl) parts.push(`thumb ${media.thumbUrl}`);
  if (media.durationSecs && media.durationSecs > 0) {
    parts.push(`duration ${Math.round(media.durationSecs)}`);
  }
  if (media.posterUrl) parts.push(`image ${media.posterUrl}`);
  if (media.filename) parts.push(`filename ${media.filename}`);
  return ["imeta", ...parts];
}

/** The markdown line that goes beside the tag (§2.7 — both are required). */
export function formatMediaLine(media: MediaDescriptor): string {
  const kind = mediaKindOf(media.mime);
  if (kind === "video") return `![video](${media.url})`;
  if (kind === "image") return `![image](${media.url})`;
  const label = (media.filename ?? "file").replace(/([[\]\\])/g, "\\$1");
  return `[${label}](${media.url})`;
}

function appendMediaLines(body: string, media: readonly MediaDescriptor[]): string {
  if (media.length === 0) return body;
  const lines = media.map(formatMediaLine).join("\n");
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n${lines}` : lines;
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/**
 * A place to put bytes, for somebody who may put bytes in **this room**.
 *
 * The room and not just the community: a Convex upload URL is a capability, and
 * the honest bound on it is the smallest surface the person is actually
 * attaching to. `requireChannelAccess` is the tenancy fence (`requireScopeAccess`
 * plus the room's own visibility rule) and membership is what writing needs —
 * the same pair `messages.postMessageCore` enforces when the message lands, so a
 * URL handed out here can only ever be attached by somebody who could already
 * have posted.
 *
 * Deliberately not a query: it mints something.
 */
export const generateUploadUrl = mutation({
  args: { ...scopeArgs, channelId: v.string() },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    const { channel, membership } = await requireChannelAccess(ctx, scope, args.channelId);
    if (!membership) {
      throw new ConvexError(
        channel.visibility === "open"
          ? "Join this channel before attaching files to it"
          : "You are not in this channel",
      );
    }
    if (channel.archivedAt !== undefined) throw new ConvexError("This channel is archived");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * What the client says about a blob it just uploaded.
 *
 * Everything here except the ids is a *claim*, and the claims that can be
 * checked are checked: the size and the checksum come from the storage row
 * rather than from this object, and the declared MIME must agree with the one
 * the upload recorded when it recorded one. Dimensions and duration cannot be
 * checked at all without decoding the bytes, so they are bounded rather than
 * verified — a lie about them costs a wrongly-sized frame, not an exploit.
 */
const attachmentArg = v.object({
  storageId: v.id("_storage"),
  filename: v.string(),
  mimeType: v.string(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  durationSecs: v.optional(v.number()),
  /** A downscaled still, produced in the browser and uploaded as its own blob. */
  thumbStorageId: v.optional(v.id("_storage")),
  /** A video's poster frame, same story. NIP-71 `image`. */
  posterStorageId: v.optional(v.id("_storage")),
});

type AttachmentInput = {
  storageId: Id<"_storage">;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSecs?: number;
  thumbStorageId?: Id<"_storage">;
  posterStorageId?: Id<"_storage">;
};

/**
 * A claimed attachment, made into a descriptor, or a refusal.
 *
 * The refusals are the point of this function, and the order matters: the
 * storage row is read **first**, because everything downstream — which cap
 * applies, whether the type is drawable — is decided from bytes that exist. A
 * storageId naming nothing is refused before any of it.
 */
async function resolveAttachment(
  ctx: MutationCtx,
  input: AttachmentInput,
): Promise<MediaDescriptor> {
  const stored = await ctx.db.system.get(input.storageId);
  if (!stored) throw new ConvexError("That upload could not be found");

  const declared = normalizeMime(input.mimeType);
  const recorded = normalizeMime(stored.contentType ?? "");
  // A storage row only carries a content type when the upload sent one. When it
  // did, it is the closer thing to evidence and a disagreement is refused: a
  // client that uploads with one type and attaches with another is either broken
  // or trying to get a type past the allow-list.
  if (recorded && recorded !== declared) {
    throw new ConvexError("That upload's type does not match what was declared");
  }

  const kind = mediaKindOf(declared);
  if (!kind) throw new ConvexError(`${declared || "That kind of"} file cannot be attached here`);

  // The size is the store's, never the caller's. This is the one limit that
  // could otherwise be walked past by sending a smaller number.
  const sizeBytes = stored.size;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw new ConvexError("That file is empty");
  const cap = sizeCapFor(declared);
  if (sizeBytes > cap) {
    throw new ConvexError(`That file is larger than the ${Math.round(cap / 1024 / 1024)} MB limit`);
  }

  const width = positiveInt(input.width);
  const height = positiveInt(input.height);
  if (kind === "image" && width && height && width * height > LIMITS.imagePixels) {
    throw new ConvexError("That image is too large to display");
  }

  const durationSecs = positiveInt(input.durationSecs);
  if (kind === "video") {
    if (durationSecs && durationSecs > LIMITS.videoDurationSecs) {
      throw new ConvexError(`Videos are limited to ${LIMITS.videoDurationSecs / 60} minutes`);
    }
    if ((width && width > LIMITS.videoWidth) || (height && height > LIMITS.videoHeight)) {
      throw new ConvexError(`Videos are limited to ${LIMITS.videoWidth}x${LIMITS.videoHeight}`);
    }
  }

  const url = await ctx.storage.getUrl(input.storageId);
  if (!url) throw new ConvexError("That upload could not be found");

  const media: MediaDescriptor = {
    url,
    mime: declared,
    sizeBytes,
    filename: sanitizeFilename(input.filename),
  };
  // Convex stores the digest base64; the tag carries whatever the store said, so
  // two clients comparing checksums compare the same string.
  if (stored.sha256) media.sha256 = stored.sha256;
  if (width && height) {
    media.width = width;
    media.height = height;
  }
  if (durationSecs) media.durationSecs = durationSecs;

  // A thumbnail or a poster is a blob like any other and is resolved the same
  // way — but a *missing* one is not an error. Both are optimisations of the
  // first paint, and a message that failed to send because its poster upload
  // raced is a message somebody lost.
  if (input.thumbStorageId) {
    const thumbUrl = await ctx.storage.getUrl(input.thumbStorageId);
    if (thumbUrl) media.thumbUrl = thumbUrl;
  }
  if (input.posterStorageId) {
    const posterUrl = await ctx.storage.getUrl(input.posterStorageId);
    if (posterUrl) media.posterUrl = posterUrl;
  }
  return media;
}

async function resolveAttachments(
  ctx: MutationCtx,
  inputs: readonly AttachmentInput[],
): Promise<MediaDescriptor[]> {
  if (inputs.length > LIMITS.attachmentsPerMessage) {
    throw new ConvexError(
      `A message can carry at most ${LIMITS.attachmentsPerMessage} attachments`,
    );
  }
  const out: MediaDescriptor[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const media = await resolveAttachment(ctx, input);
    // The same blob twice is one attachment. Two identical `imeta` tags would
    // draw the same picture twice and give the lightbox two entries for one
    // image.
    if (seen.has(media.url)) continue;
    seen.add(media.url);
    out.push(media);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saying something with files attached
// ---------------------------------------------------------------------------

/**
 * Post a message carrying attachments.
 *
 * Not a second post path: it builds the two halves an attachment is made of —
 * the `imeta` tags and the markdown lines §2.7 requires beside them — and hands
 * both to `postMessageCore`, which is where mentions are parsed, the thread root
 * is derived, the room's clock is bumped, notifications fan out and workflows
 * fire. A media-specific copy of any of those would be a message that looks
 * right and quietly notifies nobody.
 *
 * An empty body is allowed **when there is at least one attachment**, because a
 * picture on its own is a message. `postMessageCore` refuses an empty body, and
 * the media lines are what make this one non-empty — so the refusal still bites
 * on a send with neither.
 */
export const post = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    body: v.string(),
    parentId: v.optional(v.string()),
    rootId: v.optional(v.string()),
    attachments: v.array(attachmentArg),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    // The tenancy fence, before a storage URL is minted or read. `postMessageCore`
    // resolves the room again for the actor, but it does not run
    // `requireScopeAccess` — that is this caller's debt, exactly as it is in
    // `messages.post`.
    await requireChannelAccess(ctx, scope, args.channelId);

    if (args.attachments.length === 0) {
      throw new ConvexError("Attach a file, or send an ordinary message");
    }
    const media = await resolveAttachments(ctx, args.attachments);

    return await postMessageCore(ctx, scope, args.channelId, await selfPrincipal(ctx), {
      body: appendMediaLines(args.body, media),
      ...(args.parentId ? { parentId: args.parentId } : {}),
      ...(args.rootId ? { rootId: args.rootId } : {}),
      extraTags: media.map(formatImetaTag),
    });
  },
});

/**
 * Edit a message that has attachments, keeping them.
 *
 * `keepUrls` is the list of attachments that survive, **in the order they should
 * appear**, and every one of them is checked against what the message already
 * carries. That check is the whole security of this argument: a caller cannot
 * name an arbitrary URL and have it drawn, because the only URLs this will emit
 * are ones already published on this message — so an edit can drop an
 * attachment, reorder attachments, and add new uploads, and cannot turn a
 * message into a frame for somebody else's server.
 *
 * The metadata travels with the URL, verbatim from the tag it came from. Rebuilt
 * from the client's copy it would lose `dim` and `thumb` on every edit, which
 * reads as an image that reflows and loses its progressive load the second time
 * anybody fixes a typo.
 */
export const edit = mutation({
  args: {
    ...scopeArgs,
    channelId: v.string(),
    targetId: v.string(),
    body: v.string(),
    keepUrls: v.optional(v.array(v.string())),
    attachments: v.optional(v.array(attachmentArg)),
  },
  handler: async (ctx, args) => {
    const scope: Scope = { scopeType: args.scopeType, scopeId: args.scopeId };
    await requireChannelAccess(ctx, scope, args.channelId);

    const existing = await currentMediaFor(ctx, scope, args.targetId);
    const kept: MediaDescriptor[] = [];
    for (const url of args.keepUrls ?? []) {
      const found = existing.get(url);
      // Silently skipped rather than refused: the attachment may have been
      // removed by a concurrent edit, and losing the whole edit over a picture
      // that is already gone is the worse outcome.
      if (found && !kept.some((media) => media.url === url)) kept.push(found);
    }

    const added = await resolveAttachments(ctx, args.attachments ?? []);
    const media = [...kept, ...added].slice(0, LIMITS.attachmentsPerMessage);

    return await editMessageCore(ctx, scope, {
      channelId: args.channelId,
      targetId: args.targetId,
      body: appendMediaLines(args.body, media),
      // Media only. `editMessageCore` appends these after the overlay's own
      // tags, and `timeline.applyEditTagOverlay` will only honour `imeta` — but
      // the filter is here too, because "the other end drops it" is not a reason
      // to send it.
      extraTags: media.map(formatImetaTag),
    });
  },
});

/**
 * Every attachment this message currently shows, keyed by URL.
 *
 * The message's own tags **and** the tags of any edit pointing at it, because
 * the overlay means a message that has been edited once shows the edit's media
 * and not the original's. Reading only the original would let an edit resurrect
 * an attachment a previous edit removed.
 *
 * Found through the `#e` tag index rather than by scanning, and bounded: a
 * message edited a thousand times must not make the thousand-and-first edit read
 * the log.
 */
async function currentMediaFor(
  ctx: MutationCtx,
  scope: Scope,
  targetId: string,
): Promise<Map<string, MediaDescriptor>> {
  const target = await ctx.db
    .query("buzzEvents")
    .withIndex("by_scope_event_id", (q) =>
      q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId).eq("eventId", targetId),
    )
    .first();
  if (!target) return new Map();

  const rows = await ctx.db
    .query("buzzEventTags")
    .withIndex("by_tag_kind", (q) =>
      q
        .eq("scopeType", scope.scopeType)
        .eq("scopeId", scope.scopeId)
        .eq("name", "e")
        .eq("value", targetId)
        .eq("kind", KIND_STREAM_MESSAGE_EDIT),
    )
    .take(MAX_EDIT_HISTORY);

  const sources: string[][][] = [target.tags];
  for (const row of rows) {
    const edit = await ctx.db
      .query("buzzEvents")
      .withIndex("by_scope_event_id", (q) =>
        q
          .eq("scopeType", scope.scopeType)
          .eq("scopeId", scope.scopeId)
          .eq("eventId", row.eventId),
      )
      .first();
    // The channel boundary, re-applied on an event reached by reference.
    if (!edit || edit.channelId !== target.channelId) continue;
    sources.push(edit.tags);
  }

  const out = new Map<string, MediaDescriptor>();
  for (const tags of sources) {
    for (const tag of tags) {
      const media = parseImetaTag(tag);
      if (media) out.set(media.url, media);
    }
  }
  return out;
}

/**
 * One `imeta` tag back into a descriptor.
 *
 * The mirror of `formatImetaTag`, and the reason both live in one file: an
 * encoder and a decoder that disagree lose an attachment on the first edit.
 * Split on the first space only, because a filename has spaces and a URL does
 * not.
 */
export function parseImetaTag(tag: readonly string[]): MediaDescriptor | null {
  if (tag[0] !== "imeta") return null;
  const fields = new Map<string, string>();
  for (const part of tag.slice(1)) {
    const gap = part.indexOf(" ");
    if (gap <= 0) continue;
    const key = part.slice(0, gap);
    const value = part.slice(gap + 1).trim();
    if (!value || fields.has(key)) continue;
    fields.set(key, value);
  }
  const url = fields.get("url");
  const mime = fields.get("m");
  if (!url || !mime) return null;

  const media: MediaDescriptor = { url, mime: normalizeMime(mime) };
  const sha = fields.get("x");
  if (sha) media.sha256 = sha;
  const size = positiveInt(Number(fields.get("size")));
  if (size) media.sizeBytes = size;
  const dim = /^(\d{1,6})x(\d{1,6})$/.exec(fields.get("dim") ?? "");
  if (dim) {
    media.width = Number(dim[1]);
    media.height = Number(dim[2]);
  }
  const blurhash = fields.get("blurhash");
  if (blurhash) media.blurhash = blurhash;
  const thumb = fields.get("thumb");
  if (thumb) media.thumbUrl = thumb;
  const duration = positiveInt(Number(fields.get("duration")));
  if (duration) media.durationSecs = duration;
  const poster = fields.get("image");
  if (poster) media.posterUrl = poster;
  const filename = fields.get("filename");
  if (filename) media.filename = filename;
  return media;
}

/** The acting person, in the shape `postMessageCore` takes. */
async function selfPrincipal(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not signed in");
  const subject = identity.subject;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .unique();
  return {
    actor: {
      type: "user" as const,
      id: subject,
      name: user?.name ?? user?.email ?? subject,
    },
    actorType: "user" as const,
    actorId: subject,
  };
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}
