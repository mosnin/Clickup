"use client";

// The channel sidebar: search, the primary menu, the rooms, and you.
//
// Section order is fixed and it is an argument, not a habit. Search is pinned
// above the scroller because it is the escape hatch from a list too long to
// scan. The primary menu is next because "everything addressed to me" outranks
// any single room. Then the rooms themselves, then direct messages last —
// which looks like a demotion and is the opposite: a DM list is short, it goes
// where a short list can live without pushing forty channels off screen.
//
// Two structural notes:
//
//   • Only the middle scrolls. The search pill and the profile card are
//     pinned, so the two things you reach for without reading stay where your
//     hand expects them, no matter how many rooms exist.
//   • The scroller reports its own unread overflow. A sidebar of forty rooms
//     will hide the one shouting at you above the fold, and a badge you cannot
//     see is a badge that does not work — hence the pill.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronDown,
  GitBranch,
  Home,
  Plus,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { ModeSwitcher } from "@/components/chat/mode-switcher";
import { ChannelBrowserDialog } from "@/components/chat/channel-browser";
import { cn } from "@/lib/utils";
import { useChatShell } from "./chat-shell";
import { useChannels } from "./channel-data";
import { ChannelRow } from "./channel-row";
import { CommunitySwitcher } from "./community-switcher";
import { ChatCustomiseRow, ChatProfileCard } from "./profile-card";
import { SidebarGrip } from "./sidebar-grip";
import {
  sidebarSections,
  unreadCountLabel,
  unreadOverflow,
  type ChatSectionId,
} from "./sections";
import { channelHref } from "./layout";

