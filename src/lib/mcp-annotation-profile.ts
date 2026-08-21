import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type AnnotationProfile = "openai" | "chatgpt" | "anthropic";

export const DIRECTORY_EXCLUDED_TOOLS = new Set([
  // Anthropic excludes financial-transaction software, while OpenAI's plugin
  // review currently supports commerce only for physical goods. Directory
  // profiles can still inspect wallet state with get_wallet; custom MCP
  // connections retain payment initiation and settlement.
  "buy_credits",
  "settle_payment",
]);

type AnnotationFacts = {
  title: string;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
  idempotent: boolean;
};

export function toolAvailableForProfile(
  name: string,
  profile: AnnotationProfile,
): boolean {
  return !(
    (profile === "anthropic" || profile === "chatgpt") &&
    DIRECTORY_EXCLUDED_TOOLS.has(name)
  );
}

export function toolDescriptionForProfile(
  name: string,
  description: string,
  profile: AnnotationProfile,
): string {
  if (
    (profile === "anthropic" || profile === "chatgpt") &&
    name === "get_wallet"
  ) {
    return "Read the authenticated workspace wallet and billing configuration. This profile provides billing visibility only; payment initiation and settlement are unavailable.";
  }

  return description;
}

export function toolAnnotationsForProfile(
  facts: AnnotationFacts,
  profile: AnnotationProfile,
): ToolAnnotations {
  return {
    title: facts.title,
    readOnlyHint: facts.readOnly,
    openWorldHint: facts.openWorld,
    // Anthropic's directory policy treats every mutation—including creates—as
    // destructive. OpenAI reserves the hint for overwrites, removals, and
    // irreversible actions.
    destructiveHint:
      profile === "anthropic" ? !facts.readOnly : facts.destructive,
    ...(facts.idempotent ? { idempotentHint: true } : {}),
  };
}
