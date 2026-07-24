import type { CSSProperties, ReactNode } from "react";

// react-bits GradientText (JS-CSS variant), vendored — same API
// (colors / animationSpeed / showBorder / className), tailored to the
// operate.to warm ramp: the default colors are the brand's amber→coral→
// rose pan with matching endpoints so the loop is seamless. The styles
// live in globals.css under `.animated-gradient-text`. Layout-neutral:
// the wrapper is inline-flex so it drops into headings mid-sentence.

const BRAND_COLORS = ["#ffd27a", "#ff9d4d", "#ff5f6d", "#ff8a3d", "#ffd27a"];

export default function GradientText({
  children,
  className = "",
  colors = BRAND_COLORS,
  animationSpeed = 8,
  showBorder = false,
}: {
  children: ReactNode;
  className?: string;
  colors?: string[];
  animationSpeed?: number;
  showBorder?: boolean;
}) {
  const gradientStyle: CSSProperties = {
    backgroundImage: `linear-gradient(to right, ${colors.join(", ")})`,
    animationDuration: `${animationSpeed}s`,
  };

  return (
    <span className={`animated-gradient-text ${className}`}>
      {showBorder && (
        <span className="gradient-overlay" style={gradientStyle}></span>
      )}
      <span className="text-content" style={gradientStyle}>
        {children}
      </span>
    </span>
  );
}
