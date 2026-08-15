import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Section Transition 03 (vendored) — the pixelated grid handoff between two
// adjacent sibling sections. Mark the OUTGOING section with `data-st-03`
// (optional value = desktop grid resolution); as it scrolls out, a
// bottom-aligned grid of square cells fades in bottom-to-top in a staggered
// wave, colored by sampling the NEXT sibling's computed background — so the
// filled strip merges seamlessly into the section it hands off to. That
// sampling rule is why the incoming sections tagged on the home page carry a
// real background-color: on this site's black canvas, a transparent sibling
// would sample through to white and flash.
//
// Ported near-verbatim on the founder's instruction — the hash-based
// per-cell randomness, the row-from-bottom delay math, the square-cell row
// calculation and the scrub range ARE the effect. Adaptations, each
// sanctioned by the resource's own porting notes: the DOMContentLoaded
// footer is dropped (the marketing template drives init from the mounted
// client lifecycle), and it is typed for a strict TS tree.
//
// REDUCED MOTION is the caller's job (page-effects.tsx): skipping this
// helper injects no layers and registers no triggers, which is the correct
// degraded state — the page simply cuts between sections.

gsap.registerPlugin(ScrollTrigger);

type StConfig = {
  resolution: number;
  spread: number;
  fillDuration: number;
  layerHeight: string | number;
  mode: string;
  coverStart: string;
  revealStart: string;
  mobile: { breakpoint: number; resolution?: number };
};

