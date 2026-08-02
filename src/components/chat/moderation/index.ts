// Moderation's public surface.
//
// Three pieces, each docking somewhere different: the dialog on a message's
// menu, the queue on its own route, and the banner on the room composer's top
// edge. The vocabulary and the triage math they share are in
// `src/lib/buzz/moderation.ts`, which the Convex module imports too — one
// definition of what a report category is, not one per side.

export { ReportMessageDialog } from "./report-dialog";
export { ModerationQueuePanel } from "./queue-panel";
export { ModerationScreen } from "./moderation-screen";
export { ComposerTimeoutBanner } from "./timeout-banner";
export {
  banMember,
  moderationAudit,
  moderationQueue,
  moderationRestrictions,
  reasonOf,
  resolveReport,
  submitReport,
  timeoutMember,
  unbanMember,
  untimeoutMember,
} from "./moderation-data";