export function ChannelSidebar() {
  const { sidebarOpen, closeNav, channelId, scope } = useChatShell();
  const { channels, error } = useChannels();
  const pathname = usePathname();
  const router = useRouter();

  // The channel browser, opened from the Channels section's `+`. One dialog
  // for the whole sidebar rather than one per section: it is the same errand
  // from wherever it is started, and mounting it per section would be a second
  // piece of open state that can disagree with the first.
  const [browsing, setBrowsing] = useState(false);

  // Rooms hidden by an in-flight "leave", by id. Held here rather than in the
  // row so the row can unmount — the undo has to outlive the thing it undoes.
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const onHidden = useCallback((id: string, isHidden: boolean) => {
    setHidden((prev) => ({ ...prev, [id]: isHidden }));
  }, []);

  const [collapsed, setCollapsed] = useState<Record<ChatSectionId, boolean>>({
    channels: false,
    forums: false,
    dms: false,
  });

  const sections = useMemo(
    () => sidebarSections((channels ?? []).filter((c) => !hidden[c.channelId])),
    [channels, hidden],
  );

  const mentions = (channels ?? []).reduce((sum, c) => sum + c.mentions, 0);

  return (
    <div
      data-chat-sidebar=""
      data-open={sidebarOpen ? "true" : "false"}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col md:flex-none",
        // Below `md` the sidebar fills the drawer; above it, it is exactly as
        // wide as it was dragged, and zero when collapsed. The collapse is a
        // width transition rather than a display swap so the content card
        // grows into the space instead of jumping into it.
        "md:w-[var(--chat-sidebar-w)] md:overflow-hidden md:transition-[width] md:duration-200 md:ease-out",
      )}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {/* Pinned header */}
        <div className="px-2 pb-1 pt-1.5">
          {/* Work or Chat, at the top of the sidebar — the same place, and the
              same control, as the Work dashboard puts it. Mode is the coarsest
              question the navigation answers, so it sits above the search that
              only reaches into this one. It lived in the top chrome first,
              which put the way out of the application in a different corner
              from the way around it. */}
          <ModeSwitcher className="mb-1.5" />
          {/* Which community, in the same slot and the same shape as the Work
              sidebar's workspace control. This replaced a 56px icon rail —
              see community-switcher.tsx for why a second navigation for the
              same question had to go rather than be restyled. */}
          <CommunitySwitcher />
          <button
            type="button"
            // The palette is mounted by the shell and listens for this event —
            // the same one the Work sidebar's search button dispatches, so
            // there is one search in the product rather than two that drift.
            onClick={() =>
              window.dispatchEvent(new Event("open-command-palette"))
            }
            className="chat-row mt-1 justify-start hover:bg-[var(--chat-hover)]"
          >
            <Search aria-hidden className="chat-quiet size-3.5 shrink-0" />
            <span className="chat-quiet flex-1 truncate text-left">
              Search everything
            </span>
            <kbd className="chat-quiet shrink-0 text-tiny font-medium">
              ⌘K
            </kbd>
          </button>
        </div>

        <SidebarScroller>
          {/* Primary menu. Workflows is a later phase and is deliberately
              absent: a nav row that goes nowhere is worse than a short menu.
              Moderation is listed for everybody rather than gated
              here — the Convex functions are the real boundary, a client-side
              guard would only be UX, and a member who opens it reads the
              server's own refusal instead of wondering where the link went. */}
          <ul className="px-2 pb-1">
            <li>
              <Link
                href="/chat"
                onClick={closeNav}
                data-active={pathname === "/chat" ? "true" : "false"}
                aria-current={pathname === "/chat" ? "page" : undefined}
                className="chat-row"
              >
                <Home aria-hidden className="chat-quiet size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Home</span>
                {mentions > 0 ? (
                  <span className="chat-badge shrink-0">
                    {mentions > 99 ? "99+" : mentions}
                  </span>
                ) : null}
              </Link>
            </li>
            <li>
              <Link
                href="/chat/pulse"
                onClick={closeNav}
                data-active={pathname.startsWith("/chat/pulse") ? "true" : "false"}
                aria-current={pathname.startsWith("/chat/pulse") ? "page" : undefined}
                className="chat-row"
              >
                <Activity aria-hidden className="chat-quiet size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Pulse</span>
              </Link>
            </li>
            <li>
              {/* Projects. A branch is a room, so this route is a way *into*
                  the rooms below rather than a separate place — which is why it
                  sits with Home and Pulse and not in its own section. */}
              <Link
                href="/chat/projects"
                onClick={closeNav}
                data-active={pathname.startsWith("/chat/projects") ? "true" : "false"}
                aria-current={
                  pathname.startsWith("/chat/projects") ? "page" : undefined
                }
                className="chat-row"
              >
                <GitBranch aria-hidden className="chat-quiet size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Projects</span>
              </Link>
            </li>
            <li>
              <Link
                href="/chat/moderation"
                onClick={closeNav}
                data-active={pathname.startsWith("/chat/moderation") ? "true" : "false"}
                aria-current={
                  pathname.startsWith("/chat/moderation") ? "page" : undefined
                }
                className="chat-row"
              >
                <ShieldCheck aria-hidden className="chat-quiet size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Moderation</span>
              </Link>
            </li>
            <li>
              {/* Last in the menu, because it is the row you want least often
                  and the one you want to be able to find without reading. */}
              <Link
                href="/chat/settings"
                onClick={closeNav}
                data-active={pathname.startsWith("/chat/settings") ? "true" : "false"}
                aria-current={
                  pathname.startsWith("/chat/settings") ? "page" : undefined
                }
                className="chat-row"
              >
                <Settings aria-hidden className="chat-quiet size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Settings</span>
              </Link>
            </li>
          </ul>

          {channels === undefined && error === null ? <RoomsSkeleton /> : null}

          {sections.map((section) =>
            channels === undefined ? null : (
              <section key={section.id} className="px-2 pb-1">
                <div className="group/section relative flex items-center">
                  <button
                    type="button"
                    aria-expanded={!collapsed[section.id]}
                    onClick={() =>
                      setCollapsed((prev) => ({
                        ...prev,
                        [section.id]: !prev[section.id],
                      }))
                    }
                    className="chat-section-label"
                  >
                    <span className="truncate">{section.label}</span>
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/section:opacity-100",
                        collapsed[section.id] && "-rotate-90",
                      )}
                    />
                  </button>
                  {section.action ? (
                    // Two sections carry a `+` and only one of them has
                    // somewhere to go. Channels opens the browser — the only
                    // way in the product to find or make a room. Direct
                    // messages stays disabled and says why: a DM is opened
                    // around people rather than a name, so it needs a picker
                    // that does not exist, and a control that produces a stub
                    // is worse than a control that waits.
                    // `pointer-coarse` is the same rule the resize grip
                    // carries and it is load-bearing here rather than polite:
                    // touch has no hover, so a `+` that only appears under a
                    // mouse is a `+` that does not exist on a phone — and this
                    // one is the only way in the product to find or create a
                    // room. It cost nothing while the control was disabled.
                    section.id === "channels" && scope ? (
                      <button
                        type="button"
                        onClick={() => setBrowsing(true)}
                        aria-haspopup="dialog"
                        title={section.action}
                        aria-label={section.action}
                        className="chat-icon-button tap-target absolute right-0 opacity-0 transition-opacity pointer-coarse:opacity-60 focus-visible:opacity-100 group-hover/section:opacity-60"
                      >
                        <Plus aria-hidden className="size-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled
                        title={
                          section.id === "dms"
                            ? `${section.action} — not yet. A DM needs a people picker that is not built.`
                            : section.action
                        }
                        aria-label={section.action}
                        className="chat-icon-button tap-target absolute right-0 opacity-0 transition-opacity pointer-coarse:opacity-30 group-hover/section:opacity-60"
                      >
                        <Plus aria-hidden className="size-3.5" />
                      </button>
                    )
                  ) : null}
                </div>

                {collapsed[section.id] ? null : (
                  <ul>
                    {section.channels.map((channel) => (
                      <ChannelRow
                        key={channel.channelId}
                        channel={channel}
                        isActive={channel.channelId === channelId}
                        onNavigate={closeNav}
                        onHidden={onHidden}
                      />
                    ))}
                    {section.channels.length === 0 ? (
                      <li className="chat-quiet px-2 py-1 text-xs">
                        Nothing here yet.
                      </li>
                    ) : null}
                  </ul>
                )}
              </section>
            ),
          )}

          {error ? (
            // Section 8 of the sidebar: the room list failed. The reason, not
            // an apology — "could not find buzz/channels:list" is the sentence
            // that says what is missing.
            <p role="status" className="px-4 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </SidebarScroller>

        {/* The footer says the same things, in the same order, as the Work
            sidebar's: the way into customising, then how light it is, then
            who you are. Chat used to offer only a profile card and a single
            moon — so the two halves of one product disagreed about both what
            a footer is for and what a theme control looks like, which is most
            of why moving between them felt like moving between two apps.

            Stacked rather than crammed onto one row: the three-way control is
            `w-full` by design, and sharing a row with the profile card is what
            forced the one-button form in the first place. */}
        <div className="flex flex-col gap-1 px-2 pb-2 pt-1">
          <ChatCustomiseRow />
          <ThemeToggle />
          <ChatProfileCard />
        </div>
      </div>

      <SidebarGrip />

      {/* Mounted only while open. The dialog subscribes to the community's
          full channel list — every room the reader may see, not just the ones
          they are in — and that is a heavier read than the rail's, so it costs
          nothing until somebody asks for it. */}
      {scope && browsing ? (
        <ChannelBrowserDialog
          scope={scope}
          open
          onOpenChange={setBrowsing}
          onSelectChannel={(id) => {
            // The drawer closes too: on a phone it is covering the room that
            // was just chosen, and leaving it up makes the answer invisible.
            closeNav();
            router.push(channelHref(id));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The scrolling middle, plus the unread-overflow pills.
 *
 * The measurement lives here because the DOM is the only thing that knows
 * where rows ended up; the *rule* is `unreadOverflow`, which is pure and
 * tested. Rows announce themselves with `data-unread-count` rather than being
 * passed down as refs — one attribute is cheaper than plumbing a registry
 * through three components, and it survives a row re-ordering.
 */
function SidebarScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ above: 0, below: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function apply(): string {
      const scroller = ref.current;
      if (!scroller) return "";
      const view = scroller.getBoundingClientRect();
      const rows = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-unread-count]"),
      ).map((row) => {
        const box = row.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          count: Number(row.dataset.unreadCount) || 0,
        };
      });
      const next = unreadOverflow(rows, { top: view.top, bottom: view.bottom });
      setOverflow((prev) =>
        prev.above === next.above && prev.below === next.below ? prev : next,
      );
      // A signature of where the rows actually sit, so the settle loop below
      // can tell "the DOM changed shape" from "the rows are still sliding
      // into place". The latter is a transform, invisible to the
      // MutationObserver watching childList/subtree below, which is how a
      // single post-mount measurement ended up permanently comparing the
      // pill against a row's mid-entrance position instead of its rest one —
      // nothing ever asked again once the childList stopped changing.
      return rows.map((r) => `${r.top.toFixed(1)}:${r.bottom.toFixed(1)}`).join("|");
    }

    let raf = 0;
    let settledFrames = 0;
    let lastSignature: string | null = null;

    function tick() {
      raf = 0;
      const signature = apply();
      if (signature === lastSignature) {
        settledFrames += 1;
      } else {
        settledFrames = 0;
        lastSignature = signature;
      }
      // Three consecutive frames reporting identical row positions is "at
      // rest" — one frame cannot tell a paused-but-still-moving entrance from
      // a finished one, and stopping at the first measurement is the bug
      // this replaces.
      if (settledFrames < 3) raf = requestAnimationFrame(tick);
    }

    tick();
    const observer = new MutationObserver(() => {
      settledFrames = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    });
    observer.observe(el, { childList: true, subtree: true });
    el.addEventListener("scroll", apply, { passive: true });
    window.addEventListener("resize", apply);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      el.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);

  function scrollTo(direction: "above" | "below") {
    const scroller = ref.current;
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    const rows = Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-unread-count]'),
    ).filter((row) => Number(row.dataset.unreadCount) > 0);
    const target =
      direction === "above"
        ? rows.filter((r) => r.getBoundingClientRect().bottom <= view.top).pop()
        : rows.find((r) => r.getBoundingClientRect().top >= view.bottom);
    target?.scrollIntoView({ block: "nearest" });
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* `bottom-9`, not `pb-9`: the floating unread pill's footprint has to
          come out of the scroller's own clipped box, not out of its
          scrollable content. Padding only reserves space at the END of the
          content, which protects a fully-scrolled-to-bottom state and
          nothing else — at rest, or anywhere mid-scroll, whatever row
          happened to sit at the visible edge was still directly behind the
          pill (this is what the audit caught covering "Jordan Brooks" without
          anyone having scrolled at all). Shrinking the scroller's own box by
          the same amount means no row can ever be positioned under the
          pill's footprint, in any scroll position, because that strip is
          never part of the visible viewport to begin with. */}
      <div ref={ref} className="chat-scroll absolute inset-x-0 top-0 bottom-9">
        {children}
      </div>
      {overflow.above > 0 ? (
        <UnreadPill
          direction="above"
          count={overflow.above}
          onClick={() => scrollTo("above")}
        />
      ) : null}
      {overflow.below > 0 ? (
        <UnreadPill
          direction="below"
          count={overflow.below}
          onClick={() => scrollTo("below")}
        />
      ) : null}
    </div>
  );
}

function UnreadPill({
  direction,
  count,
  onClick,
}: {
  direction: "above" | "below";
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-unread-pill={direction}
      className={cn(
        "absolute left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-1 rounded-full bg-background/95 px-2 text-tiny shadow-lg backdrop-blur-sm",
        direction === "above" ? "top-1" : "bottom-1",
      )}
    >
      <ChevronDown
        aria-hidden
        className={cn("size-3", direction === "above" && "rotate-180")}
      />
      <span className="chat-quiet">{unreadCountLabel(count)}</span>
    </button>
  );
}

function RoomsSkeleton() {
  return (
    <div className="space-y-1 px-2 py-2" aria-hidden>
      {[80, 60, 72, 52, 66].map((width, index) => (
        <div key={index} className="flex h-8 items-center gap-2 px-2">
          <span className="size-4 shrink-0 rounded bg-muted" />
          <span
            className="h-3 rounded bg-muted"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}
