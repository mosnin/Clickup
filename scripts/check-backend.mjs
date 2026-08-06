// Refuse to build a frontend against a dead backend.
//
// This exists because it happened: production was built with
// NEXT_PUBLIC_CONVEX_URL pointing at a Convex deployment that had been
// deleted, the build succeeded, the deploy succeeded, and the live site spent
// days as an app whose every query 404'd — with real users on it and nothing
// anywhere saying why. A URL that answers is the one precondition a build of
// this app has that a compiler cannot check, so it is checked here.
//
// Rules:
// - No URL configured (env or .env files) → skip quietly. `convex deploy
//   --cmd 'next build'` injects the right URL itself, and a bare local build
//   without a backend is legitimate.
// - URL configured and answering → proceed.
// - URL configured and NOT answering → FAIL THE BUILD. A failed deploy is an
//   email; a deployed dead frontend is an outage nobody is told about.
// - Escape hatch for deliberate offline builds: MISSING_BACKEND_OK=1.
import { readFileSync, existsSync } from "node:fs";

function fromEnvFiles() {
  for (const file of [".env.local", ".env.production", ".env"]) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith("NEXT_PUBLIC_CONVEX_URL="));
    if (line) return line.slice("NEXT_PUBLIC_CONVEX_URL=".length).trim();
  }
  return undefined;
}

const url = process.env.NEXT_PUBLIC_CONVEX_URL || fromEnvFiles();

if (!url) {
  console.log("check-backend: NEXT_PUBLIC_CONVEX_URL not set — skipping.");
  process.exit(0);
}
if (process.env.MISSING_BACKEND_OK === "1") {
  console.log("check-backend: MISSING_BACKEND_OK=1 — skipping.");
  process.exit(0);
}

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  // A live Convex deployment answers its root with 200. A deleted one 404s.
  if (!res.ok) {
    console.error(
      `check-backend: ${url} answered HTTP ${res.status}. Refusing to build a ` +
        `frontend wired to a backend that is not there — fix ` +
        `NEXT_PUBLIC_CONVEX_URL in the hosting environment (or set ` +
        `MISSING_BACKEND_OK=1 for a deliberate offline build).`,
    );
    process.exit(1);
  }
  console.log(`check-backend: ${url} is alive.`);
} catch (err) {
  console.error(
    `check-backend: could not reach ${url} (${err?.cause?.code ?? err}). ` +
      `Refusing to build against an unreachable backend — set ` +
      `MISSING_BACKEND_OK=1 only if this is a deliberate offline build.`,
  );
  process.exit(1);
}
