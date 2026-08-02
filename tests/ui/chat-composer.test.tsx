import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { extractMentionedClerkIds } from "@/lib/mentions";
import { toastCalls, resetHarness } from "./harness";

// The composer is the one surface in Chat that holds text nobody else has a
// copy of. Everything asserted here is about that text surviving something:
// a room switch, a send, a refused send, and the trip from a pill in the box to
// a token in the body.
//
// No jest-dom matchers — assertions read attributes and text directly, the way
// `mode-switcher.test.tsx` does.

// The harness mocks `convex/react` with a mutation that always succeeds, and
// "a failed send does not lose what you typed" is the single most important
// claim in this file. `doMock` runs after the harness's registration and takes
// effect for the dynamic import below, which is the only way to get a mutation
// that can be made to reject.
const posted: unknown[] = [];
let answer: () => Promise<unknown> = async () => ({ id: "evt_real" });

vi.doMock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => async (args: unknown) => {
    posted.push(args);
    return answer();
  },
  useAction: () => async () => undefined,
}));

const { MessageComposer, postMessage } = await import("@/components/chat/composer");
const { resetDraftStoreForTests, configureDraftStore, peekDraft } = await import(
  "@/components/chat/composer/draft-store"
);
type Handle = import("@/components/chat/composer").ComposerEditorHandle;

const SCOPE = { scopeType: "workspace" as const, scopeId: "ws_1" };
const AUTHOR = { pubkey: "u_me", name: "Ada Lovelace" };
const MENTIONABLES = [
  { id: "u_ada", name: "Ada Lovelace", kind: "user" as const },
  { id: "ag_scout", name: "Scout", kind: "agent" as const },
];

type Sent = {
  optimistic: { renderKey: string; body: string; pending: boolean }[];
  acked: [string, string][];
  failed: [string, string][];
};

function mount(props: Record<string, unknown> = {}) {
  const handle: { current: Handle | null } = { current: null };
  const seen: Sent = { optimistic: [], acked: [], failed: [] };
  const view = render(
    <MessageComposer
      scope={SCOPE}
      channelId="ch_a"
      channelLabel="#general"
      author={AUTHOR}
      mentionables={MENTIONABLES}
      onEditorReady={(h) => {
        handle.current = h;
      }}
      onOptimistic={(m) =>
        seen.optimistic.push({ renderKey: m.renderKey, body: m.body, pending: m.pending })
      }
      onAcknowledged={(local, id) => seen.acked.push([local, id])}
      onFailed={(local, reason) => seen.failed.push([local, reason])}
      {...props}
    />,
  );
  return { ...view, handle, seen };
}

/** The contenteditable Tiptap draws into. */
function surface(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="textbox"]') as HTMLElement;
}

async function type(handle: { current: Handle | null }, text: string) {
  await waitFor(() => expect(handle.current).toBeTruthy());
  await act(async () => {
    handle.current!.insertText(text);
  });
}

function menuText(): string {
  return Array.from(document.querySelectorAll("[data-suggestion-menu]"))
    .map((node) => node.textContent ?? "")
    .join("\n");
}

beforeEach(() => {
  resetHarness();
  // Order matters, and not for a subtle reason: the draft store flushes to
  // localStorage on unmount, and `cleanup()` unmounts in an afterEach. Clearing
  // storage after the test therefore runs *before* the flush and one test's
  // draft is restored into the next one's composer.
  resetDraftStoreForTests();
  localStorage.clear();
  configureDraftStore(SCOPE, "u_me");
  posted.length = 0;
  answer = async () => ({ id: "evt_real" });
  // Menus mount into document.body and unmount a tick later, so a menu from
  // the previous test can otherwise satisfy this one's assertion.
  document.body.innerHTML = "";
});

