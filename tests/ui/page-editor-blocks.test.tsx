import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { resetHarness } from "./harness";

// Toggles and callouts. Both are blocks CommonMark doesn't have, so the only
// thing worth testing first is whether they survive being saved: a block that
// can't round-trip is a block that deletes data, which is exactly how the
// Image item ate every image for months.

const { PageBodyEditor } = await import("@/components/dashboard/page-editor");

async function mount(markdown: string) {
  const onChange = vi.fn();
  const { container } = render(
    <PageBodyEditor
      markdown={markdown}
      mentionables={[]}
      pageTitles={[]}
      onChange={onChange}
    />,
  );
  await waitFor(() =>
    expect(container.querySelector(".page-editor-surface")).toBeTruthy(),
  );
  return { container, onChange };
}

async function roundTrip(container: HTMLElement, onChange: ReturnType<typeof vi.fn>) {
  container
    .querySelector(".page-editor-surface")!
    .dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  return onChange.mock.calls.at(-1)![0] as string;
}

beforeEach(() => {
  resetHarness();
  document.body.innerHTML = "";
});

describe("toggles", () => {
  const SOURCE = [
    "<details><summary>Why we moved off the legacy provider</summary>",
    "",
    "The contract renewed in March.",
    "",
    "</details>",
  ].join("\n");

  it("becomes a real details block, not escaped text", async () => {
    const { container } = await mount(SOURCE);
    await waitFor(() => expect(container.querySelector("details")).toBeTruthy());
    expect(container.querySelector("summary")?.textContent).toBe(
      "Why we moved off the legacy provider",
    );
    expect(container.textContent).toContain("The contract renewed in March.");
    // The escaped source must not still be sitting there as prose.
    expect(container.textContent).not.toContain("<details>");
  });

  it("saves back as the same details markdown", async () => {
    const { container, onChange } = await mount(SOURCE);
    await waitFor(() => expect(container.querySelector("details")).toBeTruthy());
    const out = await roundTrip(container, onChange);
    expect(out).toContain("<details><summary>Why we moved off the legacy provider</summary>");
    expect(out).toContain("The contract renewed in March.");
    expect(out).toContain("</details>");
  });

  it("leaves a lone line that merely looks like one alone", async () => {
    // No closing marker and nothing to hold — turning this into an empty
    // toggle would silently eat the line.
    const { container } = await mount("<details><summary>Dangling</summary>");
    await waitFor(() =>
      expect(container.querySelector(".page-editor-surface")).toBeTruthy(),
    );
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("callouts", () => {
  it("reads a GitHub alert as a callout of that kind", async () => {
    const { container } = await mount("> [!WARNING]\n> The migration runs Thursday.");
    await waitFor(() =>
      expect(container.querySelector("[data-callout]")).toBeTruthy(),
    );
    expect(
      container.querySelector("[data-callout]")?.getAttribute("data-callout"),
    ).toBe("warning");
    expect(container.textContent).toContain("The migration runs Thursday.");
    // It stopped being a blockquote, so it can't render as one too.
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("keeps words written on the marker line", async () => {
    const { container } = await mount("> [!NOTE] Heads up\n> and the rest.");
    await waitFor(() =>
      expect(container.querySelector("[data-callout]")).toBeTruthy(),
    );
    expect(container.textContent).toContain("Heads up");
    expect(container.textContent).toContain("and the rest.");
    expect(container.textContent).not.toContain("[!NOTE]");
  });

  it("saves back as a GitHub alert", async () => {
    const { container, onChange } = await mount(
      "> [!TIP]\n> Restart the worker first.",
    );
    await waitFor(() =>
      expect(container.querySelector("[data-callout]")).toBeTruthy(),
    );
    const out = await roundTrip(container, onChange);
    expect(out).toContain("[!TIP]");
    expect(out).toContain("Restart the worker first.");
    // Quoted, so a plain-markdown reader still sees an aside.
    expect(out).toMatch(/^>/m);
  });

  it("leaves an ordinary blockquote as a blockquote", async () => {
    const { container } = await mount("> just a quote");
    await waitFor(() =>
      expect(container.querySelector("blockquote")).toBeTruthy(),
    );
    expect(container.querySelector("[data-callout]")).toBeNull();
  });

  it("ignores a made-up alert kind", async () => {
    const { container } = await mount("> [!BANANA]\n> not a callout kind");
    await waitFor(() =>
      expect(container.querySelector("blockquote")).toBeTruthy(),
    );
    expect(container.querySelector("[data-callout]")).toBeNull();
  });
});
