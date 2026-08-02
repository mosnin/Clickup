// The notification surface, in one import.
//
// The rules are not here — they are `src/lib/buzz/notify.ts`, pure and tested.
// This folder is the browser half: what the platform will let us show, what
// noise to make, and the two places a person changes any of it.

export { NotificationSettingsPanel } from "./settings-panel";
export {
  ChannelMuteToggle,
  ThreadMuteToggle,
  useMutes,
  type MuteSets,
} from "./mute-controls";
export { NotifyExplainer } from "./why";
export { playSound, recommendedSoundFor } from "./sound";
export {
  currentPermission,
  hrefForTarget,
  isNavigableTarget,
  permissionMessage,
  requestPermission,
  sendDesktopNotification,
  PERMISSION_BLOCKED_MESSAGE,
  PERMISSION_UNSUPPORTED_MESSAGE,
  type DesktopNotificationTarget,
  type NotificationPermissionState,
} from "./desktop";
export {
  explainQuery,
  mutesQuery,
  setAllSlotAlertsMutation,
  setChannelMutedMutation,
  setFlagMutation,
  setSlotAlertMutation,
  setSoundMutation,
  setThreadMutedMutation,
  settingsQuery,
} from "./refs";
