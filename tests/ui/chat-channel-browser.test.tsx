import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calls, mutationHandlers, queryResults, resetHarness, toastCalls } from "./harness";
import { ChannelBrowserDialog } from "@/components/chat/channel-browser";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";

// The dialog. `channel-search.test.ts` already proves the ranking and the
// visibility rule; this file is about the half a pure test cannot see — that
// the create row really is the first thing the arrow keys reach, that the
// dialog does not offer to create a room that exists, and that each of the
// four empty states is the one the situation calls for.
//
// No jest-dom in this project, so assertions read attributes directly.

const SCOPE = { scopeType: "workspace", scopeId: "ws1" } as const;

function room(over: Partial<ChatChannelSummary> = {}): ChatChannelSummary {
  const name = over.name ?? "general";
  return {
    channelId: name,
    kind: "channel",
    visibility: "public",
    memberCount: 4,
    unread: 0,
    mentions: 0,
    muted: false,
    joined: true,
    ...over,
    name,
    // A room's display name defaults to its canonical name, as it does for a
    // room nobody has renamed. Left to the spread it would stay "general" for
    // every fixture, and every row would claim to be the same channel.
    displayName: over.displayName ?? name,
  };
}

function open(props: Partial<React.ComponentProps<typeof ChannelBrowserDialog>> = {}) {
  const onSelectChannel = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ChannelBrowserDialog
      scope={SCOPE}
      open
      onOpenChange={onOpenChange}
      onSelectChannel={onSelectChannel}
      {...props}
    />,
  );
  return { onSelectChannel, onOpenChange, search: screen.getByRole("combobox") };
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("the channel browser", () => {
  beforeEach(() => {
    resetHarness();
    queryResults["buzz.channels.list"] = [];
  });

  // -------------------------------------------------------------------------
  // The create row is index 0
  // -------------------------------------------------------------------------

  it("puts the create row first, before any channel, for the arrow keys", () => {
    // This is the point of the design, not a nicety: type a name that does not
    // exist, press Enter, get the room. If the create row were anywhere but
    // first, the keyboard order and the visual order would part company the
    // moment the result list emptied.
    queryResults["buzz.channels.list"] = [
      room({ channelId: "a", name: "alpha" }),
      room({ channelId: "b", name: "beta" }),
    ];
    const { search } = open();

    const options = screen.getAllByRole("option");
    expect(options[0]!.getAttribute("id")).toBe("channel-browser-create");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    // …and the first channel is only reached on the second press.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const after = screen.getAllByRole("option");
    expect(after[0]!.getAttribute("aria-selected")).toBe("false");
    expect(after[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("points aria-activedescendant at whatever the arrow keys landed on", () => {
    queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
    const { search } = open();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe("channel-browser-create");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe("channel-browser-a");
  });

  it("clamps rather than wrapping at the bottom of the list", () => {
    queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
    const { search } = open();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
  });

  it("takes Enter on a name nothing carries straight into the create form", () => {
    queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
    const { search } = open();
    type(search, "Release Notes");
    fireEvent.keyDown(search, { key: "Enter" });

    // Prefilled with the canonical name, because that is the room you will get.
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("release-notes");
  });

  it("opens the selected channel on Enter rather than creating anything", () => {
    queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
    const { search, onSelectChannel, onOpenChange } = open();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelectChannel).toHaveBeenCalledWith("a");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // -------------------------------------------------------------------------
  // No duplicates
  // -------------------------------------------------------------------------

  it("does not offer to create a channel that already exists", () => {
    queryResults["buzz.channels.list"] = [room({ channelId: "g", name: "general" })];
    const { search } = open();
    expect(screen.queryByText(/Create a new channel/)).not.toBeNull();

    type(search, "general");
    expect(screen.queryByText(/^Create channel/)).toBeNull();
    expect(screen.queryByText(/Create a new channel/)).toBeNull();
    // The room itself is still the result, so the answer to "does it exist" is
    // the room rather than an absence.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.getAttribute("id")).toBe("channel-browser-g");
  });

  it("recognises the existing room however the name was typed", () => {
    queryResults["buzz.channels.list"] = [
      room({ channelId: "g", name: "release-notes", displayName: "Release notes" }),
    ];
    const { search } = open();
    type(search, "#Release Notes");
    expect(screen.queryAllByRole("option").map((o) => o.getAttribute("id"))).toEqual([
      "channel-browser-g",
    ]);
  });

  it("still offers to create when only a DM carries that name", () => {
    queryResults["buzz.channels.list"] = [
      room({ channelId: "d", name: "ada", kind: "dm" }),
    ];
    const { search } = open();
    type(search, "ada");
    expect(screen.queryByText("Create channel “#ada”")).not.toBeNull();
  });

  it("never offers creation at all when the caller says it is not available", () => {
    const { search } = open({ canCreate: false });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(search.getAttribute("placeholder")).toBe(
      "Search channels by name or description",
    );
  });

  // -------------------------------------------------------------------------
  // What the browser will and will not list
  // -------------------------------------------------------------------------

  it("does not list a private room the person is not in", () => {
    queryResults["buzz.channels.list"] = [
      room({ channelId: "s", name: "layoffs", visibility: "private", joined: false }),
    ];
    const { search } = open();
    type(search, "layoffs");
    expect(screen.queryByText(/layoffs/)).toBeNull();
    // And the create row is suppressed, because the name is taken — the server
    // knows that even though the browser may not say why.
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The four empty states
  // -------------------------------------------------------------------------

  describe("empty states", () => {
    it("says a search found nothing, and that you may create it", () => {
      queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
      const { search } = open();
      type(search, "zzz");
      expect(screen.queryByText("No channels match your search")).not.toBeNull();
      expect(
        screen.queryByText("No channel by that name yet — create it to get started."),
      ).not.toBeNull();
    });

    it("suggests a different keyword instead, when creation is unavailable", () => {
      queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
      const { search } = open({ canCreate: false });
      type(search, "zzz");
      expect(screen.queryByText("Try a different name or keyword.")).not.toBeNull();
    });

    it("explains the archived tab", () => {
      queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
      open();
      fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
      expect(screen.queryByText("No archived channels")).not.toBeNull();
      expect(
        screen.queryByText("Archived channels you have joined will appear here."),
      ).not.toBeNull();
    });

    it("explains the joined tab", () => {
      queryResults["buzz.channels.list"] = [
        room({ channelId: "a", name: "alpha", joined: false }),
      ];
      open();
      fireEvent.click(screen.getByRole("tab", { name: "Joined" }));
      expect(screen.queryByText("No joined channels")).not.toBeNull();
      expect(screen.queryByText("Channels you join will appear here.")).not.toBeNull();
    });

    it("explains a community with nothing to browse yet", () => {
      queryResults["buzz.channels.list"] = [];
      open();
      expect(screen.queryByText("No channels to browse")).not.toBeNull();
      expect(
        screen.queryByText(
          "All open channels are available in the sidebar. Create a new channel to get started.",
        ),
      ).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Joining
  // -------------------------------------------------------------------------

  it("joins a room, then closes onto it", async () => {
    queryResults["buzz.channels.list"] = [
      room({ channelId: "o", name: "open-room", joined: false }),
    ];
    const { onSelectChannel, onOpenChange } = open();
    const row = screen.getByRole("option", { name: /open-room/ });
    fireEvent.click(within(row).getByRole("button", { name: "Join" }));
    await Promise.resolve();

    // The community is on the wire, because `buzz/channels:join` requires it:
    // a channel id is unique inside a community, so a join with no scope is a
    // join the argument validator refuses.
    expect(calls("buzz.channels.join")).toEqual([
      { scopeType: "workspace", scopeId: "ws1", channelId: "o" },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelectChannel).toHaveBeenCalledWith("o");
  });

  it("does not show Join on a room you are already in", () => {
    queryResults["buzz.channels.list"] = [
      room({ channelId: "m", name: "mine", joined: true }),
    ];
    open();
    const row = screen.getByRole("option", { name: /mine/ });
    expect(within(row).queryByRole("button", { name: "Join" })).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Create mode
  // -------------------------------------------------------------------------

  // The assertion is `buzz/channels:create`'s own argument validator, spelled
  // out: `open`/`private` and `stream`/`forum` are the words the log records,
  // and the form's `public`/`channel` are the words a person reads. The dialog
  // used to send the reader's words straight through, so every creation would
  // have been refused the moment it was mounted — which is exactly the kind of
  // break a UI test asserting the caller's own shape cannot see.
  it("sends the canonical name and the form's choices to the backend", async () => {
    queryResults["buzz.identity.myPubkey"] = { pubkey: "aa".repeat(32) };
    const { search } = open();
    type(search, "Release Notes");
    fireEvent.keyDown(search, { key: "Enter" });

    fireEvent.click(screen.getByRole("radio", { name: "Invite only" }));
    fireEvent.click(screen.getByRole("radio", { name: "Temporary" }));
    fireEvent.click(screen.getByRole("radio", { name: "12 hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(calls("buzz.channels.create")).toHaveLength(1));

    const sent = calls("buzz.channels.create")[0] as Record<string, unknown>;
    expect(sent).toEqual({
      scopeType: "workspace",
      scopeId: "ws1",
      name: "release-notes",
      visibility: "private",
      channelType: "stream",
      ttlSeconds: 12 * 3600,
    });
    expect(sent).not.toHaveProperty("kind");
    expect(JSON.stringify(sent)).not.toContain("public");
    expect(calls("buzz.keys.mint")).toEqual([]);
    await waitFor(() =>
      expect(toastCalls.map((t) => t.message)).toContain("#release-notes created"),
    );
  });

  it("translates the words a person reads into the words the log records", async () => {
    // The other side of the same branch, and the one the default lands on: a
    // room somebody left alone is `public` in the form and `open` on the wire.
    // A forum is a forum in both, which is why only one of the two pairs is
    // easy to notice when it is wrong.
    queryResults["buzz.identity.myPubkey"] = { pubkey: "aa".repeat(32) };
    const { search } = open({ kindFilter: "forum" });
    type(search, "rfcs");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Create forum" }));
    await waitFor(() => expect(calls("buzz.channels.create")).toHaveLength(1));

    const sent = calls("buzz.channels.create")[0] as Record<string, unknown>;
    expect(sent).toEqual({
      scopeType: "workspace",
      scopeId: "ws1",
      name: "rfcs",
      visibility: "open",
      channelType: "forum",
    });
    expect(JSON.stringify(sent)).not.toContain("public");
    expect(sent).not.toHaveProperty("kind");
  });

  it("mints a Chat identity on first visit before creating, so the form is not a dead end", async () => {
    queryResults["buzz.identity.myPubkey"] = { pubkey: null };
    const { search } = open();
    type(search, "design");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(calls("buzz.channels.create")).toHaveLength(1));

    expect(calls("buzz.keys.mint")).toEqual([{ principal: { type: "user" } }]);
    const sent = calls("buzz.channels.create")[0] as Record<string, unknown>;
    expect(sent.visibility).toBe("open");
    expect(sent).not.toHaveProperty("kind");
  });

  it("shows a human next action, never a Convex validator dump", async () => {
    queryResults["buzz.identity.myPubkey"] = { pubkey: "aa".repeat(32) };
    mutationHandlers["buzz.channels.create"] = () => {
      throw new Error("ArgumentValidationError: Value does not match validator");
    };
    const { search } = open();
    type(search, "design");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/refresh/i);
    expect(alert.textContent).not.toMatch(/ArgumentValidation|validator/i);
  });

  it("lets a template fill the description but never overrule a chosen visibility", () => {
    const { search } = open();
    fireEvent.keyDown(search, { key: "Enter" });

    // Choose visibility first, then a template that wants the other one.
    fireEvent.click(screen.getByRole("radio", { name: "Anyone can join" }));
    fireEvent.click(screen.getByRole("radio", { name: "Incident" }));

    const description = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(description.value).not.toBe("");
    expect(
      screen.getByRole("radio", { name: "Anyone can join" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("returns to the search you were already doing", () => {
    queryResults["buzz.channels.list"] = [room({ channelId: "a", name: "alpha" })];
    const { search } = open();
    type(search, "roadmap");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Back to search" }));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("roadmap");
  });

  // -------------------------------------------------------------------------
  // Honesty about the backend
  // -------------------------------------------------------------------------

  it("shows nothing rather than inventing channels before the query answers", () => {
    // `undefined` from useQuery is "not answered yet", which is a different
    // thing from "no channels" and must not be drawn as one — and neither may
    // be drawn as a placeholder room.
    delete queryResults["buzz.channels.list"];
    open();
    expect(screen.queryByText("No channels to browse")).toBeNull();
    expect(
      screen.queryAllByRole("option").map((o) => o.getAttribute("id")),
    ).toEqual(["channel-browser-create"]);
  });
});
