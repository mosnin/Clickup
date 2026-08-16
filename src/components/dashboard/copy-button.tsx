"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion } from "@/components/motion";
import { SPRING_SWAP } from "@/lib/motion-tokens";
import { uiSound } from "@/lib/sound";
import { cn } from "@/lib/utils";

// The Amicro copy morph: pressing Copy crossfades the glyph to a check
// inside a fixed box (so nothing reflows), answers with the double-tick
// sound, and reverts on its own — the "did that work?" moment every copy
// button otherwise leaves hanging. One component so agent keys, connect
// snippets and anything else copied all confirm identically.

export function CopyButton({
  value,
  label,
  className,
  iconClassName = "h-3.5 w-3.5",
}: {
  value: string;
  /** Visible label; omit for an icon-only button (aria-label still set). */
  label?: string;
  className?: string;
  iconClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      aria-label={label ?? "Copy"}
      title={label ?? "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        uiSound("copy");
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      }}
      className={className}
    >
      <span
        className="relative inline-flex items-center justify-center"
        style={{ width: "1em", height: "1em" }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "check" : "copy"}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={SPRING_SWAP}
            className="inline-flex"
          >
            {copied ? (
              <Check className={cn(iconClassName, "text-positive")} />
            ) : (
              <Copy className={iconClassName} />
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </button>
  );
}
