import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

// The Pages reading view renders text written by both people and agents. An
// agent that has been fed a malicious document must not be able to put script
// into a teammate's browser, so the escaping behaviour is pinned here rather
// than assumed from the parser's defaults.

describe("renderMarkdown", () => {
  it("escapes raw HTML instead of emitting it", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\nhello");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("hello");
  });

  it("escapes inline HTML so an event handler never becomes an attribute", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    // The payload survives as visible text — what matters is that no live
    // tag is produced, so there is no element for onerror to attach to.
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<img[\s>]/);
  });

  it("renders ordinary markdown structure", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n`code`");
    expect(html).toContain("<h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>");
  });

  it("severs the opener on external links but leaves internal ones alone", () => {
    const external = renderMarkdown("[out](https://example.test)");
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');

    const internal = renderMarkdown("[in](/dashboard/pages/abc)");
    expect(internal).not.toContain('target="_blank"');
  });

  it("turns a resolvable wikilink into an in-app link", () => {
    const html = renderMarkdown("see [[Payment notes]]", [
      { pageId: "p1", title: "Payment notes" },
    ]);
    expect(html).toContain('href="/dashboard/pages/p1"');
    expect(html).toContain("Payment notes");
  });

  it("matches wikilink titles case-insensitively", () => {
    const html = renderMarkdown("see [[payment NOTES]]", [
      { pageId: "p1", title: "Payment notes" },
    ]);
    expect(html).toContain('href="/dashboard/pages/p1"');
  });

  it("marks an unresolved wikilink instead of dropping or linking it", () => {
    const html = renderMarkdown("see [[Not written yet]]", []);
    expect(html).toContain("page-link-missing");
    expect(html).toContain("Not written yet");
    expect(html).not.toContain("href=");
  });

  it("does not let a page title break out of the generated link", () => {
    // A title containing link syntax must not be able to inject markup or
    // escape the anchor we are building around it. The text may still be
    // visible; the claim is that no anchor with that scheme is emitted.
    const html = renderMarkdown("[[evil](javascript:alert(1))]]", []);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toContain("<script");
  });

  it("refuses a javascript: URL in an ordinary markdown link", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/i);
  });
});
