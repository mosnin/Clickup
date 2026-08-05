"use client";

// The Chat application shell.
//
// A room you sit in, not a page you glance at. Everything that follows from
// that sentence is structural, and all of it is here rather than spread over
// the pages it frames:
//
//   • The viewport is pinned. `h-svh overflow-hidden` on the outer element and
//     `min-h-0` on every flex descendant that contains a scroller. The
//     transcript scrolls; the chrome, the rail and the composer do not. If the
//     document scrolls, the composer walks off the bottom of the screen and
//     the application stops being a room.
//   • The shell lives in the layout, not the page. Navigating between rooms
//     must not re-mount the rail — a sidebar that flashes on every click is a
//     page turning, and it also drops the channel subscription every time.
//   • One nav element, two shapes. Below `md` the rail and the sidebar are a
//     288px drawer over the room; above it they are columns. Rendering them
//     twice would mean two subscriptions and two sources of truth about which
//     room is open, so the same DOM moves instead.
//
// The community rail is hidden entirely when there is one community, which is
// most people's first week. A switcher that can only switch to where you
// already are is 56px of furniture.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { MotionConfig } from "@/components/motion";
import { CommandPalette } from "@/components/command-palette";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  PresenceProvider,
  useMyPresence,
  useMyPubkey,
  type MyPresence,
} from "@/components/chat/presence";
import { ChannelsProvider } from "./channel-data";
import { EnsureChatIdentity } from "./ensure-chat-identity";
import { ChatTopChrome } from "./top-chrome";
import { ChannelSidebar } from "./channel-sidebar";
import {
  DRAWER_BREAKPOINT_PX,
  AUX_OVERLAY_BREAKPOINT_PX,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_OPEN_KEY,
  SIDEBAR_WIDTH_KEY,
  SCOPE_KEY,
  clampSidebarWidth,
  activeChannelId,
} from "./layout";
import { cn } from "@/lib/utils";

export type ChatCommunity = ChatScope & { name: string };

type ShellState = {
  communities: ChatCommunity[];
  scope: ChatScope | null;
  scopeName: string;
  setScope: (scope: ChatScope) => void;
  /** The room the URL is pointing at, or null on the home surface. */
  channelId: string | null;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (px: number) => void;
  /** Below `md`: the nav is a drawer rather than a column. */
  isNarrow: boolean;
  /** Below 600px: an auxiliary pane floats over the room instead of beside it. */
  auxIsOverlay: boolean;
  closeNav: () => void;
  /**
   * Your own dot, and the preference behind it.
   *
   * It rides the shell rather than being read again wherever it is drawn
   * because `useMyPresence` *is* the heartbeat: a second call site would be a
   * second sixty-second timer writing the same row, and the two would take
   * turns deciding whether you are away. One heartbeat for the application,
   * handed to whoever draws it (the settings screen's presence section today).
   */
  presence: MyPresence;
  /** Yours in the log, or null before the Chat key bootstrap has run. */
  selfPubkey: string | null;
};

const ShellContext = createContext<ShellState | null>(null);

export function useChatShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useChatShell used outside the Chat shell");
  return value;
}

/**
 * A media query as React state.
 *
 * `useSyncExternalStore` rather than an effect because the answer is read
 * during render and a wrong first answer is a visible flash. The server
 * snapshot says "wide": the layout itself is CSS, so the only thing this
 * value gates is drawer behaviour, and a drawer that is not open yet renders
 * identically either way.
 */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : true,
    () => true,
  );
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the preference is nice to have, not load-bearing */
  }
}

