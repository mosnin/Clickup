// Mention tokens are stored inline in the body as `@[Name](clerkId)`.
// This mirrors markdown link syntax so a plain reader still understands it.
// We render them as pills via parseMentionBody().

const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; clerkId: string };

export function parseMentionBody(body: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) {
      parts.push({ kind: "text", text: body.slice(lastIndex, match.index) });
    }
    parts.push({
      kind: "mention",
      name: match[1],
      clerkId: match[2],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    parts.push({ kind: "text", text: body.slice(lastIndex) });
  }
  return parts;
}

export function extractMentionedClerkIds(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) ids.add(m[2]);
  return Array.from(ids);
}

export function formatMentionToken(name: string, clerkId: string): string {
  return `@[${name}](${clerkId})`;
}
