import type { Metadata } from "next";
import { Suspense } from "react";
import { PulseScreen } from "@/components/chat/pulse";

export const metadata: Metadata = { title: "Pulse · Chat" };

// `/chat/pulse`. The shell around it is the layout's; this route is only the
// screen that sits in the content surface.
//
// The `Suspense` boundary is not decoration: the screen reads its active tab
// from `useSearchParams`, and Next requires a boundary around that so the rest
// of the route can still be prerendered.

export default function ChatPulse() {
  return (
    <Suspense fallback={null}>
      <PulseScreen />
    </Suspense>
  );
}