export function ChatShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const channelId = activeChannelId(pathname);

  const communities = useQuery(api.chat.scopesForCurrentUser, {});
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpenState] = useState(true);
  const [sidebarWidth, setSidebarWidthState] = useState(SIDEBAR_DEFAULT_PX);
  const [navOpen, setNavOpen] = useState(false);

  const isWide = useMediaQuery(`(min-width: ${DRAWER_BREAKPOINT_PX}px)`);
  const auxIsOverlay = !useMediaQuery(
    `(min-width: ${AUX_OVERLAY_BREAKPOINT_PX}px)`,
  );

  // Preferences are read after mount, not during render: localStorage is not
  // available on the server, and reading it during the first client render
  // makes the markup disagree with what was sent.
  useEffect(() => {
    const width = Number(readStored(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(width) && width > 0) {
      setSidebarWidthState(clampSidebarWidth(width));
    }
    setSidebarOpenState(readStored(SIDEBAR_OPEN_KEY) !== "closed");
    const stored = readStored(SCOPE_KEY);
    if (stored) setScopeKey(stored);
  }, []);

  const list: ChatCommunity[] = useMemo(() => communities ?? [], [communities]);
  const active =
    list.find((c) => `${c.scopeType}:${c.scopeId}` === scopeKey) ?? list[0];
  // Memoised because it is a fresh object every render otherwise, and it is
  // the key the channel subscription is torn down and rebuilt on — an
  // identity that changes per render is a subscription that never settles.
  const scope: ChatScope | null = useMemo(
    () =>
      active ? { scopeType: active.scopeType, scopeId: active.scopeId } : null,
    [active],
  );

  const setScope = useCallback((next: ChatScope) => {
    const key = `${next.scopeType}:${next.scopeId}`;
    setScopeKey(key);
    writeStored(SCOPE_KEY, key);
  }, []);

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
    writeStored(SIDEBAR_OPEN_KEY, open ? "open" : "closed");
  }, []);

  const setSidebarWidth = useCallback((px: number) => {
    const clamped = clampSidebarWidth(px);
    setSidebarWidthState(clamped);
    writeStored(SIDEBAR_WIDTH_KEY, String(clamped));
  }, []);

  const closeNav = useCallback(() => setNavOpen(false), []);

  // Presence, once, for the whole application (`presence/index.ts` step 1).
  // The heartbeat belongs to the shell rather than to a room because it is a
  // fact about the person, not about what they happen to have open — somebody
  // reading Pulse is as present as somebody standing in a room.
  const selfPubkey = useMyPubkey();
  const presence = useMyPresence(scope, selfPubkey);

  // Picking a room closes the drawer. On a phone the drawer covers the room
  // you just chose, so leaving it open means every navigation needs two
  // gestures — and the second one is "dismiss the thing that answered you".
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Escape closes the drawer, and only the drawer: anything else that is open
  // over it (a menu, an auxiliary pane) registers its own handler and stops
  // the event, so the innermost open surface wins. A shell-level handler that
  // fired first would close the room out from under a menu.
  useEffect(() => {
    if (!navOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) setNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const state: ShellState = useMemo(
    () => ({
      communities: list,
      scope,
      scopeName: active?.name ?? "",
      setScope,
      channelId,
      sidebarOpen,
      setSidebarOpen,
      sidebarWidth,
      setSidebarWidth,
      isNarrow: !isWide,
      auxIsOverlay,
      closeNav,
      presence,
      selfPubkey,
    }),
    [
      list,
      scope,
      active,
      setScope,
      channelId,
      sidebarOpen,
      setSidebarOpen,
      sidebarWidth,
      setSidebarWidth,
      isWide,
      auxIsOverlay,
      closeNav,
      presence,
      selfPubkey,
    ],
  );

  return (
    <MotionConfig reducedMotion="user">
      {/* Mints this reader's Chat signing key if they have none. Sits above
          everything because *every* Chat write needs it, and the shell is the
          one component every entry into Chat passes through — see the file's
          own comment for what breaks without it. Renders nothing. */}
      <EnsureChatIdentity />
      <ChannelsProvider scope={scope}>
        <ShellContext.Provider value={state}>
          {/* One roster subscription for the application, so a dot beside a
              name is the same dot everywhere it appears. Surfaces that need a
              *seeded* roster (the room's agent panel, which must show an agent
              that has never beaten) nest their own provider inside this one. */}
          <PresenceProvider scope={scope}>
            <div
              data-chat-shell=""
              className="flex h-svh w-full overflow-hidden bg-page text-foreground"
            >
              {/* The nav: rail + sidebar. One element, two shapes.

                  data-mode-surface="nav" pairs this with the Work shell's
                  sidebar container: one view-transition-name across both, so
                  switching dashboards morphs this box into that one instead of
                  cross-fading the viewport. See the Work ⇄ Chat block in
                  globals.css. */}
              <nav
                data-mode-surface="nav"
                aria-label="Chat navigation"
                data-layout={isWide ? "inline" : "drawer"}
                data-open={navOpen ? "true" : "false"}
                style={
                  {
                    "--chat-sidebar-w": `${sidebarOpen ? sidebarWidth : 0}px`,
                  } as React.CSSProperties
                }
                className={cn(
                  "fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 overflow-hidden bg-page",
                  "transition-transform duration-200 ease-out",
                  navOpen ? "translate-x-0" : "-translate-x-full",
                  "md:static md:z-auto md:w-auto md:translate-x-0 md:bg-transparent",
                )}
              >
                <ChannelSidebar />
              </nav>

              {/* The drawer's click-catcher. Rendered only when the nav is
                  actually over the room — on a desktop column there is nothing
                  to dismiss, and an invisible full-screen catcher would eat
                  every click in the app. */}
              {!isWide && navOpen ? (
                <button
                  type="button"
                  aria-label="Close navigation"
                  onClick={closeNav}
                  className="fixed inset-0 z-30 bg-foreground/20 md:hidden"
                />
              ) : null}

              <div
                data-mode-surface="content"
                className="flex min-w-0 flex-1 flex-col"
              >
                <ChatTopChrome onOpenNav={() => setNavOpen(true)} />
                <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
              </div>
            </div>
          </PresenceProvider>
          {/* ⌘K. Mounted here rather than shared with the Work shell — it is a
              context provider's neighbour, not a singleton, and the two shells
              never coexist. */}
          <CommandPalette />
        </ShellContext.Provider>
      </ChannelsProvider>
    </MotionConfig>
  );
}
