import { ConvexError } from "convex/values";

const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function normalizeCapabilities(
  values: string[] | undefined,
  label: string,
  max = 20,
): string[] {
  if (!values) return [];
  if (values.length > max) {
    throw new ConvexError(`${label} is capped at ${max} capabilities`);
  }
  const out: string[] = [];
  for (const raw of values) {
    const capability = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!CAPABILITY_RE.test(capability)) {
      throw new ConvexError(
        `${label} entries must be 1-40 lowercase letters, numbers, or hyphens`,
      );
    }
    if (!out.includes(capability)) out.push(capability);
  }
  return out;
}

export function missingCapabilities(
  agentCapabilities: string[] | undefined,
  requiredCapabilities: string[] | undefined,
): string[] {
  const available = new Set(agentCapabilities ?? []);
  return (requiredCapabilities ?? []).filter(
    (capability) => !available.has(capability),
  );
}

export function hasCapabilities(
  agentCapabilities: string[] | undefined,
  requiredCapabilities: string[] | undefined,
): boolean {
  return missingCapabilities(agentCapabilities, requiredCapabilities).length === 0;
}
