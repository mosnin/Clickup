// The emoji the picker offers, and how a query finds them.
//
// Hand-rolled rather than emoji-mart, and the reason is the same one the
// marketing site gives for its fonts: nothing is fetched from a CDN and no
// 1.8k-entry index is built synchronously on first open. emoji-mart's own
// documented failure — the picker freezing the cursor while it indexes — is
// paid for by every person who opens it once to send a 👍.
//
// So this is a curated set: the emoji a work chat actually reaches for,
// grouped the way people look for them, each with the words they would search
// by. It is deliberately small enough to render in one pass and honest about
// being a selection rather than a catalogue.
//
// Pure data + one pure filter, so the picker component holds no vocabulary of
// its own — the same reason the panel vocabulary lives outside its renderer.

/** A standard emoji: the glyph itself is what gets sent. */
export type StandardEmoji = { native: string; name: string; keywords: string[] };

/**
 * A community's own emoji, uploaded rather than Unicode.
 *
 * It has no glyph, so what gets sent is `:shortcode:` — the renderers resolve
 * it. That asymmetry is the whole reason `selectionToken` exists below rather
 * than each call site deciding.
 */
export type CustomEmoji = { shortcode: string; url: string };

export type EmojiGroup = { id: string; label: string; emoji: StandardEmoji[] };

