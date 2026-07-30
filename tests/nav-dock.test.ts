import { describe, expect, it } from "vitest";
import {
  dropZoneFor,
  dropZones,
  zoneContains,
  type DropZone,
} from "../src/lib/nav-dock";

// The bug this file exists to keep dead: the rectangle drawn on screen and the
// rectangle the hit test used were computed in two places and disagreed, so
// aiming at a visible target produced a different result than the target
// promised. Every assertion here is about those two staying the same thing.

const VIEWPORTS: [number, number][] = [
  [1440, 900],
  [1280, 720],
  [1920, 1080],
  [768, 1024],
  [3440, 1440],
];

function centre(z: DropZone) {
  return { x: z.x + z.width / 2, y: z.y + z.height / 2 };
}

describe("drop zones", () => {
  it("resolves the centre of every drawn guide to that guide's zone", () => {
    for (const [w, h] of VIEWPORTS) {
      for (const zone of dropZones(w, h)) {
        const { x, y } = centre(zone);
        expect(dropZoneFor(x, y, w, h), `${zone.id} @ ${w}x${h}`).toBe(zone.id);
      }
    }
  });

  it("resolves every interior point of a guide to that guide", () => {
    for (const [w, h] of VIEWPORTS) {
      for (const zone of dropZones(w, h)) {
        // Walk a grid just inside the rectangle. A point a person can see
        // inside the dashed outline must do what the outline says.
        for (let fx = 0.05; fx <= 0.95; fx += 0.15) {
          for (let fy = 0.05; fy <= 0.95; fy += 0.15) {
            const x = zone.x + zone.width * fx;
            const y = zone.y + zone.height * fy;
            expect(
              dropZoneFor(x, y, w, h),
              `${zone.id} @ ${w}x${h} (${fx.toFixed(2)}, ${fy.toFixed(2)})`,
            ).toBe(zone.id);
          }
        }
      }
    }
  });

  it("never overlaps two zones, so a drop is never a coin flip", () => {
    for (const [w, h] of VIEWPORTS) {
      const zones = dropZones(w, h);
      for (const a of zones) {
        for (const b of zones) {
          if (a.id === b.id) continue;
          for (const corner of [
            { x: a.x, y: a.y },
            { x: a.x + a.width, y: a.y },
            { x: a.x, y: a.y + a.height },
            { x: a.x + a.width, y: a.y + a.height },
            centre(a),
          ]) {
            expect(
              zoneContains(b, corner.x, corner.y),
              `${a.id} corner inside ${b.id} @ ${w}x${h}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("treats the middle of the screen as floating — the absence of a dock", () => {
    for (const [w, h] of VIEWPORTS) {
      expect(dropZoneFor(w / 2, h / 2, w, h)).toBe("floating");
    }
  });

  it("keeps every guide on screen", () => {
    for (const [w, h] of VIEWPORTS) {
      for (const zone of dropZones(w, h)) {
        expect(zone.x, zone.id).toBeGreaterThanOrEqual(0);
        expect(zone.y, zone.id).toBeGreaterThanOrEqual(0);
        expect(zone.x + zone.width, zone.id).toBeLessThanOrEqual(w);
        expect(zone.y + zone.height, zone.id).toBeLessThanOrEqual(h);
        expect(zone.width, zone.id).toBeGreaterThan(0);
        expect(zone.height, zone.id).toBeGreaterThan(0);
      }
    }
  });

  it("offers all three docks at every size, each with a label", () => {
    for (const [w, h] of VIEWPORTS) {
      const zones = dropZones(w, h);
      expect(zones.map((z) => z.id).sort()).toEqual(["dock", "left", "right"]);
      for (const zone of zones) expect(zone.label.length).toBeGreaterThan(0);
    }
  });
});
