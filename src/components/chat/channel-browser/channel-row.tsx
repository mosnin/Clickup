"use client";

// One result in the browser (§1.3's `ChannelCard`).
//
// The row is the selectable thing and Join is a button inside it. That is a
// nested interactive inside `role="option"`, which is an ARIA compromise made
// knowingly: the alternative — Join outside the option — breaks the listbox's
// child contract instead, and this way the whole row stays one target for the
// arrow keys and for a thumb. Join is still reachable by Tab.
//
// The `#` is a semantic type indicator, not decoration: it is how a room is
// named everywhere else in the product, and dropping it here would make the
// browser the one place a channel does not look like a channel.

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";

export function ChannelRow({
  channel,
  id,
  selected,
  joining,
  onSelect,
  onJoin,
}: {
  channel: ChatChannelSummary;
  id: string;
  selected: boolean;
  joining: boolean;
  onSelect: () => void;
  onJoin: () => void;
}) {
  const archived = channel.archivedAt !== undefined && channel.archivedAt !== null;
  const members = `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`;

  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold">
            <span aria-hidden className="text-muted-foreground">#</span>
            {channel.displayName || channel.name}
          </span>
          {channel.visibility === "private" ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
              Private
            </span>
          ) : null}
          {archived ? (
            <span className="shrink-0 rounded-full bg-pastel-yellow px-2 py-0.5 text-[11px] uppercase tracking-wider text-foreground">
              Archived
            </span>
          ) : null}
        </div>
        <p className="truncate text-[13px] text-muted-foreground">
          {members}
          {channel.description ? ` · ${channel.description}` : ""}
        </p>
      </div>

      {channel.joined ? null : (
        // Hidden until the row is hovered, focused or keyboard-selected: with
        // it always visible, a list of twenty rooms reads as twenty calls to
        // action rather than as a list you are reading.
        <Button
          size="sm"
          variant="outline"
          disabled={joining}
          onClick={(e) => {
            e.stopPropagation();
            onJoin();
          }}
          className={cn(
            "shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
            selected && "opacity-100",
          )}
        >
          {joining ? "Joining…" : "Join"}
        </Button>
      )}
    </div>
  );
}