const e = (native: string, name: string, ...keywords: string[]): StandardEmoji => ({
  native,
  name,
  keywords: [name, ...keywords],
});

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: "reactions",
    label: "Reactions",
    emoji: [
      e("👍", "thumbs up", "yes", "approve", "lgtm", "+1"),
      e("👎", "thumbs down", "no", "nope", "-1"),
      e("👏", "clap", "applause", "nice", "well done"),
      e("🙌", "raised hands", "celebrate", "praise", "hooray"),
      e("🙏", "pray", "please", "thanks", "thank you"),
      e("🤝", "handshake", "deal", "agree", "partner"),
      e("💪", "flex", "strong", "muscle"),
      e("✅", "check", "done", "tick", "complete", "shipped"),
      e("❌", "cross", "no", "fail", "wrong"),
      e("👀", "eyes", "looking", "watching", "review"),
      e("🔥", "fire", "hot", "lit", "great"),
      e("🎉", "party", "tada", "celebrate", "launch", "ship"),
      e("💯", "hundred", "perfect", "score"),
      e("🚀", "rocket", "ship", "launch", "deploy", "fast"),
      e("⚡", "zap", "fast", "lightning", "quick"),
      e("✨", "sparkles", "magic", "new", "polish"),
    ],
  },
  {
    id: "faces",
    label: "Smileys",
    emoji: [
      e("😀", "grinning", "happy", "smile"),
      e("😄", "smile", "happy", "joy"),
      e("😅", "sweat smile", "nervous", "phew"),
      e("😂", "joy", "laugh", "lol", "crying laughing"),
      e("🙂", "slight smile", "happy"),
      e("😉", "wink", "joking"),
      e("😊", "blush", "happy", "shy"),
      e("😍", "heart eyes", "love", "adore"),
      e("🤔", "thinking", "hmm", "consider"),
      e("😐", "neutral", "meh", "deadpan"),
      e("🙃", "upside down", "irony", "oh well"),
      e("😴", "sleeping", "tired", "zzz"),
      e("😬", "grimace", "awkward", "yikes"),
      e("😭", "sob", "crying", "sad"),
      e("😱", "scream", "shock", "fear"),
      e("🤯", "mind blown", "wow", "exploding head"),
      e("😎", "sunglasses", "cool"),
      e("🥳", "partying", "celebrate", "birthday"),
      e("🤷", "shrug", "dunno", "whatever"),
      e("🫠", "melting", "overwhelmed", "hot"),
    ],
  },
  {
    id: "hearts",
    label: "Hearts",
    emoji: [
      e("❤️", "red heart", "love"),
      e("🧡", "orange heart"),
      e("💛", "yellow heart"),
      e("💚", "green heart"),
      e("💙", "blue heart"),
      e("💜", "purple heart"),
      e("🖤", "black heart"),
      e("🤍", "white heart"),
      e("💔", "broken heart", "sad"),
      e("💕", "two hearts", "love"),
    ],
  },
  {
    id: "work",
    label: "Work",
    emoji: [
      e("📌", "pin", "pinned", "important"),
      e("📎", "paperclip", "attachment", "file"),
      e("📝", "memo", "note", "write", "doc"),
      e("📄", "page", "document", "file"),
      e("📊", "bar chart", "report", "metrics", "data"),
      e("📈", "chart up", "growth", "increase"),
      e("📉", "chart down", "decline", "decrease"),
      e("🗓️", "calendar", "schedule", "date", "meeting"),
      e("⏰", "alarm", "reminder", "deadline", "time"),
      e("⏳", "hourglass", "waiting", "pending"),
      e("🔗", "link", "url", "chain"),
      e("🔒", "lock", "private", "secure"),
      e("🔑", "key", "access", "secret"),
      e("🛠️", "tools", "build", "fix", "maintenance"),
      e("🐛", "bug", "defect", "issue", "error"),
      e("🧪", "test", "experiment", "lab"),
      e("🚢", "ship", "release", "deploy"),
      e("🧹", "broom", "cleanup", "chore", "tidy"),
      e("📦", "package", "build", "bundle", "release"),
      e("🤖", "robot", "agent", "bot", "automation"),
    ],
  },
  {
    id: "signals",
    label: "Signals",
    emoji: [
      e("⚠️", "warning", "caution", "careful"),
      e("🚨", "siren", "alert", "urgent", "incident"),
      e("🛑", "stop", "halt", "blocked"),
      e("❓", "question", "ask", "unsure"),
      e("❗", "exclamation", "important"),
      e("💡", "bulb", "idea", "suggestion", "insight"),
      e("🧠", "brain", "think", "smart"),
      e("🎯", "target", "goal", "focus", "objective"),
      e("🏁", "finish", "done", "checkered flag"),
      e("🥇", "first place", "win", "gold"),
      e("🔍", "magnifier", "search", "investigate", "find"),
      e("♻️", "recycle", "refactor", "reuse"),
    ],
  },
  {
    id: "objects",
    label: "Objects",
    emoji: [
      e("☕", "coffee", "break", "morning"),
      e("🍕", "pizza", "food", "lunch"),
      e("🎂", "cake", "birthday", "celebrate"),
      e("🌱", "seedling", "growth", "new", "plant"),
      e("🌞", "sun", "morning", "day"),
      e("🌙", "moon", "night", "late"),
      e("🎧", "headphones", "huddle", "listen", "audio"),
      e("📣", "megaphone", "announce", "shout"),
      e("🧵", "thread", "sewing", "conversation"),
      e("🪄", "wand", "magic", "auto"),
    ],
  },
];

/**
 * What a pick actually sends.
 *
 * One string, always. A standard emoji is its glyph; a custom emoji has no
 * glyph and becomes `:shortcode:`, which the message renderer resolves against
 * the palette. Centralised because it drifted in the client this is ported
 * from — a picker that returned the raw object let custom emoji fall out of
 * whichever call sites forgot the special case.
 */
export function selectionToken(pick: StandardEmoji | CustomEmoji): string {
  return "native" in pick ? pick.native : `:${pick.shortcode}:`;
}

function matches(needle: string, keywords: string[]): boolean {
  return keywords.some((word) => word.includes(needle));
}

/** Filter the standard set. An empty query is every group, in order. */
export function searchEmoji(query: string): EmojiGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return EMOJI_GROUPS;
  return EMOJI_GROUPS.map((group) => ({
    ...group,
    emoji: group.emoji.filter((row) => matches(needle, row.keywords)),
  })).filter((group) => group.emoji.length > 0);
}

/** Filter a community's own emoji by shortcode. */
export function searchCustomEmoji(query: string, palette: CustomEmoji[]): CustomEmoji[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return palette;
  return palette.filter((row) => row.shortcode.toLowerCase().includes(needle));
}
