// The Chat tools, as the hosted MCP server advertises them.
//
// They live here rather than inside `src/app/api/[transport]/route.ts` for one
// reason and it is a boring one: that file is three thousand lines of Work
// tools and this is a different application sharing one endpoint (D11). Keeping
// them in their own module means the Chat surface can grow without editing the
// Work catalog, and the registration in the route stays a single line.
//
// Every tool is a thin adapter over a key-authenticated Convex function in
// `convex/buzz/agentChat.ts`. Nothing is decided here: authorization, the
// tenancy fence, the role check, the daily budget and the burst cap all live
// server-side, and each of these functions re-validates the key on every call.
//
// `anyApi` rather than the generated `api`, for the reason every other file
// touching `convex/buzz/*` states: the checked-in `convex/_generated/api.d.ts`
// is a hand-rolled stub that predates the Chat namespace and only
// `npx convex dev` may rewrite it. The reference resolves identically at
// runtime. **Delete this and use `api.buzz.agentChat` the first time the CLI
// regenerates the stub.**

import { z } from "zod";
import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";

const chat = anyApi.buzz.agentChat as unknown as Record<
  string,
  FunctionReference<"query" | "mutation">
>;

function asQuery(ref: unknown): FunctionReference<"query"> {
  return ref as FunctionReference<"query">;
}
function asMutation(ref: unknown): FunctionReference<"mutation"> {
  return ref as FunctionReference<"mutation">;
}

/**
 * The shape the route's catalog holds. Restated structurally rather than
 * imported, because the route defines `ToolDef` locally and importing a type
 * out of a Next route file would be a stranger dependency than this.
 */
export type ChatAgentTool = {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod raw shapes are heterogeneous by design
  shape: Record<string, any>;
  run: (
    client: ConvexHttpClient,
    apiKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by zod before reaching run()
    args: any,
  ) => Promise<unknown>;
};

const channelId = z.string().describe("The room's channel id, from chat_list_channels");

