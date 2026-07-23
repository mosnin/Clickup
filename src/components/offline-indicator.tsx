"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

// Tiny offline pill. Subscribes to the browser's online/offline events
// so it auto-recovers when the connection comes back. Convex's React
// client already queues mutations while offline and replays them on
// reconnect, so the only thing the user needs to know is "your changes
// will sync".
export function OfflineIndicator() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setOnline(navigator.onLine);
    }
    function on() {
      setOnline(true);
    }
    function off() {
      setOnline(false);
    }
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground px-3 py-1.5 text-xs text-background shadow-lg"
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden />
      You&apos;re offline, changes will sync when you reconnect.
    </div>
  );
}
