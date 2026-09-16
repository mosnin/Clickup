"use client";

import gsap from "gsap";
import { RUNTIMES } from "@/lib/marketing-content";
import { useGsap } from "@/components/marketing/gsap";
import { IllustrationFrame } from "./frame";

// ConnectOrbit — "bring the agent you already use".
//
// The one thing a screenshot cannot show: every runtime in the wild reaching
// the same endpoint. A shot of the connect panel proves the key exists; it
// does not answer the question the reader actually has, which is "does it
// work with mine". So the runtimes orbit, the endpoint sits still in the
// middle, and the answer arrives before the sentence under it is read.
//
// Drawn entirely from theme tokens — mk-panel surfaces, the azure ramp,
// white/[0.0x] hairlines — so the marketing scope's palette flip reaches it
// for free and there is no hex to drift out of sync with the rest of the site.

// Two rings so nine marks never crowd one circle. Positions are computed from
// constants at module scope, never at render: a random or Date-seeded layout
// would differ between the server and the client and hydrate as a jump.
// The centre IS the MCP endpoint, so the protocol's own mark is excluded:
// a protocol orbiting itself says nothing, and under `invert` it draws as a
// blank white tile that reads as a missing asset.
const CLIENTS = RUNTIMES.filter((r) => r.name !== "MCP");

const RINGS = [
  { radius: 30, items: CLIENTS.slice(0, 4), spin: 48, size: "size-8 sm:size-11" },
  { radius: 41, items: CLIENTS.slice(4), spin: 76, size: "size-7 sm:size-10" },
] as const;

/** Polar → percentage offsets inside the square orbit field. */
function place(index: number, count: number, radius: number) {
  // -90deg so the first mark sits at twelve o'clock rather than three.
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
  return {
    left: `${50 + Math.cos(angle) * radius}%`,
    top: `${50 + Math.sin(angle) * radius}%`,
  };
}

export function ConnectOrbit({ caption }: { caption?: string }) {
  const ref = useGsap(({ root }) => {
    // Each ring turns; every mark counter-turns at the same rate so the logos
    // stay upright instead of tumbling. Both tweens are linear and share a
    // duration, so they cannot drift apart over a long session.
    RINGS.forEach((ring, i) => {
      const spinner = root.querySelector<HTMLElement>(`[data-ring="${i}"]`);
      const marks = root.querySelectorAll<HTMLElement>(`[data-ring-mark="${i}"]`);
      if (!spinner) return;
      // Alternate direction: two rings turning the same way read as one
      // sluggish disc rather than as motion.
      const dir = i % 2 === 0 ? 1 : -1;
      gsap.to(spinner, {
        rotation: 360 * dir,
        duration: ring.spin,
        ease: "none",
        repeat: -1,
      });
      gsap.to(marks, {
        rotation: -360 * dir,
        duration: ring.spin,
        ease: "none",
        repeat: -1,
      });
    });

    // A signal running inward along the hairlines — the endpoint receiving
    // work, not just sitting there. Staggered so it reads as independent
    // clients rather than a synchronised pulse.
    gsap.fromTo(
      root.querySelectorAll("[data-spoke]"),
      { opacity: 0.05 },
      {
        opacity: 0.4,
        duration: 1.4,
        ease: "sine.inOut",
        stagger: { each: 0.5, repeat: -1, yoyo: true },
        repeat: -1,
        yoyo: true,
      },
    );
  });

  return (
    <IllustrationFrame
      // Taller on a phone so the square orbit field has room; the marks
      // otherwise crowd the endpoint and the label collides with a logo.
      ratioClass="aspect-square sm:aspect-[16/10]"
      caption={caption}
    >
      {/* The orbit field is a centred square so the rings stay circular at
          every width; the frame around it stays 16/10 like the screenshots. */}
      <div ref={ref} className="absolute inset-0 grid place-items-center">
        <div className="relative aspect-square w-[94%] sm:h-[92%] sm:w-auto">
          {/* Ring guides. Pure hairlines — the structure, not decoration. */}
          {RINGS.map((ring, i) => (
            <div
              key={`guide-${i}`}
              aria-hidden
              className="absolute rounded-full ring-1 ring-inset ring-white/[0.07]"
              style={{
                inset: `${50 - ring.radius}%`,
              }}
            />
          ))}

          {RINGS.map((ring, i) => (
            <div
              key={`ring-${i}`}
              data-ring={i}
              className="absolute inset-0"
            >
              {/* Spokes live INSIDE the rotating group so each line stays
                  attached to its own mark. Drawn outside it they point at
                  where the marks used to be, which reads as a stray
                  crosshair through the middle of the frame. */}
              <svg
                aria-hidden
                viewBox="0 0 100 100"
                className="absolute inset-0 h-full w-full"
              >
                {ring.items.map((runtime, j) => {
                  const angle =
                    (j / ring.items.length) * Math.PI * 2 - Math.PI / 2;
                  return (
                    <line
                      key={runtime.name}
                      data-spoke
                      x1="50"
                      y1="50"
                      x2={50 + Math.cos(angle) * ring.radius}
                      y2={50 + Math.sin(angle) * ring.radius}
                      stroke="currentColor"
                      strokeWidth="0.35"
                      className="text-azure-400"
                      opacity="0.18"
                    />
                  );
                })}
              </svg>

              {ring.items.map((runtime, j) => (
                <div
                  key={runtime.name}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={place(j, ring.items.length, ring.radius)}
                >
                  {/* Rotation lives on this inner node so it never fights the
                      Tailwind translate utilities on the positioner above. */}
                  <div
                    data-ring-mark={i}
                    title={runtime.name}
                    className={`grid ${ring.size} place-items-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] backdrop-blur`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={runtime.src}
                      alt={runtime.name}
                      loading="lazy"
                      className={`size-4 object-contain sm:size-6 ${
                        "invert" in runtime && runtime.invert
                          ? "brightness-0 invert"
                          : ""
                      }`}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* The endpoint. Deliberately the only still thing in the frame. */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
            <div className="mk-gradient-fill grid size-11 place-items-center rounded-2xl shadow-lg sm:size-16">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/operate-icon-white.svg"
                alt="operate.to"
                className="size-5 sm:size-8"
              />
            </div>
            <div className="mt-2 font-mono text-[0.6rem] leading-none text-white/45 sm:text-[0.65rem]">
              /api/mcp
            </div>
          </div>
        </div>
      </div>
    </IllustrationFrame>
  );
}
