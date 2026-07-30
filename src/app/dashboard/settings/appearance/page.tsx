import { permanentRedirect } from "next/navigation";

// Appearance grew into its own section with its own navigation, so it stopped
// being a settings page. The old path still resolves — a bookmark is a promise.
export default function LegacyAppearancePage() {
  permanentRedirect("/dashboard/appearance");
}