describe("drafts", () => {
  it("keeps what you typed when you walk to another room and back", async () => {
    // The whole reason drafts exist. Switching rooms is a prop change here,
    // exactly as it is in the shell — the composer is not remounted, so the
    // draft has to be flushed and restored deliberately rather than by luck.
    const { container, handle, rerender } = mount();
    await type(handle, "half a thought");
    expect(surface(container).textContent).toContain("half a thought");

    await act(async () => {
      rerender(
        <MessageComposer
          scope={SCOPE}
          channelId="ch_b"
          channelLabel="#other"
          author={AUTHOR}
          mentionables={MENTIONABLES}
        />,
      );
    });
    expect(surface(container).textContent).not.toContain("half a thought");

    await act(async () => {
      rerender(
        <MessageComposer
          scope={SCOPE}
          channelId="ch_a"
          channelLabel="#general"
          author={AUTHOR}
          mentionables={MENTIONABLES}
        />,
      );
    });
    expect(surface(container).textContent).toContain("half a thought");
  });

  it("files a thread reply under the thread, not under the room", async () => {
    // Two half-written replies in one channel must not overwrite each other.
    const { handle } = mount({ rootId: "evt_9", parentId: "evt_9" });
    await type(handle, "replying in the thread");
    await waitFor(() => expect(peekDraft("thread:evt_9")?.content).toContain("replying"));
    expect(peekDraft("ch_a")).toBeUndefined();
  });

  it("stores the channel on the draft rather than leaving it to the key", async () => {
    const { handle } = mount({ rootId: "evt_9", parentId: "evt_9" });
    await type(handle, "x");
    await waitFor(() => expect(peekDraft("thread:evt_9")).toBeTruthy());
    expect(peekDraft("thread:evt_9")?.channelId).toBe("ch_a");
  });

  it("clears the draft once the message is sent", async () => {
    const { container, handle } = mount();
    await type(handle, "shipping it");
    await waitFor(() => expect(peekDraft("ch_a")?.content).toContain("shipping"));

    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(peekDraft("ch_a")).toBeUndefined();
    expect(surface(container).textContent).not.toContain("shipping it");
  });
});

describe("sending", () => {
  it("posts to buzz/messages:post with the room and the body", async () => {
    // The reference is built by hand (the generated api stub predates
    // convex/buzz), so what it points at is worth asserting rather than
    // discovering at runtime.
    expect(getFunctionName(postMessage)).toBe("buzz/messages:post");

    const { container, handle } = mount();
    await type(handle, "hello room");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      scopeType: "workspace",
      scopeId: "ws_1",
      channelId: "ch_a",
      body: "hello room",
    });
  });

  it("carries the thread target when it is a reply", async () => {
    const { container, handle } = mount({ parentId: "evt_1", rootId: "evt_1" });
    await type(handle, "a reply");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ parentId: "evt_1", rootId: "evt_1" });
  });

  it("draws the row immediately under a key the acknowledgement inherits", async () => {
    // The reason `renderKey` exists: a row keyed on the event id remounts the
    // moment the id arrives, and the message visibly blinks right after the
    // person pressed Enter.
    const { container, handle, seen } = mount();
    await type(handle, "optimistic");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(seen.acked).toHaveLength(1));

    expect(seen.optimistic).toHaveLength(1);
    expect(seen.optimistic[0].pending).toBe(true);
    expect(seen.optimistic[0].renderKey.startsWith("optimistic-")).toBe(true);
    // Same local key on both sides of the transition — that is the contract.
    expect(seen.acked[0][0]).toBe(seen.optimistic[0].renderKey);
    expect(seen.acked[0][1]).toBe("evt_real");
  });

  it("still acknowledges when the mutation answers with nothing", async () => {
    answer = async () => undefined;
    const { container, handle, seen } = mount();
    await type(handle, "quiet ack");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    // No id back is not a failure; the transcript reconciles on the local key.
    await waitFor(() => expect(seen.acked).toHaveLength(1));
    expect(seen.acked[0][1]).toBe(seen.optimistic[0].renderKey);
    expect(seen.failed).toHaveLength(0);
  });

  it("refuses an empty send rather than posting whitespace", async () => {
    const { container } = mount();
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    expect(posted).toHaveLength(0);
    const send = container.querySelector('[aria-label="Send message"]');
    expect(send?.getAttribute("disabled")).not.toBeNull();
  });

  it("says why it cannot send instead of offering a dead box", async () => {
    const { container } = mount({ disabled: true, disabledReason: "This room is archived." });
    expect(container.textContent).toContain("This room is archived.");
    expect(container.querySelector('[role="textbox"]')).toBeNull();
  });
});

