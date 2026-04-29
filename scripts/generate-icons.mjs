#!/usr/bin/env node
//
// Renders public/icon.svg into PNG variants for the PWA manifest.
// Runs as a `prebuild` script, so production builds always carry fresh
// icons. If sharp isn't installed (or fails to load on this platform)
// the script logs and exits 0 — it's a non-fatal best-effort step.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SVG_PATH = path.join(ROOT, "public", "icon.svg");
const SVG_MASKABLE_PATH = path.join(ROOT, "public", "icon-maskable.svg");
const OUT_DIR = path.join(ROOT, "public");

const TARGETS = [
  { src: SVG_PATH, out: "icon-192.png", size: 192 },
  { src: SVG_PATH, out: "icon-512.png", size: 512 },
  { src: SVG_MASKABLE_PATH, out: "icon-maskable-512.png", size: 512 },
];

async function main() {
  let sharpModule;
  try {
    sharpModule = (await import("sharp")).default;
  } catch (err) {
    console.warn(
      "[icons] sharp is not available; skipping PNG generation.",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (!existsSync(SVG_PATH)) {
    console.warn(`[icons] ${SVG_PATH} missing; skipping`);
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });
  const svg = await readFile(SVG_PATH);
  const maskable = existsSync(SVG_MASKABLE_PATH)
    ? await readFile(SVG_MASKABLE_PATH)
    : svg;
  for (const target of TARGETS) {
    const buffer = target.src === SVG_MASKABLE_PATH ? maskable : svg;
    const out = path.join(OUT_DIR, target.out);
    await sharpModule(buffer)
      .resize(target.size, target.size)
      .png()
      .toFile(out);
    console.log(`[icons] wrote ${out}`);
  }
}

main().catch((err) => {
  console.warn("[icons] generation failed:", err);
});
