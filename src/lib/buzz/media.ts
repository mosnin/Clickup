// Media: what an attachment *is*, and what a frame-anchored comment *is*.
//
// Two grammars live here and nothing else does. Both are pure, both are shared
// by the server and the browser, and both are the kind of thing that fails
// silently when it is written twice.
//
//  • **The tag.** An attachment is a NIP-92 `imeta` tag on an ordinary message
//    (04-huddle-media §2.7) — not a new event kind, not a column, not a second
//    table. That matters more than it looks: `applyEditTagOverlay`
//    (`src/lib/buzz/timeline.ts`) swaps exactly the `imeta` family when an edit
//    overlays a message and keeps everything else, so a shape that is anything
//    other than `["imeta", "url …", "m …", …]` means editing a message quietly
//    deletes its attachments. That is the Pages-editor Image-block bug — a block
//    that wrote markdown a schema had no node for, so every image vanished on
//    the next parse — and the way not to have it again is for the round trip to
//    be a tested property of this file rather than a hope about two others.
//
//  • **The timecode.** A frame-anchored video comment is an ordinary thread
//    reply whose body begins `[MM:SS.d] ` (§2.10). There is no new kind and no
//    dedicated field, which is the whole reason the feature is small — but it
//    means the *only* thing standing between "a comment pinned to 1:23" and "a
//    message that happens to start with a bracket" is one regex. So the regex is
//    here, once, with the near-misses tested: somebody typing `[12] apples left`
//    must get their sentence back unharmed, not a comment pinned to nowhere.
//
// Deliberately absent, because we do not have them and pretending would be
// worse: server-side transcoding, server-side thumbnailing, magic-byte sniffing
// and blurhash. What we can honestly enforce is enumerated in `LIMITS` and
// checked in one function, `checkAttachment`, which the composer calls to say
// "no" early and the mutation calls to make the "no" true.

// ---------------------------------------------------------------------------
// What kinds of thing can be attached
// ---------------------------------------------------------------------------

/**
 * Three, and the difference is how it is *drawn*, not what it is made of.
 *
 * An image is drawn inline, a video gets a player and can be commented on frame
 * by frame, and everything else is a card with a download. A fourth category
 * would need a fourth renderer; three is what §2.8 has.
 */
export type MediaKind = "image" | "video" | "file";

/**
 * The images we draw. Magic-byte sniffing is Buzz's real gate (§2.3) and we do
 * not have it — a Convex mutation cannot read the bytes — so this list is doing
 * more work here than it does there, and it is correspondingly short.
 */
export const IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * The videos we accept, which is not the list Buzz accepts.
 *
 * Buzz takes MP4 only and gets away with it because its desktop client
 * re-encodes everything through ffmpeg first (§2.5). We have no transcoder, so
 * "MP4 only" would mean a WebM recorded by the browser's own MediaRecorder is
 * refused with nothing the person can do about it. WebM is here for that
 * reason, and `video/quicktime` is deliberately not: a .mov is the file people
 * actually have and cannot play, and accepting one would put a video in the room
 * that half the room cannot open.
 *
 * What this cannot check, and Buzz can: the codec inside the container. An
 * HEVC-in-MP4 passes every server-side test here and fails to decode in some
 * browsers. The composer's client-side probe is what catches it in practice —
 * see `checkAttachment`'s note.
 */
export const VIDEO_MIME_TYPES: readonly string[] = ["video/mp4", "video/webm"];

/**
 * Never, whatever else is true.
 *
 * Active content and executables (§2.3's deny-list), plus all audio — Buzz
 * rejects audio outright because it has no sanitizer for it, and we have less.
 * The list is prefix-matched for the `audio/` family and exact otherwise.
 *
 * This is defence in depth and not the only defence: nothing here is rendered
 * inline, because the renderer draws only what `mediaKindOf` calls an image or a
 * video and everything else is a download card. The reason to refuse at attach
 * time anyway is that attaching is the only thing that ever publishes a storage
 * URL to anyone — so a type refused here is a type nobody can be handed.
 */
