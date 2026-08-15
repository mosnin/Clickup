"use client";

import { useEffect } from "react";

// Replaces the root layout when that layout itself throws. Must define its
// own <html>/<body> — nothing above this file can recover.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application failed to load", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#131316",
          color: "#f7f7f8",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <main style={{ maxWidth: 22 * 16, padding: 24, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            This page hit a problem
          </p>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 14,
              lineHeight: 1.5,
              color: "rgba(247,247,248,0.64)",
            }}
          >
            Your work is safe. Try loading it again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              border: 0,
              borderRadius: 9999,
              padding: "10px 16px",
              background: "#f7f7f8",
              color: "#131316",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
