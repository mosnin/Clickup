// Channel templates — the furniture a new room can arrive with.
//
// §1.7's template carries a description, a default visibility, a canvas seed
// and a set of agents to invite. Only the first three are decided *here*; the
// agents and the canvas are applied server-side after the room exists, because
// a partial failure there must not stop the room being created (§1.2's
// "best-effort: failures never block navigation").
//
// Built-ins live in code rather than in a table for the same reason the skills
// library does: a template is a playbook, and a playbook that needs a migration
// to change is one nobody changes. Custom templates are a later phase; when
// they land they merge over these by id, exactly as `skills.ts` merges.

import type { ChatChannelVisibility } from "@/lib/buzz/channel-types";
import type { BrowsableChannelKind } from "@/lib/buzz/channel-search";

export type ChannelTemplate = {
  id: string;
  name: string;
  /** Prefills the create form's description. The user may then edit it. */
  description: string;
  kind: BrowsableChannelKind;
  /**
   * The visibility the template *suggests*. It is applied only while the
   * person has not touched the visibility control themselves — a template that
   * overwrites a deliberate choice is a template that cannot be trusted.
   */
  visibility: ChatChannelVisibility;
};

/** The template list. `null` (no template) is always a legitimate answer. */
export const CHANNEL_TEMPLATES: ChannelTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "",
    kind: "channel",
    visibility: "public",
  },
  {
    id: "project",
    name: "Project",
    description: "Everything about one piece of work: decisions, status, blockers.",
    kind: "channel",
    visibility: "public",
  },
  {
    id: "incident",
    name: "Incident",
    description: "A live incident: timeline, mitigation, and the write-up afterwards.",
    kind: "channel",
    visibility: "private",
  },
  {
    id: "standup",
    name: "Standup",
    description: "Daily what-I-did / what-I-am-doing / what-is-in-the-way.",
    kind: "channel",
    visibility: "public",
  },
];

export function templateById(id: string | null): ChannelTemplate | null {
  if (!id) return null;
  return CHANNEL_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** 7 days of *inactivity* — §1.1's `DEFAULT_EPHEMERAL_TTL_SECONDS`. */
export const DEFAULT_EPHEMERAL_TTL_SECONDS = 7 * 24 * 3600;

/**
 * The offered lifetimes for a temporary room.
 *
 * Presets rather than a duration parser: "one choice at a time, one row of
 * full-size options". `parseTtlDuration("1d12h")` exists in Buzz for a text
 * field we are not shipping — an arbitrary duration is a setting, and a room
 * that cleans itself up needs an answer, not a syntax.
 */
export const TTL_CHOICES: { seconds: number; label: string }[] = [
  { seconds: 30 * 60, label: "30 minutes" },
  { seconds: 12 * 3600, label: "12 hours" },
  { seconds: DEFAULT_EPHEMERAL_TTL_SECONDS, label: "7 days" },
];