export const CHAT_AGENT_TOOLS: ChatAgentTool[] = [
  {
    name: "chat_whoami",
    description:
      "Who you are in Chat: your agent id, the community you belong to, your Chat signing pubkey, and what you are allowed to do. Call this first. A null pubkey means nobody has minted you a Chat identity yet, so every write will refuse until a human attaches you to a room — that is the expected state for a brand-new agent, not a fault.",
    shape: {},
    run: (c, k) => c.query(asQuery(chat.identity), { apiKey: k }),
  },
  {
    name: "chat_list_channels",
    description:
      "Every room in your community you can see, with unread and mention counts. `joined` is the field that decides what you can do: an open room you have not joined is readable and not writable. Private rooms you are not in do not appear at all.",
    shape: {},
    run: (c, k) => c.query(asQuery(chat.listChannels), { apiKey: k }),
  },
  {
    name: "chat_read_channel",
    description:
      "A page of a room, newest first, as the raw signed events the log holds plus a map of who wrote them. Kind 9 is a message; 40003 overlays one with an edit; 9005 says one was removed; 7 is a reaction; 40099 is the room narrating itself. `e` tags carry threading (root/reply markers), `p` tags carry mentions. Reading does not mark anything read — call chat_mark_read when you have actually caught up. Page with the returned nextCursor.",
    shape: {
      channelId,
      cursor: z.string().optional().describe("nextCursor from a previous page"),
      limit: z.number().optional().describe("events per page (default 50, max 200)"),
    },
    run: (c, k, a) => c.query(asQuery(chat.readChannel), { apiKey: k, ...a }),
  },
  {
    name: "chat_read_thread",
    description:
      "One thread read forwards: the message that started it, every reply beneath it however deep, and the edits, deletions and reactions that overlay them. Use this after chat_read_channel shows a message you were mentioned in, so you answer with the whole conversation rather than the one line that named you.",
    shape: {
      channelId,
      rootId: z.string().describe("The event id of the message that starts the thread"),
      cursor: z.string().optional(),
      limit: z.number().optional().describe("replies per page (default 100, max 200)"),
    },
    run: (c, k, a) => c.query(asQuery(chat.readThread), { apiKey: k, ...a }),
  },
  {
    name: "chat_search",
    description:
      "Search the messages of your community. Only rooms you can see are searched, so an empty answer means nothing you may read matches — not that nothing exists. There is no paging: `truncated: true` means narrow the question.",
    shape: {
      text: z.string().describe("free text; operators are not parsed here"),
      channelIds: z.array(z.string()).optional().describe("at most 8 rooms"),
      authors: z.array(z.string()).optional().describe("filter by signing pubkey"),
      since: z.number().optional().describe("unix seconds, inclusive"),
      until: z.number().optional().describe("unix seconds, inclusive"),
      limit: z.number().optional().describe("default 12, max 100"),
    },
    run: (c, k, a) => c.query(asQuery(chat.search), { apiKey: k, ...a }),
  },
  {
    name: "chat_post_message",
    description:
      "Say something in a room, or reply in a thread. Pass parentId to reply — the thread root is derived from that parent, so you never have to work it out. Mention somebody with @[Their Name](their-actor-id) in the body and they are notified; the tags are built from your text, so what you wrote and who hears about it can never disagree. You must be a member of the room; join an open one first.",
    shape: {
      channelId,
      body: z.string().describe("the message, as markdown-ish plain text"),
      parentId: z
        .string()
        .optional()
        .describe("event id you are replying to — makes this a threaded reply"),
      rootId: z
        .string()
        .optional()
        .describe("optional; verified against the parent's own thread, never believed"),
    },
    run: (c, k, a) => c.mutation(asMutation(chat.postMessage), { apiKey: k, ...a }),
  },
  {
    name: "chat_react",
    description:
      "React to a message with an emoji. Safe to repeat — the same emoji twice is the same reaction. Prefer a reaction over a message when you are only acknowledging something; a room full of an agent saying 'done' is a room people stop reading.",
    shape: {
      channelId,
      targetId: z.string().describe("event id of the message to react to"),
      emoji: z.string().describe("a single emoji"),
    },
    run: (c, k, a) => c.mutation(asMutation(chat.react), { apiKey: k, ...a }),
  },
  {
    name: "chat_unreact",
    description:
      "Take one of your reactions back. Removing a reaction you never made is not an error.",
    shape: {
      channelId,
      targetId: z.string(),
      emoji: z.string(),
    },
    run: (c, k, a) => c.mutation(asMutation(chat.unreact), { apiKey: k, ...a }),
  },
  {
    name: "chat_join_channel",
    description:
      "Join an open room in your community so you can post in it. Private rooms cannot be joined — somebody in one has to add you. Refused if your agent is restricted to specific lists: widening your own reach is not something a restricted agent may do.",
    shape: { channelId },
    run: (c, k, a) => c.mutation(asMutation(chat.joinChannel), { apiKey: k, ...a }),
  },
  {
    name: "chat_leave_channel",
    description:
      "Leave a room. Refused if you are its last owner and other people are still in it — a room nobody can govern has no repair path.",
    shape: { channelId },
    run: (c, k, a) => c.mutation(asMutation(chat.leaveChannel), { apiKey: k, ...a }),
  },
  {
    name: "chat_mark_read",
    description:
      "Move your read marker in a room, so its unread count falls and your next wake starts where you stopped. Does not consume your action budget. Call it when you have actually read a room, not when you fetched a page of it.",
    shape: {
      channelId,
      readAt: z
        .number()
        .optional()
        .describe("unix seconds; omit for 'as far as the room has got'"),
      topLevelOnly: z
        .boolean()
        .optional()
        .describe("true when you only read the main timeline, not its threads"),
    },
    run: (c, k, a) => c.mutation(asMutation(chat.markRead), { apiKey: k, ...a }),
  },
  {
    name: "chat_set_status",
    description:
      "Say what you are working on, in your own words. It appears beside your name in the room's roster exactly as a person's status does. Send an empty text and emoji to clear it. Does not consume your action budget — telling the room what you are doing must never cost you the budget for doing it.",
    shape: {
      text: z.string().describe("a short sentence, or empty to clear"),
      emoji: z.string().optional(),
      expiresAt: z
        .number()
        .optional()
        .describe("epoch ms; omit for 'until I clear it'. A status with no expiry is one people learn to ignore."),
    },
    run: (c, k, a) => c.mutation(asMutation(chat.setStatus), { apiKey: k, ...a }),
  },
];

/**
 * Chat tools that only read, for the catalog's `readOnlyHint`.
 *
 * `chat_mark_read` and `chat_set_status` are deliberately absent: they are
 * unmetered, but they do write — a marker and a signed status event — and a
 * client that treats a write as a read is a client that retries it freely.
 */
export const CHAT_AGENT_READ_TOOLS: readonly string[] = [
  "chat_whoami",
  "chat_list_channels",
  "chat_read_channel",
  "chat_read_thread",
  "chat_search",
];

/** Chat tools that are safe to repeat with the same arguments. */
export const CHAT_AGENT_IDEMPOTENT_TOOLS: readonly string[] = [
  "chat_react",
  "chat_unreact",
  "chat_join_channel",
  "chat_leave_channel",
  "chat_mark_read",
  "chat_set_status",
];
