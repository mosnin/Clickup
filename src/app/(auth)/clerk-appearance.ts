import type { SignIn } from "@clerk/nextjs";
import type { ComponentProps } from "react";

// One appearance for both auth widgets: a charcoal card with warm-accent
// primary actions, matching the marketing shell (literal hexes — the
// warm-remapped --color-azure-* tokens only exist inside .marketing-shell,
// which is why the old config rendered Clerk's stock blue).
export const authAppearance: ComponentProps<typeof SignIn>["appearance"] = {
  variables: {
    colorPrimary: "#ff7a45",
    colorText: "#f5f5f5",
    colorTextSecondary: "rgba(255,255,255,0.62)",
    colorBackground: "#161616",
    colorInputBackground: "#0e0e0e",
    colorInputText: "#f5f5f5",
    colorNeutral: "#f5f5f5",
    colorDanger: "#f87171",
    borderRadius: "0.75rem",
    fontSize: "0.9375rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-2xl ring-1 ring-white/10",
    card: "bg-[#161616]",
    headerTitle: "text-white",
    headerSubtitle: "text-white/60",
    socialButtonsBlockButton:
      "border border-white/12 bg-white/[0.04] text-white hover:bg-white/[0.08]",
    dividerLine: "bg-white/10",
    dividerText: "text-white/40",
    formFieldLabel: "text-white/80",
    formFieldInput: "border-white/12 focus:border-[#ff9d5c]",
    formButtonPrimary:
      "bg-gradient-to-r from-[#ff9d5c] to-[#ff7a45] text-[#1a0d05] shadow-none transition-opacity hover:opacity-90",
    footerActionText: "text-white/60",
    footerActionLink: "text-[#ffb27d] hover:text-[#ffc79b]",
    identityPreview: "border-white/12 bg-white/[0.04]",
    identityPreviewText: "text-white/80",
    otpCodeFieldInput: "border-white/15 text-white",
  },
};
