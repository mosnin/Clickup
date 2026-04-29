"use client";

import { cn } from "@/lib/utils";

type Viewer = {
  clerkId: string;
  name: string;
  email: string;
  imageUrl?: string;
  typing: boolean;
};

// Avatar stack of who's currently here. Up to 3 avatars overlap;
// anything beyond renders as a `+N` chip. Hover/long-press surfaces a
// stacked list of names. The stack is intentionally small — it tells
// you someone's here without taking over the layout.
//
// `size` matches the heights we use elsewhere: 6 (chip), 7 (compact
// header), 8 (default header).

export function PresenceStack({
  viewers,
  size = 7,
  className,
}: {
  viewers: Viewer[];
  size?: 6 | 7 | 8;
  className?: string;
}) {
  if (viewers.length === 0) return null;
  const visible = viewers.slice(0, 3);
  const overflow = viewers.length - visible.length;
  const avatarPx = size === 6 ? 24 : size === 7 ? 28 : 32;

  return (
    <div
      className={cn(
        "inline-flex items-center",
        // Negative gap so avatars overlap; reset for the +N chip.
        "[&>*+*]:-ml-1.5",
        className,
      )}
      title={viewers.map((v) => v.name).join(", ")}
    >
      {visible.map((v) => (
        <Avatar key={v.clerkId} viewer={v} px={avatarPx} />
      ))}
      {overflow > 0 && (
        <span
          className="ml-0.5 inline-flex items-center justify-center rounded-full border border-background bg-muted px-2 text-[10px] font-medium text-muted-foreground"
          style={{ height: avatarPx }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

function Avatar({ viewer, px }: { viewer: Viewer; px: number }) {
  const initial = (viewer.name || viewer.email || "?")
    .trim()
    .charAt(0)
    .toUpperCase();
  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full border-2 border-background bg-brand-600 text-[11px] font-medium text-white"
      style={{ width: px, height: px }}
      title={viewer.typing ? `${viewer.name} (typing…)` : viewer.name}
    >
      {viewer.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={viewer.imageUrl}
          alt=""
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        initial
      )}
      {viewer.typing && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 inline-block h-2 w-2 animate-pulse rounded-full border border-background bg-emerald-500"
        />
      )}
    </span>
  );
}
