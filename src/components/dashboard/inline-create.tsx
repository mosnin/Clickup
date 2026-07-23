"use client";

import { useState } from "react";
import { EASE, motion } from "@/components/motion";

// In-place naming input — the replacement for window.prompt() everywhere
// something gets created from a tree or tab row (spaces, folders, lists,
// docs, boards, channels). Enter creates, Escape cancels, blurring an
// empty input cancels too so a stray click never leaves a dangling form.
export function InlineCreate({
  placeholder,
  onSubmit,
  onCancel,
  initialValue = "",
  className,
}: {
  placeholder: string;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
  initialValue?: string;
  className?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);

  async function submit() {
    const name = value.trim();
    if (!name || pending) return;
    setPending(true);
    try {
      await onSubmit(name);
    } finally {
      setPending(false);
    }
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!value.trim() && !pending) onCancel();
        }}
        placeholder={placeholder}
        className="w-full rounded-full border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
      />
    </motion.form>
  );
}
