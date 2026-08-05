"use client";

// Which community am I in — asked the way Work asks it.
//
// This replaces a 56px icon rail of squircles. The rail was a good rail: the
// squircle squaring off on the active tile is a real gesture and the unread
// marks were honest about what they could not know. It was still wrong here,
// for one reason that outranks all of that.
//
// A community IS a workspace. Work already asks "which workspace" with a
// dropdown at the top of the sidebar, and Chat asked the same question with a
// permanent column of glyphs down the left edge. One product, one question,
// two navigations — and the rail is the one that has to go, because it is the
// one Work has no equivalent of. Keeping it would mean every reader learns
// the concept twice and the two halves keep looking like two products.
//
// What is lost and why that is acceptable: at-a-glance unread across ALL
// communities. Only the active community holds a channel subscription, so the
// rail could only ever mark the one you were already looking at — which is
// the one place you do not need a badge. The dropdown says the same true
// thing in the same amount of space as everything else in the header.

import { Check, ChevronDown } from "lucide-react";
import { Orb } from "@/components/dashboard/orb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatShell } from "./chat-shell";

export function CommunitySwitcher() {
  const { communities, scope, setScope, scopeName } = useChatShell();
  const current = scope
    ? communities.find(
        (c) => c.scopeType === scope.scopeType && c.scopeId === scope.scopeId,
      )
    : undefined;
  const name = current?.name ?? scopeName ?? "Personal space";
  const seed = scope ? `${scope.scopeType}:${scope.scopeId}` : "personal";

  return (
    <DropdownMenu>
      {/* Deliberately the same element, classes and ornament as the Work
          sidebar's workspace trigger: orb, name, chevron, one rounded row.
          Not "similar" — the same, so the two shells cannot drift apart the
          next time one of them is touched. */}
      <DropdownMenuTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg p-1 text-left outline-none hover:bg-[var(--chat-hover)]">
        <Orb seed={seed} label={name} shape="squircle" size="sm" />
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
        <ChevronDown aria-hidden className="chat-quiet size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          Communities
        </DropdownMenuLabel>
        {communities.map((community) => {
          const isActive =
            scope?.scopeType === community.scopeType &&
            scope?.scopeId === community.scopeId;
          return (
            <DropdownMenuItem
              key={`${community.scopeType}:${community.scopeId}`}
              // Switching a community is not a route change — it swaps which
              // community the sidebar, the unreads and every room belong to —
              // so this stays a button, unlike Work's, whose entries are
              // genuinely links to different addresses.
              onSelect={() =>
                setScope({
                  scopeType: community.scopeType,
                  scopeId: community.scopeId,
                })
              }
            >
              <Orb
                seed={`${community.scopeType}:${community.scopeId}`}
                label={community.name}
                shape="squircle"
                size="xs"
                className="mr-1 h-5 w-5 text-[9px]"
              />
              <span className="min-w-0 flex-1 truncate">{community.name}</span>
              {isActive ? <Check className="ml-1 size-4 shrink-0" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
