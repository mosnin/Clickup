// The one translation between the create form and `buzz/channels:create`.
//
// The form speaks the words a person reads (`public` / `channel`). The store
// speaks Buzz (`open` / `stream`). An earlier dialog sent the reader's words
// straight through, and Convex refused every create with a validator error
// that the toast then showed raw. This helper is the only place that
// translation is allowed to live — the dialog, a branch-room open, and any
// later caller all go through it, and the test below is what keeps a second
// copy from growing.

import { errorMessage } from "@/lib/errors";
import type { ChatChannelVisibility, ChatScope } from "@/lib/buzz/channel-types";
import type { BrowsableChannelKind } from "@/lib/buzz/channel-search";

/** What the create form (and its templates) collect. */
export type CreateChannelForm = {
  name: string;
  description?: string;
  kind: BrowsableChannelKind;
  visibility: ChatChannelVisibility;
  ttlSeconds?: number;
  templateId?: string;
};

/** What `buzz/channels:create` actually accepts. */
export type CreateChannelWire = {
  scopeType: ChatScope["scopeType"];
  scopeId: string;
  name: string;
  description?: string;
  visibility: "open" | "private";
  channelType: "stream" | "forum";
  ttlSeconds?: number;
  templateId?: string;
};

/**
 * `public` is the word people read; `open` is the word the log records.
 *
 * Also accepts `open` so a caller that already speaks the store cannot
 * accidentally be translated *into* `public`.
 */
export function wireVisibility(
  visibility: ChatChannelVisibility | "open",
): "open" | "private" {
  return visibility === "private" ? "private" : "open";
}

/** A browsable room is a NIP-29 `stream`; a forum is a forum. */
export function wireChannelType(
  kind: BrowsableChannelKind | "stream",
): "stream" | "forum" {
  return kind === "forum" ? "forum" : "stream";
}

/**
 * Form + scope → mutation args.
 *
 * The return type has no `kind` and no `public`. That is the contract the
 * test pins: a create built from the form cannot send the words the
 * validator refuses.
 */
export function toCreateChannelArgs(
  scope: ChatScope,
  form: CreateChannelForm,
): CreateChannelWire {
  const args: CreateChannelWire = {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    name: form.name,
    visibility: wireVisibility(form.visibility),
    channelType: wireChannelType(form.kind),
  };
  if (form.description) args.description = form.description;
  if (form.ttlSeconds !== undefined) args.ttlSeconds = form.ttlSeconds;
  if (form.templateId) args.templateId = form.templateId;
  return args;
}

/**
 * Server-side alias: a leftover client that still sends `public` is accepted
 * and stored as `open`. Unknown values stay unknown so the validator (or a
 * ConvexError) can refuse them with a sentence, not a schema dump.
 */
export function normalizeCreateVisibility(
  visibility: string | undefined,
): "open" | "private" | undefined {
  if (visibility === undefined) return undefined;
  if (visibility === "private") return "private";
  if (visibility === "open" || visibility === "public") return "open";
  return undefined;
}

/** `kind: "channel"` was the other leftover field. Same job as `wireChannelType`. */
export function normalizeCreateChannelType(
  channelType: string | undefined,
  kind?: string,
): "stream" | "forum" | undefined {
  const raw = channelType ?? kind;
  if (raw === undefined) return undefined;
  if (raw === "forum") return "forum";
  if (raw === "stream" || raw === "channel") return "stream";
  return undefined;
}

/**
 * Every create-channel failure becomes a next action, never a Convex stack.
 *
 * Convex redacts plain `Error` messages to "Server Error" in production and
 * ArgumentValidationError / missing-table throws arrive as that, or as a
 * paragraph of validator JSON. Showing either is how a launch blocker reads
 * as "the database broke" to the person who just named a room.
 */
export function createChannelError(err: unknown, noun = "channel"): string {
  const raw = errorMessage(err, "");
  const blob = `${raw}\n${err instanceof Error ? err.message : String(err)}`.toLowerCase();

  if (/already exists/.test(blob)) {
    return raw.includes("#") ? raw.split("\n")[0]!.trim() : `A ${noun} by that name already exists.`;
  }
  if (/needs a name|name is required/.test(blob)) {
    return `Give the ${noun} a name.`;
  }
  if (/unknown channel template/.test(blob)) {
    return "That template is no longer available. Create the room without one.";
  }
  if (/not authenticated/.test(blob)) {
    return "Sign in again, then create the room.";
  }
  if (/account suspended/.test(blob)) {
    return "This account is on hold, so a room cannot be created.";
  }
  if (/forbidden/.test(blob)) {
    return "You don't have access to create a room here.";
  }
  if (
    /signing key|signing identity|opened chat yet|no chat signing/.test(blob)
  ) {
    return "Setting up your Chat identity. Try creating the room again in a moment.";
  }
  if (
    /argumentvalidation|does not match validator|validator error|invalid argument/.test(
      blob,
    )
  ) {
    return `That ${noun} could not be created. Refresh and try again.`;
  }
  if (
    /table|index|does not exist|undefined table|schema validation|failed to insert|no such table/.test(
      blob,
    )
  ) {
    return "Chat is still updating on the server. Refresh in a moment and try again.";
  }
  if (/server error|uncaught|at \w+ \([^)]+\.\w+:\d+/.test(blob) || raw.length === 0) {
    return `Couldn't create the ${noun}. Try again.`;
  }
  // A short ConvexError we wrote is already the next action — keep it.
  if (raw.length > 0 && raw.length < 180 && !/convex|validator|schema/i.test(raw)) {
    return raw.split("\n")[0]!.trim();
  }
  return `Couldn't create the ${noun}. Try again.`;
}
