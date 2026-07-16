"use client";

import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import type { FaultyTerminalProps } from "@/components/faulty-terminal";

// The one sanctioned way to use FaultyTerminal in the product: a dark
// "machine" panel with the glyph field glowing dimly behind the content.
// Dynamic-imported so the WebGL bundle (ogl + shaders) only ships on
// routes that actually render one.

const FaultyTerminal = dynamic(() => import("@/components/faulty-terminal"), {
  ssr: false,
});

export function TerminalSurface({
  children,
  className,
  contentClassName,
  tint = "#7da8ff",
  brightness = 0.55,
  intensity = "calm",
}: {
  children?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** Glyph tint; defaults to the brand's pastel-blue lifted for dark. */
  tint?: string;
  brightness?: number;
  /** calm = ambient backdrop; live = a touch more motion for hero moments. */
  intensity?: "calm" | "live";
} & Pick<FaultyTerminalProps, "tint" | "brightness">) {
  const live = intensity === "live";
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-[#0b0b0d] text-white",
        className,
      )}
    >
      <div className="absolute inset-0 opacity-60">
        <FaultyTerminal
          scale={1.4}
          gridMul={[2, 1]}
          digitSize={1.4}
          timeScale={live ? 0.45 : 0.25}
          scanlineIntensity={live ? 0.5 : 0.3}
          glitchAmount={live ? 1 : 0.6}
          flickerAmount={live ? 0.8 : 0.5}
          noiseAmp={0.9}
          curvature={0.12}
          tint={tint}
          mouseReact={live}
          mouseStrength={0.15}
          pageLoadAnimation
          brightness={brightness}
        />
      </div>
      {/* Legibility scrim: content always floats above a quiet center. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(11_11_13/0.72)_0%,rgb(11_11_13/0.35)_60%,rgb(11_11_13/0.15)_100%)]"
      />
      {children !== undefined && (
        <div className={cn("relative", contentClassName)}>{children}</div>
      )}
    </div>
  );
}
