import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { resetHarness, toastCalls } from "./harness";

// The canvas pane.
//
// Two claims are worth a browser to check, and neither can be checked in a
// Convex test.
//
//   **The editor is the Pages editor.** A canvas is one markdown document and
//   this product already has a markdown-backed rich editor; the pane
//   configures it rather than growing a second one. So what is asserted here is
//   the thing that goes wrong when somebody forks it: markdown goes in as
//   *structure*, and what comes back out on save is still markdown an agent can
//   read. A block that cannot round-trip is a block that deletes data.
//
//   **Last-write-wins is not silent.** The backend keeps Buzz's clobbering
//   because the log is append-only and no version is destroyed — which is only
//   an acceptable trade if this screen says what a save landed on and offers
//   the other version back. Both halves are tested: the note that appears
//   *while* you are editing when the head moves, and the banner after a save
//   that replaced something the writer had not read.
//
// The harness's `convex/react` mock answers every query the same way and every
// mutation with `undefined`, which cannot express either of those. So this file
// installs its own, keyed by function name — the same shape
// `chat-composer.test.tsx` uses and for the same reason.

const queries: Record<string, unknown> = {};
const writes: { name: string; args: Record<string, unknown> }[] = [];
type WriteResult = {
  status: "written" | "unchanged";
  eventId: string;
  replaced: {
    eventId: string;
    updatedAt: number;
    author: { pubkey: string; name: string; isAgent: boolean } | null;
  } | null;
  unseen: boolean;
};
let writeAnswer: () => Promise<WriteResult> = async () => ({
  status: "written",
  eventId: "evt_new",
  replaced: null,
  unseen: false,
});

vi.doMock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    return queries[getFunctionName(ref as never)];
  },
  useMutation: (ref: unknown) => async (args: Record<string, unknown>) => {
    writes.push({ name: getFunctionName(ref as never), args });
    return writeAnswer();
  },
  useAction: () => async () => undefined,
}));

const { CanvasPane } = await import("@/components/chat/canvas");

const SCOPE = { scopeType: "workspace" as const, scopeId: "ws_1" };

const DOCUMENT = [
  "# Runbook",
  "",
  "## Restart",
  "",
  "Run **the worker** with `--drain`.",
  "",
  "- check the queue",
  "- page @[Ada Lovelace](user_alice)",
  "",
  "| step | who |",
  "| --- | --- |",
  "| 1 | ops |",
  "",
  "- [ ] not done",
].join("\n");

function head(over: Record<string, unknown> = {}) {
  return {
    content: DOCUMENT,
    eventId: "evt_1",
    updatedAt: Date.now() - 60_000,
    author: { pubkey: "pk_bob", name: "Bob", isAgent: false },
    canEdit: true,
    ...over,
  };
}

function mount() {
  return render(<CanvasPane scope={SCOPE} channelId="ch_a" />);
}

/** Make the editor emit its own serialization, the way a keystroke does. */
function typeInto(container: HTMLElement) {
  const surface = container.querySelector(".page-editor-surface")!;
  fireEvent.keyDown(surface, { key: "a" });
  fireEvent.input(surface);
}

beforeEach(() => {
  resetHarness();
  for (const key of Object.keys(queries)) delete queries[key];
  writes.length = 0;
  writeAnswer = async () => ({
    status: "written",
    eventId: "evt_new",
    replaced: null,
    unseen: false,
  });
});

