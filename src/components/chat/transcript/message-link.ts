// A link to one message — spec 01 §2.9, with one deliberate departure.
//
// Buzz emits `buzz://message?channel=…&id=…`, which is right for a desktop app
// with a registered scheme and wrong for us: pasted into a browser, a document,
// a task description or an agent's tool call, a `buzz://` URL is dead text. Our
// deep link is an ordinary in-app URL — `/chat/c/<channel>?m=<id>` — so "Copy
// link" produces something that works everywhere a link works, including in the
// Work dashboard, in email, and in the hands of an agent that has an HTTP
// client and no idea what our schemes are.
//
// The `thread` parameter is carried for the same reason Buzz carries it: a
// reply's link should name the thread it lives in, so a future reader can open
// the pane rather than hunt for the parent. Like Buzz's, it is not required to
// resolve the jump — the message id alone is enough, and the thread is an
// optimisation the transcript may act on or ignore.
//
// `parseMessageLink` returns a discriminated result rather than throwing.
// A message body containing a link-shaped string that is not one of ours is an
// ordinary Tuesday; the renderer needs "no" as a value, not as an exception.

export type MessageLinkTarget = {
  channelId: string;
  messageId: string;
  threadRootId?: string;
};

export type ParseResult =
  | { ok: true; value: MessageLinkTarget }
  | {
      ok: false;
      reason: "invalid-url" | "wrong-path" | "missing-channel" | "missing-id";
    };

/** The query parameter the transcript reads a jump target from. */
export const MESSAGE_PARAM = "m";
export const THREAD_PARAM = "thread";

/**
 * Build a link to a message.
 *
 * Throws on a missing channel or message id, matching Buzz: those are
 * programmer errors at a call site, not user input, and a silently malformed
 * link copied to somebody's clipboard is discovered days later by the person
 * it was sent to.
 */
export function buildMessageLink(args: {
  channelId: string;
  messageId: string;
  threadRootId?: string;
  /** Absolute when given (`https://app…`), relative when not. */
  origin?: string;
}): string {
  if (!args.channelId) throw new Error("buildMessageLink: missing channelId");
  if (!args.messageId) throw new Error("buildMessageLink: missing messageId");
  const params = new URLSearchParams({ [MESSAGE_PARAM]: args.messageId });
  // An empty thread root means "no thread", so callers can pass a message's
  // `rootId` straight through without a conditional at every call site.
  if (args.threadRootId) params.set(THREAD_PARAM, args.threadRootId);
  const path = `/chat/c/${encodeURIComponent(args.channelId)}?${params.toString()}`;
  return args.origin ? `${args.origin.replace(/\/+$/, "")}${path}` : path;
}

const CHANNEL_PATH = /^\/chat\/c\/([^/]+)\/?$/;

export function parseMessageLink(href: string): ParseResult {
  let url: URL;
  try {
    // A base so relative links parse; it is never read back out.
    url = new URL(href, "https://operate.to");
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  const match = CHANNEL_PATH.exec(url.pathname);
  if (!match) return { ok: false, reason: "wrong-path" };
  const channelId = decodeURIComponent(match[1]);
  if (!channelId) return { ok: false, reason: "missing-channel" };
  const messageId = url.searchParams.get(MESSAGE_PARAM);
  if (!messageId) return { ok: false, reason: "missing-id" };
  const threadRootId = url.searchParams.get(THREAD_PARAM);
  return {
    ok: true,
    value: {
      channelId,
      messageId,
      ...(threadRootId ? { threadRootId } : {}),
    },
  };
}

/** Cheap pre-check for a renderer deciding whether to parse at all. */
export function isMessageLink(href: string): boolean {
  return parseMessageLink(href).ok;
}
