import MarkdownIt from "markdown-it";

// Markdown rendering for Pages.
//
// `html: false` is the security posture: page markdown is written by both
// people and agents, and an agent that has been fed a malicious document
// must not be able to inject script into a teammate's browser. markdown-it
// escapes raw HTML when this is off, so there is no sanitizer to keep in
// sync — the parser simply never emits markup the author didn't ask for.

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});

// Every link opens in a new tab with the opener severed. A page is a
// reference document; following a link should not lose the reader's place,
// and rel prevents the destination reaching back through window.opener.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  // Internal links stay in-app; only outbound ones get the new-tab treatment.
  if (!href.startsWith("/")) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export type PageTitleIndex = { pageId: string; title: string }[];

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Turns [[Title]] into a real link before markdown runs.
 *
 * Resolved targets become ordinary internal links so they inherit link
 * styling, keyboard behaviour and the renderer's escaping. An unresolved
 * target is NOT dropped — it renders as a visibly "not created yet" span,
 * which is the whole point of a wiki link: you write the name first and make
 * the page later.
 */
export function renderMarkdown(
  markdown: string,
  titles: PageTitleIndex = [],
): string {
  const byTitle = new Map(titles.map((t) => [t.title.toLowerCase(), t.pageId]));
  const withLinks = markdown.replace(WIKILINK, (_match, rawTarget: string) => {
    const target = String(rawTarget).trim();
    const id = byTitle.get(target.toLowerCase());
    // Escape the label: it is author-controlled text being spliced into
    // markdown, and a `]` or `(` in a title would otherwise break out of the
    // link syntax we are generating.
    const label = target.replace(/[[\]()]/g, "");
    if (id) return `[${label}](/dashboard/pages/${id})`;
    return `<<UNRESOLVED:${label}>>`;
  });

  const html = md.render(withLinks);
  // Re-inject unresolved links after rendering so markdown-it escapes
  // everything around them and we control exactly this one span.
  return html.replace(
    /&lt;&lt;UNRESOLVED:(.*?)&gt;&gt;/g,
    (_m, label: string) =>
      `<span class="page-link-missing" title="No page with this title yet">${escapeHtmlText(label)}</span>`,
  );
}

/** Inline render for one-line previews (no block wrapper). */
export function renderMarkdownInline(markdown: string): string {
  return md.renderInline(markdown);
}