describe("a send that fails", () => {
  it("puts the sentence back in the box, in the draft, and offers a retry", async () => {
    // There is no other copy of this text. A message that vanishes into a
    // network error is the failure this whole path exists to prevent.
    answer = async () => {
      throw new Error("Channel is no longer available.");
    };
    const { container, handle, seen } = mount();
    await type(handle, "the sentence I do not want to lose");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });

    await waitFor(() => expect(seen.failed).toHaveLength(1));
    expect(seen.failed[0][1]).toBe("Channel is no longer available.");

    // Back in the box…
    expect(surface(container).textContent).toContain("the sentence I do not want to lose");
    // …and back on disk, so navigating away from the failure keeps it too.
    expect(peekDraft("ch_a")?.content).toContain("the sentence I do not want to lose");

    // …and said out loud, with the server's own reason.
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Channel is no longer available.");
    expect(toastCalls.at(-1)?.message).toBe("Channel is no longer available.");
    expect(toastCalls.at(-1)?.opts?.kind).toBe("error");
  });

  it("retries the same body, and the retry can succeed", async () => {
    answer = async () => {
      throw new Error("Network unreachable.");
    };
    const { container, handle } = mount();
    await type(handle, "try me again");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeTruthy());

    answer = async () => ({ id: "evt_second" });
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => {
      fireEvent.click(retry);
    });

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ body: "try me again" });
    await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
    expect(peekDraft("ch_a")).toBeUndefined();
  });
});

describe("mentions", () => {
  it("offers people and agents, in that order, from one address book", async () => {
    const { handle } = mount();
    await type(handle, "@");
    await waitFor(() => expect(menuText()).toContain("Ada Lovelace"));
    const text = menuText();
    expect(text).toContain("People");
    expect(text).toContain("Agents");
    // Agents are members, not a separate system to address.
    expect(text).toContain("Scout");
    expect(text.indexOf("People")).toBeLessThan(text.indexOf("Agents"));
  });

  it("sends the token `src/lib/mentions.ts` parses, not a second grammar", async () => {
    // The product has ONE mention grammar. A chat-only spelling would be a
    // mention that notifies nobody, because mentions are parsed out of the
    // stored body server-side.
    const { container, handle } = mount();
    await type(handle, "@Ada");
    await waitFor(() => expect(menuText()).toContain("Ada Lovelace"));

    const row = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-suggestion-menu] button"),
    ).find((button) => button.textContent?.includes("Ada Lovelace"))!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await act(async () => {
      handle.current!.insertText("please look");
    });
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });

    await waitFor(() => expect(posted).toHaveLength(1));
    const body = (posted[0] as { body: string }).body;
    expect(body).toContain("@[Ada Lovelace](u_ada)");
    expect(extractMentionedClerkIds(body)).toEqual(["u_ada"]);
  });

  it("survives being written to a draft and read back", async () => {
    // The half nobody writes. Serializing a mention is easy; *parsing* it back
    // is what a restored draft depends on, and without the rule markdown-it
    // reads `@[Ada](u_ada)` as an "@" plus a link and the next save escapes the
    // bracket. The mention stops being a mention while still looking like one.
    const { container, handle, rerender } = mount();
    await type(handle, "@Ada");
    await waitFor(() => expect(menuText()).toContain("Ada Lovelace"));
    const row = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-suggestion-menu] button"),
    ).find((button) => button.textContent?.includes("Ada Lovelace"))!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await waitFor(() => expect(peekDraft("ch_a")?.content).toContain("@[Ada Lovelace](u_ada)"));

    // Out of the room and back — the draft is re-parsed on the way in.
    const away = (
      <MessageComposer
        scope={SCOPE}
        channelId="ch_b"
        channelLabel="#other"
        author={AUTHOR}
        mentionables={MENTIONABLES}
      />
    );
    await act(async () => rerender(away));
    await act(async () =>
      rerender(
        <MessageComposer
          scope={SCOPE}
          channelId="ch_a"
          channelLabel="#general"
          author={AUTHOR}
          mentionables={MENTIONABLES}
        />,
      ),
    );

    // It comes back as a *mention*, not as an "@" in front of a link whose
    // href happens to be a Clerk id. The bytes alone would not catch this — a
    // link round-trips to the same characters — but the pill is gone, the
    // picker no longer owns it, and the next thing typed beside it merges into
    // the link text.
    await waitFor(() =>
      expect(surface(container).querySelector('[data-type="mention"]')).toBeTruthy(),
    );
    expect(surface(container).querySelector("a")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = (posted[0] as { body: string }).body;
    expect(body).toContain("@[Ada Lovelace](u_ada)");
    expect(body).not.toContain("\\[");
    expect(extractMentionedClerkIds(body)).toEqual(["u_ada"]);
  });

  it("addresses an agent with the same token as a person", async () => {
    const { container, handle } = mount();
    await type(handle, "@Sco");
    await waitFor(() => expect(menuText()).toContain("Scout"));
    const row = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-suggestion-menu] button"),
    ).find((button) => button.textContent?.includes("Scout"))!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { body: string }).body).toContain("@[Scout](ag_scout)");
  });
});

