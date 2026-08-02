"use client";

// The community rail — 56px of "which world am I in".
//
// A community is a workspace (D4), and your personal space is your private
// one. Switching is not a route change: it swaps which community the sidebar,
// the unread counts and every room belong to, which is why it lives in a rail
// beside the sidebar rather than as a row inside it.
//
// Two rules borrowed verbatim, both about not lying:
//
//   • The tile's resting squircle squares off when it is active. It is the
//     Discord gesture and it survives translation because the radius change is
//     what tells you where you are without a second indicator competing with
//     the unread marks.
//   • A community whose rooms have not been observed draws no indicator at
//     all. We hold one channel subscription — the active community's — so the
//     others genuinely do not know whether they have unread. A fabricated
//     badge teaches people the badge means nothing, and after that a real one
//     stops being read either.
//
// No "+ add community" tile: a community is a workspace, and workspaces are
// created in the Work dashboard. A `+` here would leave the application for a
// form that never uses the word.

import { useChatShell } from "./chat-shell";
import { useChannels } from "./channel-data";
import { communityMark, initials } from "./sections";
import { RAIL_WIDTH_PX } from "./layout";

export function CommunityRail() {
  const { communities, scope, setScope } = useChatShell();
  const { channels } = useChannels();

  return (
    <div
      data-chat-rail=""
      style={{
        width: RAIL_WIDTH_PX,
        // Buzz pads this by the chrome height because its strip runs across
        // the rail. Ours does not — the strip belongs to the room and starts
        // where the room does — so the first tile lines up with the search
        // pill in the sidebar beside it instead. Measured, not guessed: the
        // 47px version put the rail half a screen below the sidebar's top.
        paddingTop: 6,
      }}
      className="chat-scroll flex shrink-0 flex-col items-center gap-2 px-2.5 pb-5"
    >
      {communities.map((community) => {
        const isActive =
          scope?.scopeType === community.scopeType &&
          scope?.scopeId === community.scopeId;
        const mark = communityMark(isActive ? channels : null);
        const label =
          mark.kind === "count"
            ? `${community.name} — ${mark.label} unread mentions`
            : mark.kind === "dot"
              ? `${community.name} — unread`
              : community.name;

        return (
          <button
            key={`${community.scopeType}:${community.scopeId}`}
            type="button"
            onClick={() =>
              setScope({
                scopeType: community.scopeType,
                scopeId: community.scopeId,
              })
            }
            title={label}
            aria-label={label}
            aria-current={isActive ? "true" : undefined}
            data-active={isActive ? "true" : "false"}
            className="chat-rail-tile tap-target relative"
          >
            <span aria-hidden>{initials(community.name)}</span>
            {mark.kind === "count" ? (
              <span
                data-size="sm"
                className="chat-badge absolute -bottom-0.5 -right-0.5 ring-2 ring-page"
              >
                {mark.label}
              </span>
            ) : null}
            {mark.kind === "dot" ? (
              <span className="chat-dot absolute -bottom-0.5 -right-0.5 ring-2 ring-page" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
