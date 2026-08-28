// Where Chromium actually is, answered once.
//
// Every harness used to hardcode the managed container's path
// (/opt/pw-browsers/…), so on any other machine — a GitHub runner, a
// teammate's laptop — the whole browser suite failed at launch and the gates
// silently never gated. `undefined` hands the choice back to playwright-core,
// which resolves the browser `npx playwright-core install chromium` fetched.
// tests/ui/panel-fit.test.tsx carries the same fallback for the same reason.
import { existsSync } from "node:fs";

const MANAGED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/** Pass as `executablePath` to `chromium.launch()`. */
export const CHROME = existsSync(MANAGED) ? MANAGED : undefined;
