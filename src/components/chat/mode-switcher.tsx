"use client";

// Work ⇄ Chat.
//
// Two dashboards, one product. Work is the canvas — tasks, projects, panels,
// the things you arrange. Chat is the room — channels, threads, huddles, the
// place people and agents actually talk. They share an identity, an agent
// fleet, an inbox and a search index, so this is a switch between two views of
// one workspace, not a link to a different app.
//
// It is a pair of links, not a stateful toggle. That matches how the workspace
// switcher directly below it already works — picking a different entry just
// navigates — and it means the browser's own back button, middle-click and
// "open in new tab" all behave, which a button that calls router.push() quietly
// breaks.
//
// It sits above the workspace switcher because mode is the coarser question:
// "which application am I in" has to be answerable before "which workspace".
//
// **C12 gave it a number.** Being in Chat with three approvals waiting in Work
// has to be visible or the two modes are two applications you remember to
// check, and that single number is most of what makes them read as one product.
// The two counts are disjoint by construction — see `partitionCounts` — so the
// badge on the half you are not standing in is exactly the number of things
// waiting there, never a share of one queue counted twice.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessagesSquare, SquareKanban } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModeBadge, useModeBadges } from "@/components/chat/bridge";

type Mode = "work" | "chat";

const MODES: { mode: Mode; label: string; href: string; Icon: typeof MessagesSquare }[] = [
  { mode: "work", label: "Work", href: "/dashboard", Icon: SquareKanban },
  { mode: "chat", label: "Chat", href: "/chat", Icon: MessagesSquare },
];

/**
 * `collapsible` is for the Work sidebar, whose rail narrows to icons. Two
 * labelled halves cannot survive a 48px rail, so in that mode the control
 * becomes a single glyph pointing at the *other* dashboard — a switch rather
 * than a segmented control. Chat's rail is a fixed width and passes false.
 */
export function ModeSwitcher({
  collapsible = false,
  className,
}: {
  collapsible?: boolean;
  className?: string;
}) {
  const pathname = usePathname();
  const active: Mode = pathname.startsWith("/chat") ? "chat" : "work";
  const other = MODES.find((m) => m.mode !== active)!;
  // One subscription for both forms of the control. Mounting it inside the
  // badge would open two — the segmented control renders one per half, and the
  // rail renders a third.
  const { work, chat, subscription } = useModeBadges();
  const countFor = (mode: Mode) => (mode === "work" ? work : chat);

  return (
    <div className={cn("w-full", className)}>
      {subscription}
      <div
        className={cn(
          "segmented w-full",
          collapsible && "group-data-[collapsible=icon]:hidden",
        )}
        role="group"
        aria-label="Switch dashboard"
      >
        {MODES.map(({ mode, label, href, Icon }) => (
          <Link
            key={mode}
            href={href}
            aria-current={active === mode ? "page" : undefined}
            className={cn(
              "flex-1 justify-center gap-1.5",
              active === mode && "segmented-on",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            {/* Only ever on the side you are not standing in: a count of what
                is waiting on the screen you are already looking at is a number
                that argues with the screen. */}
            {active === mode ? null : (
              <ModeBadge count={countFor(mode)} label={label} />
            )}
          </Link>
        ))}
      </div>

      {collapsible ? (
        // The rail form. Only ever rendered collapsed, so it carries the
        // destination in its label — an unlabelled glyph in a 48px rail is a
        // guess, and this one changes what application you are looking at.
        <Link
          href={other.href}
          title={`Switch to ${other.label}`}
          aria-label={`Switch to ${other.label}`}
          className="tap-target relative hidden size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:flex"
        >
          <other.Icon aria-hidden className="size-4" />
          {/* A dot rather than a number: a two-digit badge on a 32px glyph is
              illegible, and in the rail the question is only "is there
              anything". The exact count is one click away, and one hover away
              through the label. */}
          {countFor(other.mode) > 0 ? (
            <span
              aria-hidden
              className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-foreground"
            />
          ) : null}
        </Link>
      ) : null}
    </div>
  );
}
