import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetHarness } from "./harness";
import { ChatSearchLauncher } from "@/components/chat/search";

// The keystroke, which is the only part of this component a picture cannot
// check and the part that broke.
//
// `ChatSearchLauncher` shipped bound to ⌘K, which the product's command palette
// already owns at the window (`command-palette.tsx`) and which the Chat
// sidebar's "Search everything" row dispatches to. Two window listeners for one
// keystroke is not a bug `defaultPrevented` can fix — both handlers are
// legitimate and both call it, so which one wins is whichever mounted first.
// The fix is a different key, and a different key is exactly the kind of thing
// that gets quietly reverted by somebody restoring the "standard" shortcut.
//
// The dialog needs no backend here: with an empty box `useSearch` skips every
// query, so this file is about arbitration and nothing else.

const SCOPE = { scopeType: "workspace", scopeId: "ws1" } as const;

function mount() {
  render(<ChatSearchLauncher scope={SCOPE} channels={[]} />);
  return screen.getByRole("button", { name: /Search/ });
}

/** A window-level keystroke, the way a browser delivers one. */
function press(key: string, modifiers: { shift?: boolean } = {}) {
  fireEvent.keyDown(window, {
    key,
    metaKey: true,
    shiftKey: modifiers.shift ?? false,
  });
}

describe("the Chat search launcher", () => {
  beforeEach(resetHarness);

  it("does not answer ⌘K, which belongs to the command palette", () => {
    mount();
    press("k");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on ⌘⇧F", () => {
    mount();
    press("F", { shift: true });
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("opens on ⌘⇧F while somebody is typing", () => {
    // Deliberately different from the ⌘K behaviour it replaces. A chat
    // application's focus lives in the composer nearly all of the time, so a
    // search shortcut that defers to any editable target is a shortcut that
    // never fires. ⌘⇧F types nothing, so there is nothing to defer to.
    mount();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(window, { key: "F", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    field.remove();
  });

  it("yields to a surface that claimed the keystroke for itself", () => {
    // Listener order cannot be relied on — this one registers at mount and a
    // room's registers later — so yielding is explicit rather than positional.
    mount();
    const event = new KeyboardEvent("keydown", {
      key: "F",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
      bubbles: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says which keystroke it answers, where a screen reader will find it", () => {
    const button = mount();
    expect(button.getAttribute("aria-keyshortcuts")).toBe(
      "Meta+Shift+F Control+Shift+F",
    );
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  });
});