export const BLOCKED_MIME_TYPES: readonly string[] = [
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

/** The one place a size, a duration or a count is decided. */
export const LIMITS = {
  /** §2.3. */
  imageBytes: 50 * 1024 * 1024,
  /** §2.3 — an animated GIF is capped below the image cap, not at it. */
  gifBytes: 10 * 1024 * 1024,
  videoBytes: 500 * 1024 * 1024,
  fileBytes: 100 * 1024 * 1024,
  /** §2.3 image-bomb guard: 25 megapixels. */
  imagePixels: 25 * 1_000_000,
  /** §2.3 video validation. */
  videoDurationSecs: 600,
  videoWidth: 3840,
  videoHeight: 2160,
  /**
   * Ours, not Buzz's.
   *
   * Buzz's bound is the relay's frame size; ours has to be a number because a
   * message's tags are written as rows in one Convex transaction, and a limit
   * that is really "however many fit" is a limit that fails halfway through a
   * write. Ten is more than anybody attaches and small enough that a message
   * still reads as a message.
   */
  attachmentsPerMessage: 10,
  /** A filename is a label, not a payload. */
  filenameChars: 255,
} as const;

/** What a MIME type means to the renderer, or `null` if it is refused. */
export function mediaKindOf(mime: string): MediaKind | null {
  const normal = normalizeMime(mime);
  if (!normal) return null;
  if (isBlockedMime(normal)) return null;
  if (IMAGE_MIME_TYPES.includes(normal)) return "image";
  if (VIDEO_MIME_TYPES.includes(normal)) return "video";
  // An unrecognised `image/*` or `video/*` is refused rather than filed as a
  // generic file: it would be drawn as a download card whose icon says
  // "picture", and the honest answer is that we cannot show it.
  if (normal.startsWith("image/") || normal.startsWith("video/")) return null;
  return "file";
}

export function isBlockedMime(mime: string): boolean {
  const normal = normalizeMime(mime);
  if (!normal) return true;
  if (normal.startsWith("audio/")) return true;
  return BLOCKED_MIME_TYPES.includes(normal);
}

/**
 * `Image/PNG; charset=binary` → `image/png`.
 *
 * Lowercased and stripped of parameters, because a MIME arrives from three
 * places — a `File.type`, a storage row, an agent's argument — and a comparison
 * that is sometimes case-sensitive is a check that sometimes passes.
 */
export function normalizeMime(mime: string): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

/**
 * One attachment, as both halves of the product speak about it.
 *
 * `url` and `mime` are the only required fields, which is §2.7's rule and not a
 * convenience: a legacy or cross-client `imeta` may carry nothing else, and a
 * parser that required `size` would drop the attachment entirely rather than
 * draw it slightly worse.
 */
export type MediaDescriptor = {
  url: string;
  mime: string;
  /** Hex SHA-256 of the bytes, when the store knew it. */
  sha256?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  /** A downscaled still, for the progressive image. */
  thumbUrl?: string;
  /** NIP-71 `image`: a video's poster frame. */
  posterUrl?: string;
  durationSecs?: number;
  blurhash?: string;
  filename?: string;
};

/** The tag family an attachment lives in. The same string `timeline.ts` swaps. */
export const MEDIA_TAG = "imeta";

/**
 * A descriptor, as one `imeta` tag.
 *
 * **Field order is fixed and that is load-bearing.** A Nostr event id is the
 * hash of its canonical serialization, tags included, so two encodings of the
 * same attachment are two different messages — a retried send would stop being
 * idempotent and post twice. The order is Buzz's own (§2.7).
 *
 * `x` and `size` are conditional for Buzz's reason: a relay validator rejects a
 * literal `"x "` or `"size 0"`, so an unknown value is an absent part rather
 * than an empty one.
 */
export function formatImetaTag(media: MediaDescriptor): string[] {
  const parts: string[] = [`url ${media.url}`, `m ${normalizeMime(media.mime)}`];
  if (media.sha256) parts.push(`x ${media.sha256}`);
  if (media.sizeBytes && media.sizeBytes > 0) parts.push(`size ${Math.round(media.sizeBytes)}`);
  if (media.width && media.height) parts.push(`dim ${media.width}x${media.height}`);
  if (media.blurhash) parts.push(`blurhash ${media.blurhash}`);
  if (media.thumbUrl) parts.push(`thumb ${media.thumbUrl}`);
  if (media.durationSecs && media.durationSecs > 0) {
    // Integer seconds. A fractional duration would make the same video encode
    // differently depending on how the browser rounded `HTMLMediaElement.duration`.
    parts.push(`duration ${Math.round(media.durationSecs)}`);
  }
  if (media.posterUrl) parts.push(`image ${media.posterUrl}`);
  if (media.filename) parts.push(`filename ${media.filename}`);
  return [MEDIA_TAG, ...parts];
}

/**
 * One `imeta` tag back into a descriptor, or `null` if it is not one.
 *
 * Split on the **first** space only: a filename legitimately contains spaces and
 * a URL legitimately does not, so `filename my holiday.png` is one part with a
 * two-word value rather than a parse error.
 */
export function parseImetaTag(tag: readonly string[]): MediaDescriptor | null {
  if (tag[0] !== MEDIA_TAG) return null;
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
  const size = toPositiveInt(fields.get("size"));
  if (size !== null) media.sizeBytes = size;
  const dim = parseDim(fields.get("dim"));
  if (dim) {
    media.width = dim.width;
    media.height = dim.height;
  }
  const blurhash = fields.get("blurhash");
  if (blurhash) media.blurhash = blurhash;
  const thumb = fields.get("thumb");
  if (thumb) media.thumbUrl = thumb;
  const duration = toPositiveInt(fields.get("duration"));
  if (duration !== null) media.durationSecs = duration;
  const poster = fields.get("image");
  if (poster) media.posterUrl = poster;
  const filename = fields.get("filename");
  if (filename) media.filename = filename;
  return media;
}

/**
 * Every attachment on a message, in tag order, deduplicated by URL.
 *
 * Deduplicated because the overlay concatenates: an edit that re-emits the full
 * set produces the edit's tags after the original's non-media tags, and a
 * projection bug upstream that let both survive would otherwise draw the same
 * picture twice. First occurrence wins, which is the one that was already on
 * screen.
 */
export function parseImetaTags(tags: readonly (readonly string[])[]): MediaDescriptor[] {
  const out: MediaDescriptor[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const media = parseImetaTag(tag);
    if (!media || seen.has(media.url)) continue;
    seen.add(media.url);
    out.push(media);
  }
  return out;
}

/**
 * Only the media tags, and nothing that looks like one.
 *
 * The injection defence §2.7 names (`splitOutgoingTags`): the edit path accepts
 * tags from a caller, and a caller that could smuggle an `h` or a `p` through
 * that door would be able to move a message into another room or wake somebody
 * who was never mentioned. Everything not literally `imeta` is dropped rather
 * than refused, because the caller that sent it is our own composer and a throw
 * would lose the edit over a tag nobody asked for.
 */
export function mediaTagsOnly(tags: readonly (readonly string[])[]): string[][] {
  return tags.filter((tag) => tag[0] === MEDIA_TAG).map((tag) => [...tag]);
}

/** Does this message carry a video? §2.10's `hasVideoAttachment`. */
export function hasVideoAttachment(tags: readonly (readonly string[])[]): boolean {
  return parseImetaTags(tags).some((media) => mediaKindOf(media.mime) === "video");
}

// ---------------------------------------------------------------------------
// The body lines
// ---------------------------------------------------------------------------

/**
 * The markdown line that goes in the body beside the tag.
 *
 * §2.7 requires **both**, and the reason is not redundancy: the tag is metadata
 * and the body is the message. A client that only understood text — a search
 * index, an export, an agent reading the log over MCP — sees a link where the
 * picture was rather than a message that mysteriously says nothing.
 */
export function formatMediaLine(media: MediaDescriptor): string {
  const kind = mediaKindOf(media.mime);
  if (kind === "video") return `![video](${media.url})`;
  if (kind === "image") return `![image](${media.url})`;
  return `[${escapeLinkLabel(media.filename ?? "file")}](${media.url})`;
}

/** A body with its media lines appended, in attachment order. */
export function appendMediaLines(body: string, media: readonly MediaDescriptor[]): string {
  if (media.length === 0) return body;
  const lines = media.map(formatMediaLine).join("\n");
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n${lines}` : lines;
}

/**
 * The body a person reads: the media lines taken back off the end.
 *
 * From the end and **stopping at the first line that is not one** (§2.7). A
 * global filter would delete a link somebody typed in the middle of a sentence
 * about the file they attached, which is exactly the sentence people write.
 */
export function stripMediaLines(body: string, media: readonly MediaDescriptor[]): string {
  const urls = new Set(media.map((entry) => entry.url));
  const lines = body.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === "") {
      end -= 1;
      continue;
    }
    const url = mediaLineUrl(line);
    if (!url || !urls.has(url)) break;
    end -= 1;
  }
  return lines.slice(0, end).join("\n").trimEnd();
}

/** `![image](url)` / `[label](url)` → the url, or null. */
export function mediaLineUrl(line: string): string | null {
  const match = /^!?\[([^\]]*)\]\((\S+)\)$/.exec(line.trim());
  return match ? match[2] : null;
}

function escapeLinkLabel(label: string): string {
  return label.replace(/([[\]\\])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// Limits, enforced once
// ---------------------------------------------------------------------------

export type AttachmentCandidate = {
  mime: string;
  sizeBytes: number;
  filename?: string;
  width?: number;
  height?: number;
  durationSecs?: number;
};

/**
 * Is this attachable? A sentence saying why not, or `null`.
 *
 * A sentence rather than a code because both callers show it to a person: the
 * composer before the bytes leave, and the mutation as the refusal that makes
 * the composer's answer true. **The client's copy is a courtesy and the
 * server's is the rule** — a limit checked only where the UI runs is a limit
 * that an agent posting over the same API does not have.
 *
 * What it cannot answer, honestly: whether the bytes are what the MIME says
 * they are. Buzz sniffs the first 4096 bytes; a Convex mutation cannot read a
 * stored blob at all. The composer's probe (decode it in an `<img>`/`<video>`
 * before uploading) is the closest thing we have, and it runs on the client, so
 * it stops mistakes rather than attackers.
 */
export function checkAttachment(candidate: AttachmentCandidate): string | null {
  const mime = normalizeMime(candidate.mime);
  if (!mime) return "That file has no type we can read.";
  if (isBlockedMime(mime)) return `${mime} files cannot be attached here.`;

  const kind = mediaKindOf(mime);
  if (!kind) return `${mime} files cannot be attached here.`;

  if (!Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
    return "That file is empty.";
  }

  const cap = sizeCapFor(mime);
  if (candidate.sizeBytes > cap) {
    return `${labelFor(kind, mime)} are limited to ${formatBytes(cap)}.`;
  }

  if (kind === "image" && candidate.width && candidate.height) {
    if (candidate.width * candidate.height > LIMITS.imagePixels) {
      return `Images are limited to ${LIMITS.imagePixels / 1_000_000} megapixels.`;
    }
  }

  if (kind === "video") {
    if (candidate.durationSecs && candidate.durationSecs > LIMITS.videoDurationSecs) {
      return `Videos are limited to ${LIMITS.videoDurationSecs / 60} minutes.`;
    }
    if (
      (candidate.width && candidate.width > LIMITS.videoWidth) ||
      (candidate.height && candidate.height > LIMITS.videoHeight)
    ) {
      return `Videos are limited to ${LIMITS.videoWidth}×${LIMITS.videoHeight}.`;
    }
  }

  if (candidate.filename && candidate.filename.length > LIMITS.filenameChars) {
    return "That filename is too long.";
  }

  return null;
}

/** The cap that applies, which for a GIF is not the image cap (§2.3). */
export function sizeCapFor(mime: string): number {
  const normal = normalizeMime(mime);
  if (normal === "image/gif") return LIMITS.gifBytes;
  const kind = mediaKindOf(normal);
  if (kind === "image") return LIMITS.imageBytes;
  if (kind === "video") return LIMITS.videoBytes;
  return LIMITS.fileBytes;
}

/**
 * The final path segment, without control characters, capped.
 *
 * Buzz's `sanitize_filename` (§2.5), for the same reason: a filename arrives
 * from a file picker on somebody else's operating system, is stored in a signed
 * event forever, and is rendered as a label. Both separator styles, because a
 * Windows path pasted into a Mac browser keeps its backslashes.
 */
export function sanitizeFilename(raw: string): string {
  const segment = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = segment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, LIMITS.filenameChars) || "file";
}

function labelFor(kind: MediaKind, mime: string): string {
  if (normalizeMime(mime) === "image/gif") return "GIFs";
  if (kind === "image") return "Images";
  if (kind === "video") return "Videos";
  return "Files";
}

/** `1.5 MB`. One decimal, and no decimal on a whole number. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

function toPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function parseDim(raw: string | undefined): { width: number; height: number } | null {
  if (!raw) return null;
  const match = /^(\d{1,6})x(\d{1,6})$/.exec(raw.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// The timecode grammar (§2.10)
// ---------------------------------------------------------------------------

/**
 * Buzz's `TIMECODE_RE`, character for character.
 *
 * Read it as: optional leading space, `[`, then either `SS`, `M:SS`, `MM:SS` or
 * `H:MM:SS` with an optional 1–3 digit fraction, then `]`, then optional space.
 *
 * Note what it deliberately matches and `parseTimecode` deliberately rejects:
 * the bare two-digit case, `[12]`. The regex cannot exclude it without also
 * excluding the colon forms it is built out of, so the exclusion happens one
 * step later — which is why the two functions have to be used together, and why
 * `parseTimecodedComment` is the thing everything else calls.
 */
export const TIMECODE_RE = /^\s*\[((?:(?:\d{1,2}:)?\d{1,2}:)?\d{2}(?:\.\d{1,3})?)\]\s*/;

/**
 * `MM:SS(.d)` or `H:MM:SS(.d)` → seconds, or `null`.
 *
 * **Two or three colon-separated parts, and nothing else.** One part is not a
 * timecode: `[12]` is somebody's numbered list, an issue reference, a footnote
 * — text that begins with a bracketed number is ordinary prose, and reading it
 * as "twelve seconds" would silently move their sentence onto a scrubber.
 * Refusing here is what makes that message come back unharmed.
 */
export function parseTimecode(raw: string): number | null {
  const parts = raw.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (part === "") return null;
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    seconds = seconds * 60 + value;
  }
  // Float noise: 7.5 survives, but 3600 + 0.1 * 3 does not, and a timecode that
  // formats back as `00:00.30000000000000004` is a timecode nobody can read.
  return Math.round(seconds * 1000) / 1000;
}

export type TimecodeFormat = {
  /** 0 for `MM:SS`, 1 for `MM:SS.d`. */
  fractionalDigits?: number;
  /** Drop `.0` — so a comment on a whole second reads `[01:23]`. */
  trimZeroFraction?: boolean;
};

/**
 * Seconds → the string that goes in the brackets.
 *
 * Rounded in **ticks rather than in seconds**, so 59.96 at one decimal becomes
 * `01:00` and not `00:60.0`. Formatting the minutes before rounding the seconds
 * is the classic version of this bug and it only shows up on the last frame of
 * a minute, which is exactly where people leave comments.
 */
export function formatTimecode(seconds: number, options: TimecodeFormat = {}): string {
  const digits = clampDigits(options.fractionalDigits ?? 0);
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const scale = 10 ** digits;
  const ticks = Math.round(safe * scale);
  const whole = Math.floor(ticks / scale);
  const fraction = ticks - whole * scale;

  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const base =
    hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(secs)}` : `${pad2(minutes)}:${pad2(secs)}`;

  if (digits === 0) return base;
  if (options.trimZeroFraction && fraction === 0) return base;
  return `${base}.${String(fraction).padStart(digits, "0")}`;
}

/** §2.10's `formatCommentTimecode`: one decimal, dropped when it is zero. */
export function formatCommentTimecode(seconds: number): string {
  return formatTimecode(seconds, { fractionalDigits: 1, trimZeroFraction: true });
}

/** A comment, read apart. `text` is what a person wrote; the stamp is metadata. */
export type TimecodedComment = {
  /** Seconds into the video, or `null` for an ordinary un-anchored comment. */
  seconds: number | null;
  /** The literal string that was in the brackets, for the seek pill's label. */
  timecode: string | null;
  /** The body without the stamp — or the **whole body**, when there was none. */
  text: string;
};

/**
 * Split a comment body into its stamp and its sentence.
 *
 * The un-anchored answer returns `text` equal to the input, untouched. That is
 * the near-miss contract: `[12] apples left` parses to no stamp and the original
 * sentence, so a person who typed a bracket keeps their bracket. A version that
 * stripped the prefix "just in case" would eat the first word of every message
 * that starts with a number in brackets.
 */
export function parseTimecodedComment(body: string): TimecodedComment {
  const match = TIMECODE_RE.exec(body);
  if (!match) return { seconds: null, timecode: null, text: body };
  const seconds = parseTimecode(match[1]);
  if (seconds === null) return { seconds: null, timecode: null, text: body };
  return { seconds, timecode: match[1], text: body.slice(match[0].length) };
}

/** Is this body already anchored? What the composer checks before stamping. */
export function alreadyStamped(body: string): boolean {
  return parseTimecodedComment(body).seconds !== null;
}

/**
 * `[01:23] the logo pops here`.
 *
 * Refuses to stamp twice: a body that already parses as anchored is returned
 * with only its own stamp, because `[00:03] [00:05] hi` parses as a comment at
 * three seconds whose text is `[00:05] hi`, which is a comment in the wrong
 * place *and* an ugly one. Somebody who typed their own timecode meant it.
 */
export function stampComment(seconds: number, text: string): string {
  const trimmed = text.trim();
  if (alreadyStamped(trimmed)) return trimmed;
  return `[${formatCommentTimecode(seconds)}] ${trimmed}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clampDigits(digits: number): number {
  if (!Number.isFinite(digits)) return 0;
  return Math.min(3, Math.max(0, Math.trunc(digits)));
}

// ---------------------------------------------------------------------------
// Assembling a video's comments (§2.10)
// ---------------------------------------------------------------------------

/** The little a comment has to be for this file to thread and sort it. */
export type CommentNode = {
  id: string;
  parentId?: string | null;
  body: string;
  createdAt: number;
};

/**
 * How far up a parent chain to walk before deciding it is a cycle.
 *
 * A cycle cannot happen in an append-only log — an event id is the hash of an
 * event that already names its parent — but the events arrive from a query, and
 * a guard that costs one integer is cheaper than a renderer that hangs.
 */
const MAX_HOPS = 64;

/**
 * `rootId → every comment beneath it`, however deep.
 *
 * A reply to a reply is a comment **on the video too** (§2.10): the review panel
 * shows one conversation about one video, and a comment that only appeared under
 * its immediate parent would vanish from the panel the moment somebody answered
 * it. So each message is attached to every ancestor on its way up.
 */
export function commentsByRoot<T extends CommentNode>(
  messages: readonly T[],
): Map<string, T[]> {
  const byId = new Map<string, T>();
  for (const message of messages) byId.set(message.id, message);

  const out = new Map<string, T[]>();
  for (const message of messages) {
    let cursor: string | null | undefined = message.parentId;
    let hops = 0;
    const visited = new Set<string>([message.id]);
    while (cursor && hops < MAX_HOPS && !visited.has(cursor)) {
      visited.add(cursor);
      const bucket = out.get(cursor);
      if (bucket) bucket.push(message);
      else out.set(cursor, [message]);
      cursor = byId.get(cursor)?.parentId ?? null;
      hops += 1;
    }
  }

  for (const bucket of out.values()) bucket.sort(byCreatedThenId);
  return out;
}

function byCreatedThenId(a: CommentNode, b: CommentNode): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sort for the panel: stamped comments in playback order, then the rest.
 *
 * Playback order and not arrival order, because the panel is read beside a
 * scrubber — a list that jumped from 4:10 to 0:03 because somebody came back to
 * an earlier moment would not be a review, it would be a chat log. Un-stamped
 * comments have no place on the timeline, so they go after, in the order they
 * were said.
 */
export function sortTimecodedComments<T extends CommentNode>(comments: readonly T[]): T[] {
  const decorated = comments.map((comment) => ({
    comment,
    seconds: parseTimecodedComment(comment.body).seconds,
  }));
  decorated.sort((a, b) => {
    if (a.seconds === null && b.seconds === null) return byCreatedThenId(a.comment, b.comment);
    if (a.seconds === null) return 1;
    if (b.seconds === null) return -1;
    if (a.seconds !== b.seconds) return a.seconds - b.seconds;
    return byCreatedThenId(a.comment, b.comment);
  });
  return decorated.map((entry) => entry.comment);
}

/**
 * One level of nesting, and no more.
 *
 * §2.10: replies nest under their **top-level** ancestor, deep chains flattened
 * by walking up. Two levels of indent in a 380px panel is a column of text four
 * words wide; the thing a reader needs is "this answers that", and one indent
 * says it.
 *
 * `rootId` is the video message, which is not itself a comment — a reply whose
 * parent is the video is top-level here.
 */
export function nestOneLevel<T extends CommentNode>(
  comments: readonly T[],
  rootId: string,
): { comment: T; replies: T[] }[] {
  const byId = new Map<string, T>();
  for (const comment of comments) byId.set(comment.id, comment);

  const topLevel: T[] = [];
  const repliesTo = new Map<string, T[]>();

  for (const comment of comments) {
    const ancestor = topAncestor(comment, byId, rootId);
    if (!ancestor || ancestor.id === comment.id) {
      topLevel.push(comment);
      continue;
    }
    const bucket = repliesTo.get(ancestor.id);
    if (bucket) bucket.push(comment);
    else repliesTo.set(ancestor.id, [comment]);
  }

  return sortTimecodedComments(topLevel).map((comment) => ({
    comment,
    replies: (repliesTo.get(comment.id) ?? []).slice().sort(byCreatedThenId),
  }));
}

function topAncestor<T extends CommentNode>(
  comment: T,
  byId: ReadonlyMap<string, T>,
  rootId: string,
): T | null {
  let current = comment;
  const visited = new Set<string>([current.id]);
  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    const parentId = current.parentId;
    if (!parentId || parentId === rootId) return current;
    const parent = byId.get(parentId);
    // A parent outside this set — the video's own message, or a comment that
    // was not loaded. Either way this comment is as top-level as it gets here.
    if (!parent || visited.has(parent.id)) return current;
    visited.add(parent.id);
    current = parent;
  }
  return current;
}
