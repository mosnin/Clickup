"use client";

import { motion, MotionConfig } from "motion/react";
import { EASE } from "@/components/motion";

// Route-level page transition: every dashboard navigation re-mounts this
// template, so pages arrive with a soft rise + un-blur. MotionConfig
// makes every animation in the tree collapse for users who prefer
// reduced motion.
export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.45, ease: EASE }}
      >
        {children}
      </motion.div>
    </MotionConfig>
  );
}
