// Every surface of the dynamic UI, and how to stand in front of it.
//
// This list is the coverage claim, and it is written down so that a hole in it
// is a thing somebody can see. The failure this project has already had was
// not a wrong reading — it was a reading taken over a surface nobody had
// looked at, reported as though the whole product had been checked. A coverage
// list with silent holes is the same failure as the downscaled screenshot, and
// more dangerous, because it looks complete.
//
// So three rules hold for everything below:
//
//   1. **A surface reached only by interaction is driven, not skipped.** Open
//      the sheet, press the chapter, start the drag. If it cannot be driven,
//      that is a finding with a reason, never an omission.
//   2. **Arrival is verified, never assumed.** Every `prep` has a `verify`
//      that fails loudly if the state did not actually arrive. A prep that
//      silently no-ops and a surface that renders correctly are the same
//      screenshot, and only one of them is true.
//   3. **The studio is photographed over the PRODUCT.** Its whole promise, in
//      its own words on screen, is "it applies everywhere, live behind" — a
//      shot taken over a specimen sheet cannot show whether a change reaches
//      anything, so the sheet is opened over Home and over the project screen.

/** Chapter tabs, whatever they currently are. Hardcoding them goes stale. */
async function chapterNames(page) {
  return page.$$eval('[role="tab"]', (els) =>
    els.map((e) => (e.textContent || "").trim()).filter(Boolean),
  );
}

/** Select a panel, then open the style sheet over it. */
async function openStudio(page, tile) {
  // Clicking the tile IS the scope selector — a delegated capture-phase
  // handler in the customise provider turns the press into a selection. Going
  // through it rather than calling the setter is the point: the question is
  // whether a person can reach this, not whether the component renders when
  // handed props.
  const target = page.locator(`[data-tile="${tile}"]`).first();
  await target.click({ position: { x: 40, y: 30 } });
  await page.waitForTimeout(400);
  await page.locator("#style-island button").first().click();
  await page.waitForTimeout(1500);
}

async function tabsPresent(page) {
  const tabs = await chapterNames(page);
  return tabs.length === 0 ? "the style sheet never opened — no chapters" : null;
}

const STUDIO_STATES = async (page) => {
  const names = await chapterNames(page);
  const states = names.map((name) => ({
    id: "chapter-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    title: `Style studio · ${name}`,
    async enter(p) {
      await p.getByRole("tab", { name, exact: true }).first().click();
      await p.waitForTimeout(1500);
    },
    async verify(p) {
      const selected = await p.$$eval('[role="tab"]', (els) =>
        els
          .filter((e) => e.getAttribute("aria-selected") === "true")
          .map((e) => (e.textContent || "").trim()),
      );
      return selected.includes(name)
        ? null
        : `pressing the "${name}" chapter did not select it (selected: ${selected.join(", ") || "none"})`;
    },
  }));

  // The builder's second step. A step never opened is a step that ships
  // broken, and this one had only ever been photographed at one width.
  if (names.some((n) => /new card/i.test(n))) {
    states.push({
      id: "chapter-new-card-shape",
      title: "Style studio · New card · how should it be drawn",
      async enter(p) {
        await p
          .getByRole("tab", { name: names.find((n) => /new card/i.test(n)) })
          .first()
          .click();
        await p.waitForTimeout(1400);
        await p.locator("[data-item-id]").first().click();
        await p.waitForTimeout(1600);
      },
      async verify(p) {
        const add = await p.$$eval("button", (els) =>
          els.map((e) => (e.textContent || "").trim()).filter((t) => /^Add /.test(t)),
        );
        return add.length > 0
          ? null
          : "picking a starting point did not reach the shape step (no Add control)";
      },
    });
  }
  return states;
};

