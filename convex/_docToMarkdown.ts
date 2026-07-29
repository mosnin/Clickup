// Tiptap JSON → markdown, for folding `docs` into `pages`.
//
// The doc editor was configured with `extensions: [StarterKit]` and nothing
// else, so every node type that can appear in a stored doc has a markdown
// spelling. That makes this conversion lossless in principle — but "in
// principle" is not good enough to run over someone's writing, so the
// converter *reports* what it saw: any node type it didn't recognise comes
// back in `unknownNodes`, and the migration keeps the original JSON on the
// page either way. Nothing is destroyed on a guess.
//
// Pure — no ctx, no imports — so it is testable without a backend.

export type DocNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
};

export type ConversionResult = {
  markdown: string;
  /** Node types the converter had no rule for, deduplicated. */
  unknownNodes: string[];
  /** True when every node was understood. */
  lossless: boolean;
};

/** Marks, innermost-last, so `**_x_**` nests the way markdown expects. */
const MARK_WRAPPERS: Record<string, string> = {
  bold: "**",
  strong: "**",
  italic: "*",
  em: "*",
  strike: "~~",
  code: "`",
};

function applyMarks(text: string, node: DocNode, unknown: Set<string>): string {
  if (!node.marks || node.marks.length === 0) return text;
  let out = text;
  // `code` must be applied first (innermost): markdown inside a code span is
  // literal, so `**` outside a backtick pair is the only order that reads.
  const ordered = [...node.marks].sort((a, b) =>
    a.type === "code" ? -1 : b.type === "code" ? 1 : 0,
  );
  for (const mark of ordered) {
    const type = mark.type ?? "";
    if (type === "link") {
      const href = String(mark.attrs?.href ?? "");
      // A link with no href is emphasis at best; keep the words.
      out = href ? `[${out}](${href})` : out;
      continue;
    }
    const wrapper = MARK_WRAPPERS[type];
    if (!wrapper) {
      unknown.add(`mark:${type}`);
      continue;
    }
    out = `${wrapper}${out}${wrapper}`;
  }
  return out;
}

function inline(nodes: DocNode[] | undefined, unknown: Set<string>): string {
  if (!nodes) return "";
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += applyMarks(node.text ?? "", node, unknown);
    } else if (node.type === "hardBreak") {
      // Two trailing spaces is markdown's line break; a bare newline inside a
      // paragraph would be re-flowed away.
      out += "  \n";
    } else if (node.type === "image") {
      const src = String(node.attrs?.src ?? "");
      const alt = String(node.attrs?.alt ?? "");
      out += `![${alt}](${src})`;
    } else {
      // Something inline we don't know: keep whatever text it holds rather
      // than dropping the words, and say so in the report.
      unknown.add(node.type ?? "unknown");
      out += inline(node.content, unknown) || (node.text ?? "");
    }
  }
  return out;
}

function indent(text: string, prefix: string, firstPrefix?: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      const p = i === 0 ? (firstPrefix ?? prefix) : prefix;
      return line.length > 0 ? `${p}${line}` : p.trimEnd();
    })
    .join("\n");
}

function blocks(nodes: DocNode[] | undefined, unknown: Set<string>): string[] {
  if (!nodes) return [];
  const out: string[] = [];
  for (const node of nodes) {
    const block = renderBlock(node, unknown);
    if (block !== null) out.push(block);
  }
  return out;
}

function renderBlock(node: DocNode, unknown: Set<string>): string | null {
  switch (node.type) {
    case "paragraph":
      return inline(node.content, unknown);

    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${"#".repeat(level)} ${inline(node.content, unknown)}`;
    }

    case "bulletList":
      return (node.content ?? [])
        .map((item) =>
          indent(blocks(item.content, unknown).join("\n\n"), "  ", "- "),
        )
        .join("\n");

    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((item, i) =>
          indent(
            blocks(item.content, unknown).join("\n\n"),
            "   ",
            `${start + i}. `,
          ),
        )
        .join("\n");
    }

    case "taskList":
      return (node.content ?? [])
        .map((item) =>
          indent(
            blocks(item.content, unknown).join("\n\n"),
            "  ",
            item.attrs?.checked ? "- [x] " : "- [ ] ",
          ),
        )
        .join("\n");

    case "listItem":
      // Reached only when a list item turns up outside a list; render its
      // contents rather than losing them.
      return blocks(node.content, unknown).join("\n\n");

    case "blockquote":
      return indent(blocks(node.content, unknown).join("\n\n"), "> ");

    case "codeBlock": {
      const language = String(node.attrs?.language ?? "");
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    case "horizontalRule":
      return "---";

    case "image": {
      const src = String(node.attrs?.src ?? "");
      const alt = String(node.attrs?.alt ?? "");
      return `![${alt}](${src})`;
    }

    case "hardBreak":
      return "";

    default:
      unknown.add(node.type ?? "unknown");
      // Keep the words. A block we don't recognise becomes a paragraph of
      // whatever text it contained, which is recoverable; dropping it isn't.
      return inline(node.content, unknown) || (node.text ?? "") || null;
  }
}

/**
 * Convert a stored doc's `content` into markdown.
 *
 * Accepts anything, including null and shapes that were never valid Tiptap —
 * a converter that throws on one malformed row is a migration that stops
 * halfway.
 */
export function docToMarkdown(content: unknown): ConversionResult {
  const unknown = new Set<string>();
  if (!content || typeof content !== "object") {
    return { markdown: "", unknownNodes: [], lossless: true };
  }

  // A bare array of nodes is a shape old content can plausibly be in; it is
  // not an unrecognised node type, so it must not be reported as one.
  const root = Array.isArray(content)
    ? ({ type: "doc", content: content as DocNode[] } as DocNode)
    : (content as DocNode);

  // Neither a type nor children: an empty document, not a mystery.
  if (!root.type && !root.content) {
    return { markdown: "", unknownNodes: [], lossless: true };
  }

  const body =
    root.type === "doc" || root.content
      ? blocks(root.content, unknown).join("\n\n")
      : (renderBlock(root, unknown) ?? "");

  return {
    markdown: body.replace(/\n{3,}/g, "\n\n").trim(),
    unknownNodes: [...unknown].sort(),
    lossless: unknown.size === 0,
  };
}
