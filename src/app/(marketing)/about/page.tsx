import { permanentRedirect } from "next/navigation";

// The about page moved to /company with the marketing rebrand.
export default function AboutPage() {
  permanentRedirect("/company");
}
