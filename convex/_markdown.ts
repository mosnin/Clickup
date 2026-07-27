// Markdown helpers shared by the page mutations, the agent API, and the
// search indexer. Pure — no ctx, no imports — so every runtime can use them.

/** A [[wikilink]] occurrence, with the raw target text between the brackets. */
export type WikiLink = { target: string; start: number; end: number };

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

/**
 * Every [[wikilink]] in a page's markdown, in order.
 *
 * Deliberately conservative: no newlines inside a link, no nesting. A stray
 * `[[` in a code fence is the cost of not shipping a full markdown parser
 * here, and the failure mode is a link that resolves to nothing — which the
 * UI already renders as "not created yet".
 */
export function extractWikiLinks(markdown: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of markdown.matchAll(WIKILINK)) {
    const target = m[1].trim();
    if (!target) continue;
    out.push({
      target,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/** Distinct link targets, lowercased for case-insensitive title matching. */
export function linkTargets(markdown: string): string[] {
  const seen = new Set<string>();
  for (const link of extractWikiLinks(markdown)) {
    seen.add(link.target.toLowerCase());
  }
  return [...seen];
}

/**
 * Markdown reduced to plain prose, for embeddings and previews.
 *
 * Strips fences, headings, emphasis, list bullets and link syntax while
 * keeping the words. Not a parser — a deliberately small pass whose only job
 * is to stop `###` and `**` from being embedded as if they were content.
 */
export function markdownToText(markdown: string): string {
  return markdown
    // fenced code blocks: keep the code out of the prose entirely
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    // images before links, so the alt text doesn't survive as a bare word
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, " "))
    .replace(/^\s*[-:| ]+\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First meaningful line, for list rows and search results. */
export function markdownExcerpt(markdown: string, max = 180): string {
  const text = markdownToText(markdown);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A title inferred from the content when the author never set one.
 *
 * Agents write a `# Heading` far more reliably than they fill in a separate
 * title field, so an untitled page with a heading should not read as
 * "Untitled" in the index.
 */
export function inferTitle(markdown: string, fallback = "Untitled"): string {
  const heading = markdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 200);
  const firstLine = markdownToText(markdown).split(". ")[0]?.trim();
  if (firstLine) return firstLine.slice(0, 80);
  return fallback;
}
