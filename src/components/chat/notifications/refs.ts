// The Convex functions this folder talks to.
//
// Built by hand with `makeFunctionReference` rather than read off
// `api.buzz.notifications`, for the reason `shell/channel-data.tsx` states at
// length: the checked-in `convex/_generated/api.d.ts` is a stub that only knows
// the modules present when it was last generated, so `api.buzz.*` does not
// typecheck until somebody runs `npx convex dev`. Naming the function and its
// argument and return types here is the same contract written down in the one
// file that has to know it, and every line of this file deletes itself the day
// the stub is regenerated.

import { makeFunctionReference } from "convex/server";
import type { NotificationSettings, SoundName, SoundSlot } from "@/lib/buzz/notify";
import type { ChatScope } from "@/lib/buzz/channel-types";

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

/** `api.buzz.notifications.settings` — the reader's own, defaults if unsaved. */
export const settingsQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  NotificationSettings
>("buzz/notifications:settings");

/** `api.buzz.notifications.setFlag` — the three plain switches, one row. */
export const setFlagMutation = makeFunctionReference<
  "mutation",
  { key: "desktopEnabled" | "homeBadgeEnabled" | "notifyWhileViewing"; value: boolean },
  NotificationSettings
>("buzz/notifications:setFlag");

/** `api.buzz.notifications.setSlotAlert`. */
export const setSlotAlertMutation = makeFunctionReference<
  "mutation",
  { slot: SoundSlot; enabled: boolean },
  NotificationSettings
>("buzz/notifications:setSlotAlert");

/** `api.buzz.notifications.setAllSlotAlerts` — snapshot/restore, not a bulk write. */
export const setAllSlotAlertsMutation = makeFunctionReference<
  "mutation",
  { enabled: boolean },
  NotificationSettings
>("buzz/notifications:setAllSlotAlerts");

/** `api.buzz.notifications.setSound`. */
export const setSoundMutation = makeFunctionReference<
  "mutation",
  { slot: SoundSlot; sound: SoundName },
  NotificationSettings
>("buzz/notifications:setSound");

/** `api.buzz.notifications.mutes` — everything muted in one community. */
export const mutesQuery = makeFunctionReference<
  "query",
  ScopeArgs,
  { channels: string[]; threads: string[] }
>("buzz/notifications:mutes");

/** `api.buzz.notifications.setChannelMuted`. */
export const setChannelMutedMutation = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; muted: boolean },
  { muted: boolean }
>("buzz/notifications:setChannelMuted");

/** `api.buzz.notifications.setThreadMuted` — by root id, never by parent. */
export const setThreadMutedMutation = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; rootId: string; muted: boolean },
  { muted: boolean }
>("buzz/notifications:setThreadMuted");

/** `api.buzz.notifications.explain` — "why didn't I get notified about this?" */
export const explainQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string; eventId: string },
  {
    deliver: boolean;
    item: number | null;
    reason: string;
    slot: SoundSlot;
    predicateStep: number | null;
    explanation: string;
  }
>("buzz/notifications:explain");