describe("reading", () => {
  it("renders the canvas as structure, not as literal markdown", async () => {
    queries["buzz/canvas:read"] = head();
    const { container } = mount();

    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Runbook");
    });
    expect(container.querySelector("h2")?.textContent).toBe("Restart");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("the worker");
    // The mention token is a node, not four literal characters of syntax.
    expect(container.textContent).not.toContain("@[Ada Lovelace]");
    expect(container.textContent).not.toContain("**");
    // Whose it is and when — a canvas with no attribution is a document
    // nobody is answerable for.
    expect(container.textContent).toContain("Edited by Bob");
  });

  it("offers Create when there is none, and nothing when you cannot edit", async () => {
    queries["buzz/canvas:read"] = head({ content: null, eventId: null, author: null });
    const first = mount();
    await waitFor(() => {
      expect(first.getByRole("button", { name: "Create canvas" })).toBeTruthy();
    });
    expect(first.container.textContent).toContain("No canvas set for this channel.");
    first.unmount();

    queries["buzz/canvas:read"] = head({ canEdit: false });
    const second = mount();
    await waitFor(() => expect(second.container.querySelector("h1")).toBeTruthy());
    expect(second.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("writing", () => {
  it("saves markdown, not HTML, and says which version it started from", async () => {
    queries["buzz/canvas:read"] = head();
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("h1")).toBeTruthy());

    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    typeInto(view.container);
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    const args = writes[0].args as { content: string; basedOn?: string };
    expect(writes[0].name).toBe("buzz/canvas:write");
    // The version the edit started from travels with it. It changes what the
    // server *tells* the caller, never whether the write lands — which is what
    // lets an agent with no editor open write the same canvas.
    expect(args.basedOn).toBe("evt_1");

    // Round-trip: every construct in the document is still markdown coming
    // back out. This is the assertion that fails the day somebody swaps in a
    // second editor or an HTML storage model.
    expect(args.content).toContain("# Runbook");
    expect(args.content).toContain("## Restart");
    expect(args.content).toContain("**the worker**");
    expect(args.content).toContain("`--drain`");
    expect(args.content).toContain("- check the queue");
    expect(args.content).toContain("@[Ada Lovelace](user_alice)");
    expect(args.content).toContain("| step | who |");
    expect(args.content).toContain("- [ ] not done");
    expect(args.content).not.toContain("<h1");
    expect(args.content).not.toContain("<table");

    await waitFor(() =>
      expect(toastCalls.map((t) => t.message)).toContain("Canvas saved"),
    );
  });

  it("says so rather than logging a version when nothing changed", async () => {
    queries["buzz/canvas:read"] = head();
    writeAnswer = async () => ({
      status: "unchanged",
      eventId: "evt_1",
      replaced: null,
      unseen: false,
    });
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("h1")).toBeTruthy());

    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastCalls.map((t) => t.message)).toContain(
        "Nothing changed, so nothing was saved.",
      ),
    );
  });

  it("surfaces the server's refusal instead of pretending it saved", async () => {
    queries["buzz/canvas:read"] = head();
    writeAnswer = async () => {
      throw new Error("This room is archived, so its canvas is read-only.");
    };
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("h1")).toBeTruthy());

    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    typeInto(view.container);
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const refusal = toastCalls.find((t) => t.opts?.kind === "error");
      expect(refusal?.message).toContain("archived");
    });
  });
});

describe("last-write-wins is visible", () => {
  it("warns while you are editing that the head moved under you", async () => {
    queries["buzz/canvas:read"] = head();
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("h1")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Edit" }));

    // Somebody else saved. The live subscription is how this arrives, and the
    // point of saying it *now* is that nothing has been lost yet — the choice
    // is still cheap.
    queries["buzz/canvas:read"] = head({
      eventId: "evt_2",
      content: "# Theirs",
      author: { pubkey: "pk_ada", name: "Ada", isAgent: false },
    });
    view.rerender(<CanvasPane scope={SCOPE} channelId="ch_a" />);

    await waitFor(() => {
      expect(view.container.textContent).toContain(
        "Ada changed this canvas while you were editing",
      );
    });
    // Taking theirs clears the note by moving the base forward.
    fireEvent.click(view.getByRole("button", { name: "Take theirs" }));
    await waitFor(() => {
      expect(view.container.textContent).not.toContain("while you were editing");
    });
  });

  it("names whose edit a save replaced, and offers it back", async () => {
    queries["buzz/canvas:read"] = head();
    queries["buzz/canvas:readVersion"] = { content: "# Bob's version\n" };
    writeAnswer = async () => ({
      status: "written",
      eventId: "evt_mine",
      replaced: {
        eventId: "evt_theirs",
        updatedAt: Date.now() - 120_000,
        author: { pubkey: "pk_bob", name: "Bob", isAgent: false },
      },
      unseen: true,
    });

    const view = mount();
    await waitFor(() => expect(view.container.querySelector("h1")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    typeInto(view.container);
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(view.container.textContent).toContain(
        "Your version replaced Bob's edit",
      );
    });
    // The honest half of the sentence: the log is append-only, so the version
    // that "lost" is still there.
    expect(view.container.textContent).toContain("Nothing was lost");

    writeAnswer = async () => ({
      status: "written",
      eventId: "evt_restored",
      replaced: null,
      unseen: false,
    });
    fireEvent.click(view.getByRole("button", { name: "Restore theirs" }));

    await waitFor(() => expect(writes).toHaveLength(2));
    // Restoring is an ordinary save of the old content — no second verb, so it
    // is itself undoable by restoring again.
    expect((writes[1].args as { content: string }).content).toBe(
      "# Bob's version\n",
    );
    await waitFor(() =>
      expect(toastCalls.map((t) => t.message)).toContain(
        "Restored Bob's version",
      ),
    );
  });

  it("keeps mine without writing anything", async () => {
    queries["buzz/canvas:read"] = head();
    queries["buzz/canvas:readVersion"] = { content: "# Theirs\n" };
    writeAnswer = async () => ({
      status: "written",
      eventId: "evt_mine",
      replaced: {
        eventId: "evt_theirs",
        updatedAt: Date.now(),
        author: { pubkey: "pk_bob", name: "Bob", isAgent: false },
      },
      unseen: true,
    });

    const view = mount();
    await waitFor(() => expect(view.container.querySelector("h1")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
    typeInto(view.container);
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(view.container.textContent).toContain("Your version replaced"),
    );
    fireEvent.click(view.getByRole("button", { name: "Keep mine" }));
    await waitFor(() =>
      expect(view.container.textContent).not.toContain("Your version replaced"),
    );
    expect(writes).toHaveLength(1);
  });
});