export function sectionTransition03(
  scopeOrConfig: Document | Element | Partial<StConfig> = document,
  maybeConfig: Partial<StConfig> = {},
) {
  const DEFAULT_CONFIG: StConfig = {
    resolution: 20,
    spread: 5,
    fillDuration: 0.03,
    layerHeight: "64vh",
    mode: "cover",
    coverStart: "bottom bottom+=20%",
    revealStart: "top bottom",
    mobile: {
      breakpoint: 768,
    },
  };

  const isScope = (value: unknown): value is Document | Element =>
    value instanceof Element || value instanceof Document;
  const getConfig = (overrides: Partial<StConfig> = {}): StConfig => ({
    ...DEFAULT_CONFIG,
    ...overrides,
    mobile: {
      ...DEFAULT_CONFIG.mobile,
      ...(overrides.mobile || {}),
    },
  });
  const getPositiveInt = (
    value: string | number | null | undefined,
    fallback: number,
  ) => {
    const parsedValue = Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(parsedValue) && parsedValue > 0
      ? parsedValue
      : fallback;
  };
  const getPositiveFloat = (
    value: string | number | null | undefined,
    fallback: number,
  ) => {
    const parsedValue = Number.parseFloat(String(value ?? ""));
    return Number.isFinite(parsedValue) && parsedValue > 0
      ? parsedValue
      : fallback;
  };
  const getCssSize = (
    value: string | number | undefined,
    fallback: string | number,
  ): string => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return `${value}px`;
    }

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    return String(fallback);
  };
  const isMobileViewport = (config: StConfig) =>
    window.matchMedia(`(max-width: ${config.mobile.breakpoint}px)`).matches;
  const getResolution = (
    section: HTMLElement,
    config: StConfig,
    isMobile: boolean,
  ) => {
    const desktopResolution = getPositiveInt(
      section.getAttribute("data-st-03"),
      getPositiveInt(config.resolution, DEFAULT_CONFIG.resolution),
    );

    if (!isMobile) return desktopResolution;

    return getPositiveInt(
      section.dataset.stMobileResolution,
      getPositiveInt(config.mobile.resolution, desktopResolution),
    );
  };
  const isTransparentColor = (value: string) =>
    value === "transparent" ||
    value === "rgba(0, 0, 0, 0)" ||
    value === "rgba(0,0,0,0)";
  const resolveFillColor = (nextSection: Element) => {
    const colorCandidates = [
      nextSection,
      nextSection.parentElement,
      document.body,
      document.documentElement,
    ];

    for (const element of colorCandidates) {
      if (!element) continue;

      const backgroundColor = getComputedStyle(element).backgroundColor;
      if (!isTransparentColor(backgroundColor)) {
        return backgroundColor;
      }
    }

    return "rgb(255, 255, 255)";
  };
  const hash = (i: number) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const createPixelLayer = (
    section: HTMLElement,
    columnCount: number,
    fillColor: string,
    layerHeight: string,
  ) => {
    const computedStyles = getComputedStyle(section);

    if (computedStyles.position === "static") {
      section.style.position = "relative";
    }

    if (computedStyles.isolation !== "isolate") {
      section.style.isolation = "isolate";
    }

    if (!["hidden", "clip"].includes(computedStyles.overflow)) {
      section.style.overflow = "hidden";
    }

    const layer = document.createElement("div");
    layer.setAttribute("data-st-03-pixels", "");
    layer.setAttribute("aria-hidden", "true");

    Object.assign(layer.style, {
      position: "absolute",
      left: "0",
      right: "0",
      bottom: "0",
      top: "auto",
      height: layerHeight,
      zIndex: "4",
      pointerEvents: "none",
    });

    section.append(layer);

    const layerWidth = layer.offsetWidth;
    const layerHeightPx = layer.offsetHeight;
    const cellSize = layerWidth / columnCount;
    const rowCount = Math.max(Math.ceil(layerHeightPx / cellSize), 1);

    Object.assign(layer.style, {
      display: "grid",
      gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rowCount}, minmax(0, 1fr))`,
    });

    const totalCells = columnCount * rowCount;
    const cells = Array.from({ length: totalCells }, () => {
      const cell = document.createElement("span");
      cell.setAttribute("data-st-03-cell", "");

      Object.assign(cell.style, {
        display: "block",
        width: "100%",
        height: "100%",
        background: fillColor,
        backfaceVisibility: "hidden",
      });

      layer.append(cell);
      return cell;
    });

    gsap.set(cells, { opacity: 0 });

    return { layer, cells, rows: rowCount, columns: columnCount };
  };

  const scope = isScope(scopeOrConfig) ? scopeOrConfig : document;
  const config = getConfig(
    isScope(scopeOrConfig) ? maybeConfig : scopeOrConfig,
  );
  const isMobile = isMobileViewport(config);
  const sections = scope.querySelectorAll<HTMLElement>("[data-st-03]");

  sections.forEach((section) => {
    const nextSection = section.nextElementSibling;
    if (!(nextSection instanceof Element)) return;

    const resolution = getResolution(section, config, isMobile);
    const spread = getPositiveInt(
      section.dataset.stSpread,
      config.spread ?? DEFAULT_CONFIG.spread,
    );
    const fillColor = resolveFillColor(nextSection);
    const layerHeight = getCssSize(
      config.layerHeight,
      DEFAULT_CONFIG.layerHeight,
    );
    const { layer, cells, rows, columns } = createPixelLayer(
      section,
      resolution,
      fillColor,
      layerHeight,
    );
    const maxDelay = Math.max(rows - 1 + spread, 1);
    const cellDelays = cells.map((_, index) => {
      const row = Math.floor(index / columns);
      const rowFromBottom = rows - 1 - row;

      return (rowFromBottom + hash(index) * spread) / maxDelay;
    });

    const fillDuration = getPositiveFloat(
      section.dataset.stFillDuration,
      getPositiveFloat(config.fillDuration, DEFAULT_CONFIG.fillDuration),
    );

    const timeline = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: {
        trigger: section,
        start: "bottom bottom+=20%",
        end: () => `+=${Math.max(layer.offsetHeight, 1)}`,
        scrub: 1,
        invalidateOnRefresh: true,
      },
    });

    timeline.to(
      cells,
      {
        duration: fillDuration,
        opacity: 1,
        stagger: (index: number) => cellDelays[index],
      },
      0,
    );
  });
}
