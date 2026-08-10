"use client";

export function FrostedWord({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`relative inline-block ${className}`}>
      {}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-[1] h-[130px] w-[540px] max-w-[130%] -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            "radial-gradient(ellipse 100% 100% at 50% 50%, var(--bg-page) 0%, transparent 70%)",
          filter: "blur(30px)",
        }}
      />
      {}
      <span
        className="relative inline-block"
        style={{ transform: "translateX(-1px) translateY(-2px) rotate(-1deg)" }}
      >
        {}
        <span
          aria-hidden
          className="absolute inset-0 text-[var(--text-primary)] opacity-[0.14]"
          style={{ filter: "blur(9px)" }}
        >
          {children}
        </span>
        {/* deep chromatic twin: a further, softer offset in the opposite direction
            from the near twin — a second refraction plane for more depth */}
        <span
          aria-hidden
          className="absolute inset-0 text-[var(--text-primary)] opacity-[0.16]"
          style={{
            transform: "translate(-1.5px, 3px)",
            filter: "blur(5px)",
            maskImage: "linear-gradient(186deg, transparent 20%, black 100%)",
            WebkitMaskImage: "linear-gradient(186deg, transparent 20%, black 100%)",
          }}
        >
          {children}
        </span>
        {}
        <span
          className="relative z-10"
          style={{
            maskImage:
              "linear-gradient(186deg, black 0%, black 40%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(186deg, black 0%, black 40%, transparent 100%)",
          }}
        >
          {children}
        </span>
        {/* blurred layer: fades in toward the bottom */}
        <span
          aria-hidden
          className="absolute inset-0"
          style={{
            filter: "blur(2px)",
            maskImage:
              "linear-gradient(186deg, transparent 0%, black 60%, black 100%)",
            WebkitMaskImage:
              "linear-gradient(186deg, transparent 0%, black 60%, black 100%)",
          }}
        >
          {children}
        </span>
        {}
        <span
          aria-hidden
          className="absolute inset-0 text-[var(--text-primary)] opacity-[0.28]"
          style={{
            transform: "translate(1.5px, 2px)",
            filter: "blur(3.5px)",
            maskImage: "linear-gradient(186deg, transparent 30%, black 100%)",
            WebkitMaskImage: "linear-gradient(186deg, transparent 30%, black 100%)",
          }}
        >
          {children}
        </span>
        {/* top sheen: a bright specular highlight only on the upper third */}
        <span
          aria-hidden
          className="absolute inset-0 opacity-70"
          style={{
            color: "rgba(255,255,255,0.9)",
            maskImage: "linear-gradient(180deg, black 0%, transparent 30%)",
            WebkitMaskImage: "linear-gradient(180deg, black 0%, transparent 30%)",
          }}
        >
          {children}
        </span>
        {}
        <span
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            inset: "-4px -8px",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.14) 38%, rgba(255,255,255,0.08) 62%, rgba(255,255,255,0.24) 100%)",
            border: "1px solid rgba(0,0,0,0.06)",
            borderTopColor: "rgba(255,255,255,0.75)",
            borderRadius: "10px",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 1px rgba(0,0,0,0.05), inset 0 0 0 3px rgba(255,255,255,0.14), inset 0 0 0 4px rgba(0,0,0,0.045), inset 0 8px 16px rgba(255,255,255,0.18), 0 1px 3px rgba(0,0,0,0.07), 0 6px 16px rgba(0,0,0,0.07)",
          }}
        />
        {}
        <span
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            inset: "-4px -8px",
            borderRadius: "10px",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.7), transparent 12%)",
            mixBlendMode: "overlay",
          }}
        />
      </span>
    </span>
  );
}
