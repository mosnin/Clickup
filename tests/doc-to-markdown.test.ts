import { describe, expect, it } from "vitest";
import { docToMarkdown } from "../convex/_docToMarkdown";

// The converter that folds `docs` into `pages`. It runs over people's actual
// writing exactly once, so the bar is higher than "mostly works":
//
//  1. Every StarterKit node type the doc editor could produce must convert —
//     that set is closed, because the editor was `extensions: [StarterKit]`.
//  2. It must never throw. A converter that dies on one malformed row is a
//     migration that stops halfway through a workspace.
//  3. It must report what it didn't understand, per doc, so "lossless" is a
//     measurement and not a hope.

const doc = (...content: unknown[]) => ({ type: "doc", content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: unknown[]) => ({ type: "text", text, marks });

describe("blocks", () => {
  it("converts headings at every level", () => {
    const out = docToMarkdown(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [t("One")] },
        { type: "heading", attrs: { level: 3 }, content: [t("Three")] },
      ),
    );
    expect(out.markdown).toBe("# One\n\n### Three");
    expect(out.lossless).toBe(true);
  });

  it("clamps a heading level markdown can't express", () => {
    const out = docToMarkdown(
      doc({ type: "heading", attrs: { level: 9 }, content: [t("Deep")] }),
    );
    expect(out.markdown).toBe("###### Deep");
  });

  it("converts bulleted and numbered lists", () => {
    const item = (text: string) => ({
      type: "listItem",
      content: [p(t(text))],
    });
    const out = docToMarkdown(
      doc(
        { type: "bulletList", content: [item("first"), item("second")] },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [item("one"), item("two")],
        },
      ),
    );
    expect(out.markdown).toBe("- first\n- second\n\n1. one\n2. two");
  });

  it("respects an ordered list that doesn't start at one", () => {
    const out = docToMarkdown(
      doc({
        type: "orderedList",
        attrs: { start: 4 },
        content: [
          { type: "listItem", content: [p(t("four"))] },
          { type: "listItem", content: [p(t("five"))] },
        ],
      }),
    );
    expect(out.markdown).toBe("4. four\n5. five");
  });

  it("quotes a blockquote on every line", () => {
    const out = docToMarkdown(
      doc({
        type: "blockquote",
        content: [p(t("first line")), p(t("second line"))],
      }),
    );
    // Both paragraphs quoted, and the blank line between them too, or the
    // second paragraph escapes the quote.
    expect(out.markdown).toBe("> first line\n>\n> second line");
  });

  it("fences a code block and keeps its language", () => {
    const out = docToMarkdown(
      doc({
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const x = 1;" }],
      }),
    );
    expect(out.markdown).toBe("```ts\nconst x = 1;\n```");
  });

  it("converts a horizontal rule", () => {
    expect(docToMarkdown(doc({ type: "horizontalRule" })).markdown).toBe("---");
  });
});

describe("marks", () => {
  it("converts bold, italic, strike and code", () => {
    const out = docToMarkdown(
      doc(
        p(
          t("plain "),
          t("bold", [{ type: "bold" }]),
          t(" "),
          t("italic", [{ type: "italic" }]),
          t(" "),
          t("struck", [{ type: "strike" }]),
          t(" "),
          t("code", [{ type: "code" }]),
        ),
      ),
    );
    expect(out.markdown).toBe("plain **bold** *italic* ~~struck~~ `code`");
    expect(out.lossless).toBe(true);
  });

  it("puts code innermost so the emphasis still reads", () => {
    const out = docToMarkdown(
      doc(p(t("x", [{ type: "bold" }, { type: "code" }]))),
    );
    // `**`x`**`, not `` `**x**` `` — markdown inside a code span is literal.
    expect(out.markdown).toBe("**`x`**");
  });

  it("converts a link and keeps the words when the href is missing", () => {
    expect(
      docToMarkdown(
        doc(p(t("the RFC", [{ type: "link", attrs: { href: "https://x.test" } }]))),
      ).markdown,
    ).toBe("[the RFC](https://x.test)");
    expect(
      docToMarkdown(doc(p(t("bare", [{ type: "link" }])))).markdown,
    ).toBe("bare");
  });

  it("turns a hard break into a markdown line break", () => {
    const out = docToMarkdown(
      doc(p(t("first"), { type: "hardBreak" }, t("second"))),
    );
    expect(out.markdown).toBe("first  \nsecond");
  });
});

describe("robustness", () => {
  it("survives null, undefined and a non-object", () => {
    for (const input of [null, undefined, 42, "text", []]) {
      const out = docToMarkdown(input);
      expect(out.markdown).toBe("");
      expect(out.lossless).toBe(true);
    }
  });

  it("survives a doc with no content", () => {
    expect(docToMarkdown({ type: "doc" }).markdown).toBe("");
  });

  it("keeps the words from a node type it doesn't know, and says so", () => {
    const out = docToMarkdown(
      doc(
        p(t("before")),
        { type: "mysteryBlock", content: [p(t("do not lose me"))] },
        p(t("after")),
      ),
    );
    // The words survive — dropping them is unrecoverable, reporting is not.
    expect(out.markdown).toContain("do not lose me");
    expect(out.unknownNodes).toContain("mysteryBlock");
    expect(out.lossless).toBe(false);
  });

  it("reports an unknown mark without losing the text", () => {
    const out = docToMarkdown(
      doc(p(t("highlighted", [{ type: "highlight" }]))),
    );
    expect(out.markdown).toBe("highlighted");
    expect(out.unknownNodes).toContain("mark:highlight");
    expect(out.lossless).toBe(false);
  });

  it("collapses runs of blank lines", () => {
    const out = docToMarkdown(doc(p(), p(), p(t("words")), p(), p()));
    expect(out.markdown).toBe("words");
  });
});

describe("a whole document", () => {
  it("round-trips the shape a real doc has", () => {
    const out = docToMarkdown(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [t("Billing migration")] },
        p(
          t("We are moving off "),
          t("Legacy Co", [{ type: "bold" }]),
          t(". See "),
          t("the RFC", [{ type: "link", attrs: { href: "https://x.test" } }]),
          t("."),
        ),
        { type: "heading", attrs: { level: 2 }, content: [t("Steps")] },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            { type: "listItem", content: [p(t("Freeze writes"))] },
            { type: "listItem", content: [p(t("Backfill"))] },
          ],
        },
        {
          type: "blockquote",
          content: [p(t("Do not run this on a Friday."))],
        },
        {
          type: "codeBlock",
          attrs: { language: "sh" },
          content: [{ type: "text", text: "npm run migrate" }],
        },
      ),
    );

    expect(out.lossless).toBe(true);
    expect(out.markdown).toBe(
      [
        "# Billing migration",
        "",
        "We are moving off **Legacy Co**. See [the RFC](https://x.test).",
        "",
        "## Steps",
        "",
        "1. Freeze writes",
        "2. Backfill",
        "",
        "> Do not run this on a Friday.",
        "",
        "```sh",
        "npm run migrate",
        "```",
      ].join("\n"),
    );
  });
});
