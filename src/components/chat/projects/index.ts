// The project surfaces, and the one thing the room shell needs from them.
//
// `BranchPane` is exported because `shell/channel-screen.tsx` docks it in the
// auxiliary pane — that is the seam, and it is one component rather than a
// feature flag or a channel type, so a room does not have to *be* a branch room
// to become one.

export { ProjectsScreen } from "./projects-screen";
export { ProjectScreen } from "./project-screen";
export { BranchPane } from "./branch-pane";
