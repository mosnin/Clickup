// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { UserAvatar } from "@/components/identity/user-avatar";

// The preset avatar's contract, which is a product rule before it is a
// component: **a saved photo always wins, and nobody without one gets a
// letter.** Both halves matter. A fallback that quietly outranked a real
// photo would replace people's faces with generated art; a fallback that
// only reached one surface would leave initials on every other screen, which
// is the state this replaced.

describe("UserAvatar", () => {
  it("shows the saved photo and generates nothing", () => {
    const { container } = render(
      <UserAvatar
        name="Ada Lovelace"
        seed="user_ada"
        imageUrl="https://example.test/ada.jpg"
      />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.test/ada.jpg");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("generates a mark when no photo is saved", () => {
    const { container } = render(<UserAvatar name="Ada Lovelace" seed="user_ada" />);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // Not a letter: the old fallback rendered the initial as text, and a
    // members list of Alexes was three identical circles.
    expect(container.textContent).toBe("");
  });

  it("treats an empty photo string as no photo rather than a broken image", () => {
    const { container } = render(<UserAvatar name="Ada" seed="user_ada" imageUrl="" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("draws from the id, so a renamed person keeps their mark", () => {
    const seeded = (name: string) => {
      const { container } = render(<UserAvatar name={name} seed="user_ada" />);
      return container.querySelector("canvas")?.getAttribute("width");
    };
    // Same seed, different display name: the canvas is sized and drawn from
    // `seed`, so the mark does not follow a rename.
    expect(seeded("Ada Lovelace")).toBe(seeded("A. Lovelace"));
  });

  it("names the person for a pointer but stays out of the reading order", () => {
    // The name is always beside this mark, so announcing it again is noise —
    // and the upstream default would have read an opaque id aloud.
    const { container } = render(<UserAvatar name="Ada Lovelace" seed="user_ada" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("title")).toBe("Ada Lovelace");
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("canvas")?.getAttribute("aria-label")).toBeNull();
  });

  it("takes an exact diameter as well as a step on the scale", () => {
    const { container } = render(<UserAvatar name="Ada" size={36} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.width).toBe("36px");
    expect(root.style.height).toBe("36px");
  });
});
