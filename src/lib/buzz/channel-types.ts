// What a channel looks like to the Chat UI.
//
// One shape, written down once, because three surfaces read it and they must
// not each invent their own: the rail draws it, the browser searches it, and
// the room header describes it. Pure types — no Convex, no React — so the pure
// scorer, the components and the backend can all import the same definition
// without dragging one another in.
//
// A note on the vocabulary, since it is smaller than it looks: Buzz has no
// separate "DM channel type" table and no "project channel" kind. A DM is a
// channel with two members and no name; a group DM is the same with more; a
// project channel is an ordinary channel that a template has furnished. So
// `kind` here is a rendering hint about how to title and sort a room, not a
// different kind of object with different rules.

/** How a room is drawn and titled. Not a different object — see above. */
export type ChatChannelKind = "channel" | "dm" | "group_dm" | "forum";

export type ChatChannelVisibility = "public" | "private";

/** One row in the rail, one result in the browser. */
export type ChatChannelSummary = {
  /** Stable id, unique inside a community. Not globally unique — never key on it alone. */
  channelId: string;
  /** Canonical: lowercase, dashes, no spaces. What `#name` resolves against. */
  name: string;
  /** What a person typed. A DM's is derived from its members, so it can be empty. */
  displayName: string;
  kind: ChatChannelKind;
  visibility: ChatChannelVisibility;
  topic?: string;
  description?: string;
  memberCount: number;

  /**
   * Unread messages, and unread messages that mention you.
   *
   * Two numbers rather than one because they are drawn differently and mean
   * different things: unread is a dot, a mention is a count you are expected to
   * act on. Collapsing them loses the only distinction the badge exists to make.
   */
  unread: number;
  mentions: number;

  /** Muted rooms still count unread; they just do not notify. */
  muted: boolean;
  /** Whether *you* are in it. The browser shows rooms you are not in. */
  joined: boolean;

  archivedAt?: number;
  /** Ephemeral rooms disappear after this long with no activity. */
  ttlSeconds?: number;
  /** Drives rail ordering and the "quiet since" affordances. */
  lastActivityAt?: number;
};

/** The community a room lives in — the pair `_authz` already speaks. */
export type ChatScope = {
  scopeType: "user" | "workspace";
  scopeId: string;
};
