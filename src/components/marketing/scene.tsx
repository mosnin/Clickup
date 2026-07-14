// "Photographic" gradient scenes — the blurred-meadow backdrops from the
// brand reference, built from drifting radial-gradient blobs plus a film
// grain overlay so nothing reads as a flat CSS gradient. Pure server
// markup; the drift is CSS keyframes (scene-blob in globals.css).

import { cn } from "@/lib/utils";

const VARIANTS = {
  // Deep blurred meadow — hero and finale panels (light text on top).
  meadow: {
    base: "bg-[#232b1e]",
    blobs: [
      "left-[-20%] top-[-30%] h-[80%] w-[70%] bg-[radial-gradient(closest-side,#5f7050_0%,transparent_70%)] opacity-90",
      "right-[-15%] top-[5%] h-[90%] w-[65%] bg-[radial-gradient(closest-side,#8fa276_0%,transparent_70%)] opacity-60",
      "bottom-[-40%] left-[15%] h-[90%] w-[80%] bg-[radial-gradient(closest-side,#3a4630_0%,transparent_70%)] opacity-90",
      "bottom-[-10%] right-[5%] h-[50%] w-[40%] bg-[radial-gradient(closest-side,#c2cfae_0%,transparent_70%)] opacity-25",
    ],
  },
  // Morning haze — light panels (dark text on top).
  haze: {
    base: "bg-[#eef0e6]",
    blobs: [
      "left-[-15%] top-[-20%] h-[70%] w-[60%] bg-[radial-gradient(closest-side,#dbe2cf_0%,transparent_70%)] opacity-90",
      "right-[-20%] top-[10%] h-[80%] w-[65%] bg-[radial-gradient(closest-side,#c2cfae_0%,transparent_70%)] opacity-70",
      "bottom-[-30%] left-[20%] h-[80%] w-[70%] bg-[radial-gradient(closest-side,#f5f4ee_0%,transparent_70%)] opacity-90",
    ],
  },
  // Dusk — the governance/dark sections (near-black green).
  dusk: {
    base: "bg-[#141811]",
    blobs: [
      "left-[-10%] top-[-30%] h-[80%] w-[60%] bg-[radial-gradient(closest-side,#2b3426_0%,transparent_70%)] opacity-90",
      "right-[-15%] bottom-[-30%] h-[85%] w-[65%] bg-[radial-gradient(closest-side,#38442f_0%,transparent_70%)] opacity-80",
      "left-[30%] top-[30%] h-[50%] w-[45%] bg-[radial-gradient(closest-side,#5f7050_0%,transparent_70%)] opacity-25",
    ],
  },
} as const;

export type SceneVariant = keyof typeof VARIANTS;

// Absolute-fill backdrop. Parent must be relative + overflow-hidden;
// content sits above via z-10.
export function Scene({
  variant = "meadow",
  className,
}: {
  variant?: SceneVariant;
  className?: string;
}) {
  const v = VARIANTS[variant];
  return (
    <div
      aria-hidden
      className={cn("grain absolute inset-0 overflow-hidden", v.base, className)}
    >
      {v.blobs.map((blob, i) => (
        <div
          key={i}
          className={cn("scene-blob absolute rounded-full blur-3xl", blob)}
        />
      ))}
    </div>
  );
}
