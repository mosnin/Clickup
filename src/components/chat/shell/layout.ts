// The Chat shell's geometry, in one place.
//
// Six components need the same numbers — the rail's width is a padding on the
// top chrome, the sidebar's minimum is the auxiliary pane's maximum, the
// auxiliary pane's minimum doubled is the breakpoint at which it stops being a
// column. Written twice, those relationships stop holding the first time one
// of them is tuned, and the failure is a 40px sliver of pane nobody can read.
//
// Pixels, not rem, and deliberately: these are structural sizes (how wide is a
// column) rather than type sizes. A rail measured in rem grows when someone
// raises their type scale, which is the opposite of what they asked for —
// bigger text in the same column, not a wider column with the same text.

/** The drag/toggle strip across the top of the app. */
export const TOP_CHROME_HEIGHT_PX = 40;

/** The community rail. Hidden entirely when there is only one community. */
export const RAIL_WIDTH_PX = 56;

export const SIDEBAR_DEFAULT_PX = 300;
export const SIDEBAR_MIN_PX = 220;
export const SIDEBAR_MAX_PX = 420;
/** The off-canvas drawer below `md`, where a 300px column is most of a phone. */
export const SIDEBAR_DRAWER_PX = 288;

export const AUX_DEFAULT_PX = 380;
export const AUX_MIN_PX = 300;
/**
 * A floor, not a ceiling. On an ultrawide, "the thread may not exceed 720px"
 * is an arbitrary insult; what actually matters is that the channel keeps at
 * least a sidebar's width of room. See `auxMaxWidth`.
 */
export const AUX_MAX_FLOOR_PX = 720;

/** Below this the rail and sidebar become one drawer. */
export const DRAWER_BREAKPOINT_PX = 768;
/**
 * Below this the auxiliary pane stops being a column and floats over the room.
 * It is the minimum doubled on purpose: the first width at which two panes can
 * both be legible is the first width at which two panes should exist.
 */
export const AUX_OVERLAY_BREAKPOINT_PX = AUX_MIN_PX * 2;

/** Persisted per person, per browser. Not the Work shell's `sidebar_state`
 *  cookie — one cookie for two shells means collapsing Chat collapses Work. */
export const SIDEBAR_WIDTH_KEY = "chat.sidebar-width";
export const SIDEBAR_OPEN_KEY = "chat.sidebar-open";
export const AUX_WIDTH_KEY = "chat.aux-width";
export const SCOPE_KEY = "chat.community";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampSidebarWidth(px: number): number {
  return clamp(Math.round(px), SIDEBAR_MIN_PX, SIDEBAR_MAX_PX);
}

const DETENT_SNAP_PX = 8;
const DETENT_ZONE_PX = 28;

/**
 * The sidebar's magnetic detent at its default width.
 *
 * Within 8px of 300 it snaps exactly; from 8 to 28px it eases quadratically
 * out of the detent; beyond that it tracks the pointer. The easing is what
 * makes it sticky rather than blocking — a hard snap with no ramp feels like
 * the drag broke, and a bare snap-if-close jumps 8px the moment you leave it.
 *
 * Continuous by construction: the offset is 0 at the edge of the snap zone and
 * exactly the raw offset at the edge of the ease zone, so there is no step
 * anywhere in the gesture.
 */
export function magneticSidebarWidth(rawPx: number): number {
  const delta = rawPx - SIDEBAR_DEFAULT_PX;
  const distance = Math.abs(delta);
  if (distance <= DETENT_SNAP_PX) return SIDEBAR_DEFAULT_PX;
  if (distance >= DETENT_ZONE_PX) return clampSidebarWidth(rawPx);
  const t = (distance - DETENT_SNAP_PX) / (DETENT_ZONE_PX - DETENT_SNAP_PX);
  const eased = t * t * DETENT_ZONE_PX;
  return clampSidebarWidth(SIDEBAR_DEFAULT_PX + Math.sign(delta) * eased);
}

/** How wide the auxiliary pane may get in this viewport. */
export function auxMaxWidth(viewportWidthPx: number): number {
  return Math.max(AUX_MAX_FLOOR_PX, viewportWidthPx - SIDEBAR_DEFAULT_PX);
}

export function clampAuxWidth(px: number, viewportWidthPx: number): number {
  return clamp(Math.round(px), AUX_MIN_PX, auxMaxWidth(viewportWidthPx));
}

/**
 * Which channel the URL is pointing at, or null.
 *
 * The single mapping from location to selection — the sidebar's active row,
 * the room header and the read marker all ask this one function, so they can
 * never disagree about which room you are in. Anything that is not exactly
 * `/chat/c/<id>` is "no channel", including `/chat/c/` with a trailing slash
 * and nothing after it.
 */
export function activeChannelId(pathname: string): string | null {
  const match = /^\/chat\/c\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The room's own URL. One writer, so a link and a match can't drift. */
export function channelHref(channelId: string): string {
  return `/chat/c/${encodeURIComponent(channelId)}`;
}
