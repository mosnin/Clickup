import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type AnnotationProfile = "openai" | "anthropic";

const ANTHROPIC_DIRECTORY_EXCLUDED_TOOLS = new Set([
  // Anthropic's Software Directory Policy does not accept software that
  // initiates or executes cryptocurrency/financial transactions. Claude can
  // still inspect wallet state with get_wallet, while payment initiation and
  // settlement remain available on OpenAI and custom MCP connections.
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
    profile === "anthropic" && ANTHROPIC_DIRECTORY_EXCLUDED_TOOLS.has(name)
  );
}

export function toolDescriptionForProfile(
  name: string,
  description: string,
  profile: AnnotationProfile,
): string {
  if (profile === "anthropic" && name === "get_wallet") {
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