export const SURFACES = [
  // ── The two real canvases ──────────────────────────────────────────
  {
    id: "home-arranged",
    title: "Home — a screen somebody arranged",
    url: "home.html",
    note: "Mixed tile heights on purpose: the overlap bug only appeared when neighbouring tiles disagreed about how tall they were.",
  },
  {
    id: "home-blank",
    title: "Home — never customised",
    url: "home.html?plain=1",
    note: "What every account starts on, and the state a fixture author has to go out of their way to produce.",
  },
  {
    id: "project-arranged",
    title: "Project screen — arranged, with an authored panel on it",
    url: "project.html",
  },
  {
    id: "project-blank",
    title: "Project screen — never arranged (the defaults)",
    url: "project.html?state=blank",
  },
  {
    id: "project-cleared",
    title: "Project screen — arranged, then emptied",
    url: "project.html?state=cleared",
    note: "Not the same as never arranged. Somebody who cleared their screen keeps a clear screen; the difference is one `??` in the reader and only a picture shows it.",
    async verify(page) {
      const tiles = await page.$$eval("[data-tile]", (e) => e.length);
      return tiles === 0
        ? null
        : `an emptied screen rendered ${tiles} tiles — the defaults came back`;
    },
  },
  {
    id: "project-arrange",
    title: "Project screen — arrange mode (handles, tray, wobble)",
    url: "project.html?state=arrange",
    async verify(page) {
      const handles = await page.$$eval(
        '[aria-label^="Resize"], [aria-label^="Remove"]',
        (e) => e.length,
      );
      return handles > 0
        ? null
        : "arrange mode showed no handles — the surface is not editable here";
    },
  },

  // ── Consent: an agent asking, a person deciding ─────────────────────
  {
    id: "project-layout-proposal",
    title: "Project screen — an agent proposes a rearrangement",
    url: "project.html?state=layout",
    async verify(page) {
      const buttons = await page.$$eval("button", (els) =>
        els.map((e) => (e.textContent || "").trim()),
      );
      return buttons.includes("Accept") && buttons.includes("Dismiss")
        ? null
        : "the layout proposal banner did not render a refusable choice";
    },
  },
  {
    id: "project-layout-preview",
    title: "Project screen — previewing the proposed arrangement",
    url: "project.html?state=layout",
    note: "The preview morphs the real grid. It IS the result, which is the only preview worth showing.",
    async prep(page) {
      await page.getByRole("button", { name: "Preview" }).first().click();
      await page.waitForTimeout(1200);
    },
    async verify(page) {
      const order = await page.$$eval("[data-tile]", (els) =>
        els.map((e) => e.getAttribute("data-tile")),
      );
      return order[0] === "progress"
        ? null
        : `pressing Preview did not morph the grid (order still ${order.join(",")})`;
    },
  },
  {
    id: "project-panel-proposal",
    title: "Project screen — an agent proposes a panel that does not exist yet",
    url: "project.html?state=panel",
    async verify(page) {
      const buttons = await page.$$eval("button", (els) =>
        els.map((e) => (e.textContent || "").trim()),
      );
      return buttons.includes("Add it") && buttons.includes("No thanks")
        ? null
        : "the panel proposal banner did not render a refusable choice";
    },
  },

  // ── The studio, over the product ────────────────────────────────────
  {
    id: "studio-home",
    title: "Style studio, open over Home",
    url: "home.html?studio=1",
    note: "Over the real screen, not a specimen sheet: the sheet's own claim is that a change applies live behind it, and only a shot over the product can show that.",
    async prep(page) {
      await openStudio(page, "activity");
    },
    verify: tabsPresent,
    states: STUDIO_STATES,
  },
  {
    id: "studio-project",
    title: "Style studio, open over a project screen",
    url: "project.html?studio=1",
    async prep(page) {
      await openStudio(page, "progress");
    },
    verify: tabsPresent,
  },
  {
    id: "mint-shelf",
    title: "Chart chapter over a BUILT-IN — the offer to mint your own",
    url: "home.html?studio=1",
    note: "The shelf only appears when the selected panel has no stored definition. Every studio shot before this came from a page where nothing offers, so the state that shipped was the unseen one.",
    async prep(page) {
      await openStudio(page, "activity");
      await page.getByRole("tab", { name: "Chart", exact: true }).first().click();
      await page.waitForTimeout(1600);
    },
    async verify(page) {
      const shapes = await page.$$eval("[data-item-id]", (e) => e.length);
      if (shapes === 0) return "no shapes offered for a built-in panel";
      // Counting shapes says the shelf rendered. It says nothing about whether
      // the button that commits one is on screen or under something, and a
      // screenshot of a covered button looks fine.
      const commit = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((b) =>
          /^Use /.test(b.textContent || ""),
        );
        if (!button) return { found: false };
        const r = button.getBoundingClientRect();
        const over = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return {
          found: true,
          label: button.textContent,
          belowFold: r.bottom > window.innerHeight,
          covered: over !== button && !button.contains(over),
          coveredBy: over ? over.tagName : null,
        };
      });
      if (!commit.found) return "no way to commit a shape";
      if (commit.belowFold)
        return `"${commit.label}" is below the fold — the only pointer path to this feature is unreachable`;
      if (commit.covered)
        return `"${commit.label}" is covered by <${commit.coveredBy}>`;
      return null;
    },
  },

  // ── A panel arriving because a condition became true ────────────────
  {
    id: "situation-arrival",
    title: "A panel arriving on a canvas somebody is standing on",
    url: "situation.html",
    note: "The consent shape pointed at a condition rather than an agent: announce, say why, be refusable. The claim it must not break is that the arriving panel displaces nothing.",
    async verify(page) {
      const buttons = await page.$$eval("button", (els) =>
        els.map((e) => (e.textContent || "").trim()),
      );
      return buttons.includes("Keep") && buttons.includes("Not now")
        ? null
        : `the arrival banner did not offer a refusable choice (saw: ${buttons.slice(0, 8).join(", ")})`;
    },
  },
  {
    id: "situation-kept",
    title: "The arriving panel, kept, and the condition then lapsing",
    url: "situation.html",
    note: "A kept panel is the reader's. When the condition ends it must still be there — the departure case, which is where an adaptive UI usually takes something away.",
    async prep(page) {
      await page.getByRole("button", { name: "Keep", exact: true }).first().click();
      await page.waitForTimeout(900);
      await page.locator("#end-condition").click();
      await page.waitForTimeout(900);
    },
    async verify(page) {
      const tiles = await page.$$eval("[data-tile]", (els) =>
        els.map((e) => e.getAttribute("data-tile")),
      );
      return tiles.some((t) => t && t.startsWith("custom:"))
        ? null
        : "the kept panel disappeared when the condition lapsed";
    },
  },

  // ── Specimen sheets ─────────────────────────────────────────────────
  {
    id: "panels",
    title: "The panel renderer at every shape, in every state",
    url: "panels.html",
    note: "19 shapes x {with data, empty, capped}, plus the proposal banner and both empty-state shells. Each panel is cropped on its own at native resolution.",
    settle: 3400,
    async verify(page) {
      const n = await page.$$eval("[data-audit-panel]", (e) => e.length);
      return n >= 57
        ? null
        : `only ${n} panels rendered — the shape sweep is incomplete`;
    },
  },
  {
    id: "grid",
    title: "The editable grid, under a real pointer",
    url: "grid.html",
    gesture: true,
  },
  {
    id: "sidebar",
    title: "The sidebar, and the primitive under it",
    url: "sidebar.html",
  },
  {
    id: "charts",
    title: "Every chart kind, palette and preset",
    url: "index.html",
    settle: 3000,
  },
  {
    id: "labels",
    title: "Axis labels at the widths panels are actually drawn at",
    url: "labels.html",
    settle: 3000,
  },
  // The four states a fleet puts a task into. Added because this list is the
  // audit's COVERAGE BOUNDARY and nobody had noticed it was one: the contrast
  // gate below is good enough to have caught the accent-ramp bug — 1.12:1 text
  // in dark, app-wide — on its first run, and never saw it, because every
  // surface carrying a brand-toned pair (task banners, comments, the agents
  // page, sprints, the roadmap) is outside these twenty entries. A gate that
  // does not point at a surface is not a gate that passed it.
  {
    id: "collab",
    title: "Task banners and board badges, in every fleet state",
    url: "collab.html",
  },
];

