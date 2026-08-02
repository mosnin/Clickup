// Agents in a room — the one import surface.
//
// Nothing in this directory reaches into the shell, the transcript or the
// presence folder to mount itself, for the same reason `presence/index.ts`
// gives: the surfaces that own those files stay theirs, and a phase that wired
// itself into four of them would be a phase nobody could review. So here is the
// wiring, in three lines, for whoever composes the room.
//
//   1. Between the transcript and the composer, beside the typing line:
//
//        const signal = useRoomWorkingSignal(scope, channelId);
//        …
//        {signal.subscriptions}
//        <AgentWorkingLine working={signal.working} now={signal.now} />
//
//      One hook per room, never one per row. The subscriptions render nothing
//      and must be mounted, because that is where they live.
//
//   2. In the room's details pane, under the member list:
//
//        <RoomAgentsPanel scope={scope} channelId={channelId} roomLabel={roomLabel} />
//
//      It reads its own membership (`buzz/agents:attachable` answers "who is
//      here" and "who could be" as one list), so there is nothing to thread
//      through and no way for the picker to offer somebody the list above it is
//      already showing.
//
//   3. Nothing needs mounting for the honest silence. It is computed from the
//      rows the panel already read, and it appears where the silence is.
//
// `AgentActivityLog` is drawn for you inside the panel. Mount it directly only
// if a later surface wants one turn on its own — it is a pure function of a
// `ChatTurn`, an optional step stream and a clock.

export {
  AgentWorkingLine,
  TurnElapsed,
  WorkingPulse,
  useRoomWorkingSignal,
} from "./working-signal";
export type { RoomWorkingState } from "./working-signal";
export { AgentActivityLog } from "./activity-log";
export { RoomAgentsPanel, AgentMemberRow } from "./agent-member";
export { AddAgentControl } from "./add-agent";
export { HarnessSilence } from "./silence";

export {
  useAgentRoomActions,
  useRoomAgents,
  useRoomTurns,
  useServerClock,
  useTicker,
} from "./data";
export type { AgentRoomActions, RoomAgentsState, RoomTurnsState } from "./data";

export {
  attachAgent,
  attachableAgents,
  detachAgent,
  scopeArgs,
  turnsFor,
  workingIn,
} from "./refs";
export type { AttachableAgent, RoomTurn, RoomWorking, ScopeArgs } from "./refs";

export {
  deriveWorking,
  foldClockOffset,
  readAgentState,
  serverTime,
  workingLabel,
  workingTickMs,
} from "./signal";
export type { AgentReading, ClockOffset, WorkingAgent } from "./signal";

export {
  buildTurnActivity,
  classifyStep,
  collapseActivity,
  countActivityRows,
  groupMixedRuns,
  groupSameKindSegments,
  minimumSummaryRunLength,
  splitIntoSessionRuns,
  GROUPING_ELIGIBLE_RENDER_CLASSES,
  MIXED_RUN_MINIMUM_SEGMENTS,
  RENDER_CLASS_LABEL,
} from "./activity";
export type {
  ActivityDescriptor,
  ActivityRenderClass,
  ActivityRun,
  ActivitySegment,
  ActivityTone,
  ChatTurnStep,
  ClassifiedStep,
} from "./activity";

export {
  formatTurnElapsed,
  turnElapsedMs,
  turnIsLive,
  turnLiveness,
  workingAgents,
  TURN_ABANDON_AFTER_MS,
  TURN_LIVENESS_INTERVAL_MS,
  TURN_STALE_AFTER_MS,
} from "./turn";
export type { ChatTurn, TurnLiveness, TurnState } from "./turn";
