// The bridge's surface, in one import.
//
// Everything here is a read across the two dashboards or a reference resolved
// at the moment it is drawn. See `src/lib/buzz/bridge.ts` for the rule and
// `convex/buzz/bridge.ts` for what enforces it.

export { BridgeBody, BridgeRefsProvider, useBridgeRefs } from "./bridge-body";
export { TranscriptBridge } from "./transcript-bridge";
export { RefChip, TaskChip, UnresolvedRef } from "./task-chip";
export { WorkPane } from "./work-pane";
export { MessageToTask } from "./message-to-task";
export { ModeBadge, useModeBadges } from "./switcher-badge";
export { AgentRooms } from "./agent-rooms";
export { useChatPaletteHits, type ChatPaletteHit } from "./palette-chat";
export type {
  FleetMember,
  ResolvedRef,
  RoomBindingWire,
  SwitcherCounts,
  TargetList,
  WorkFeedRow,
} from "./bridge-data";