/**
 * The live-behind claim, measured rather than asserted.
 *
 * The studio says on screen that a choice "applies everywhere, live behind".
 * That is a testable sentence: change a palette with the sheet open and a mark
 * on the canvas BEHIND the sheet has to change colour. If it does not, the
 * control is present and does nothing, which is a rubric cap — and a
 * screenshot of the sheet cannot tell you either way, which is why this is a
 * measurement and not a photograph.
 */
export async function measureLiveBehind(page) {
  const sample = () =>
    page.evaluate(() => {
      // A mark on the canvas, deliberately not one inside the sheet.
      const sheet = document.querySelector('[role="dialog"], #style-studio');
      const marks = [...document.querySelectorAll("svg rect, svg path")].filter(
        (el) => {
          if (sheet && sheet.contains(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width * r.height > 150;
        },
      );
      return marks.slice(0, 12).map((el) => getComputedStyle(el).fill);
    });

  const before = await sample();
  if (before.length === 0) {
    return { measurable: false, why: "no marks on the canvas behind the sheet" };
  }
  const options = await page.$$("[data-item-id]");
  if (options.length < 2) {
    return { measurable: false, why: "the colour chapter offered nothing to pick" };
  }
  // The last option rather than the second: adjacent palettes can be close
  // enough that a real change reads as no change, which would report a working
  // control as dead — the false alarm that gets a gate switched off.
  await options[options.length - 1].click();
  await page.waitForTimeout(1400);
  const after = await sample();
  const changed = before.some((c, i) => after[i] !== undefined && after[i] !== c);
  return { measurable: true, changed, before, after };
}
