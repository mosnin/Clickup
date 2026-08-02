// What a message looks like to the Chat UI.
//
// The second contract, written before the phase for the same reason as the
// first: the transcript, the thread pane, the composer's optimistic row and the
// search-hit renderer all draw one of these, and three private ideas of what a
// message is would disagree about edits within a week.
//
// The shape is a *projection*, not a stored row. The log holds signed events —
// a message, its later edit, its deletions, its reactions — and one pure
// function folds them into what a person actually reads. That fold is the
// single place where "an edited message shows its new text" is decided, which
// is why there must be exactly one of it.

/** An emoji pill under a message. */
export type ChatReaction = {
  emoji: string;
  /** Set when the emoji is a `:shortcode:` resolved against a custom emoji tag. */
  emojiUrl?: string;
  count: number;
  /** Whether the reader is one of the reactors — drives the pill's active state. */
  mine: boolean;
  /** Display labels, "You" first for the reader. */
  reactors: string[];
  /**
   * The earliest reaction of this emoji.
   *
   * Retained rather than the latest, because pills are ordered by it and a
   * "latest" timestamp would let pills reorder themselves whenever somebody
   * reacted again — the row would visibly shuffle under the reader's cursor.
   */
  firstAt: number;
};

export type ChatMessage = {
  /** The event id. */
  id: string;

  /**
   * A key that survives the optimistic → acknowledged transition.
   *
   * The optimistic row has no event id yet (the id is a hash of the signed
   * event, which only exists once the server has signed it), so keying React on
   * `id` remounts the row the moment it lands and the message visibly flickers.
   * `renderKey` is the local key while pending and the event id afterwards.
   */
  renderKey: string;

  createdAt: number;

  /**
   * Who this is *attributed* to, and who cryptographically signed it.
   *
   * These differ, and conflating them is a security bug rather than a display
   * bug. A relay-signed event — a membership notification, say — is signed by
   * the community's relay key but attributed to the person it is about. Any
   * check that means "did this principal really write this" must read
   * `signerPubkey`; anything drawing a name or an avatar wants `pubkey`.
   */
  pubkey: string;
  signerPubkey: string;

  /** Resolved display label for `pubkey`. */
  author: string;
  authorAvatarUrl?: string;
  /** Agents are members, not bots — but the room still says which is which. */
  isAgent: boolean;
  /** For an agent: the principal it belongs to, so a room can see who is answerable. */
  ownerLabel?: string;
  /** The author's role in this channel, if any. */
  role?: string;

  /** The content a reader sees — the EDITED text when an edit exists. */
  body: string;
  /** Tags after the edit overlay: the edit's media tags, the original's everything else. */
  tags: string[][];
  kind: number;

  parentId?: string;
  rootId?: string;
  /** 0 for a top-level message. Cycle-guarded during resolution. */
  depth: number;

  edited: boolean;
  /** Written but not yet acknowledged by the server. */
  pending: boolean;
  /** The optimistic send failed; the row offers a retry. */
  failed?: boolean;
  /** Authored by the reader — drives the accent treatment. */
  mine: boolean;
  /** Jump-to-message landed here; the row flashes once. */
  highlighted?: boolean;

  reactions: ChatReaction[];
};

/**
 * A row in the rendered transcript.
 *
 * The transcript is not a list of messages: it is a list of *rows*, and some
 * rows are not messages. Modelling the dividers as rows rather than as
 * decorations rendered beside messages is what lets one virtualized list
 * measure everything it draws — a divider drawn inside a message row makes that
 * row a different height than the virtualizer was told.
 */
export type ChatRow =
  | { type: "message"; message: ChatMessage; /** Continuation of the message above. */ grouped: boolean }
  | { type: "day"; at: number }
  | { type: "unread"; count: number }
  | { type: "system"; id: string; at: number; text: string }
  /**
   * Consecutive system events of the same sort, folded into one row.
   *
   * Not a rendering nicety. Ten people joining a channel is one fact, and
   * drawing it as ten rows pushes the conversation off the screen with an
   * announcement nobody asked for — the transcript ends up being mostly
   * bookkeeping about itself. The window is short (§2.10) so that joins hours
   * apart still read as separate events.
   *
   * A distinct variant rather than a `count` on `system`, because a folded row
   * needs its members to draw a facepile and to expand, and a `system` row with
   * an optional array is a variant wearing a disguise.
   */
  | {
      type: "system-group";
      id: string;
      at: number;
      /** What they all did — "joined", "left". */
      kind: string;
      /** Display labels, in arrival order. */
      actors: string[];
      text: string;
    };