describe("the keyboard", () => {
  it("sends on Enter and breaks the line on Shift+Enter", async () => {
    const { container, handle } = mount();
    await type(handle, "line one");
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter", shiftKey: true });
    });
    expect(posted).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(posted).toHaveLength(1));
  });

  it("gives Enter to the mention menu while it is open", async () => {
    // Which handler ProseMirror consults first depends on plugin order, so the
    // send key is guarded explicitly rather than wagered on it. Without that,
    // picking a mention with Enter posts a half-written message.
    const { container, handle } = mount();
    await type(handle, "@Ada");
    await waitFor(() => expect(menuText()).toContain("Ada Lovelace"));

    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    expect(posted).toHaveLength(0);
    await waitFor(() =>
      expect(surface(container).textContent).toContain("Ada Lovelace"),
    );
  });
});

describe("paste", () => {
  it("takes the text and leaves the markup", async () => {
    // The body is markdown. There is no HTML in it, which is why there is no
    // sanitizer to keep correct — but only if nothing can smuggle markup in.
    const { container, handle } = mount();
    await waitFor(() => expect(handle.current).toBeTruthy());
    await act(async () => {
      fireEvent.paste(surface(container), {
        clipboardData: {
          getData: (type: string) =>
            type === "text/html"
              ? '<b>bold</b> and <a href="https://x.test">a link</a>'
              : "bold and a link",
        },
      });
    });

    await waitFor(() => expect(surface(container).textContent).toContain("bold and a link"));
    expect(surface(container).querySelector("b")).toBeNull();
    expect(surface(container).querySelector("strong")).toBeNull();
    expect(surface(container).querySelector("a")).toBeNull();
  });
});

describe("emoji", () => {
  it("opens the picker and inserts the glyph itself", async () => {
    const { container } = mount();
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Emoji"]')!);
    });
    const picker = document.querySelector("[data-emoji-picker]")!;
    expect(picker).toBeTruthy();

    const thumbs = picker.querySelector('[aria-label="thumbs up"]')!;
    await act(async () => {
      fireEvent.click(thumbs);
    });
    await waitFor(() => expect(surface(container).textContent).toContain("👍"));
  });

  it("puts a community's own emoji first and sends it as a shortcode", async () => {
    // A custom emoji has no glyph, so what travels is `:shortcode:` and the
    // renderers resolve it. Every consumer gets one string either way.
    const { container } = mount({
      customEmoji: [{ shortcode: "shipit", url: "https://cdn.test/shipit.png" }],
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Emoji"]')!);
    });
    const picker = document.querySelector("[data-emoji-picker]")!;
    expect(picker.textContent).toContain("Custom");

    await act(async () => {
      fireEvent.click(picker.querySelector('[aria-label=":shipit:"]')!);
    });
    await waitFor(() => expect(surface(container).textContent).toContain(":shipit:"));
  });
});

describe("quoting", () => {
  it("drops a quoted message in as a blockquote the sender can still edit", async () => {
    // §2.4: there is no quote-with-attribution primitive. A quote is markdown.
    const { container } = mount({
      quote: { author: "Grace Hopper", body: "ship it on Friday" },
    });
    await waitFor(() =>
      expect(surface(container).querySelector("blockquote")).toBeTruthy(),
    );
    expect(surface(container).textContent).toContain("Grace Hopper: ship it on Friday");
  });

  it("sends the quote as markdown `>` rather than as a structure of its own", async () => {
    const { container } = mount({
      quote: { author: "Grace Hopper", body: "ship it on Friday" },
    });
    await waitFor(() =>
      expect(surface(container).querySelector("blockquote")).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.keyDown(surface(container), { key: "Enter" });
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { body: string }).body).toContain("> Grace Hopper: ship it on Friday");
  });
});
