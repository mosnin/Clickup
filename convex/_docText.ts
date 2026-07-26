// Plain text out of a Tiptap/ProseMirror document.
//
// Shared because two runtimes need it and neither can import the other: ai.ts
// is a Node action (it pulls in the OpenAI SDK) and agentApi.ts is a default-
// runtime query. Pure, no ctx, no imports — safe from both.

/**
 * Walks a ProseMirror node tree and joins every text leaf. Deliberately
 * tolerant of the shape: `content` is stored as `v.any()`, so this has to cope
 * with whatever an older editor version wrote without throwing.
 */
export function tiptapToText(content: unknown): string {
  const parts: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
  walk(content);
  return parts.join(" ").trim();
}

/** Truncates with an ellipsis, for payloads that travel to an agent. */
export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
