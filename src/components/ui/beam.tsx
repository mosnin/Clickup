"use client";

// Client boundary for the vetted `border-beam` npm package — it drives the
// glow with hooks, and shared primitives (marketing/ui.tsx) also render in
// server components, so the client directive lives here instead of there.
export { BorderBeam } from "border-beam";
