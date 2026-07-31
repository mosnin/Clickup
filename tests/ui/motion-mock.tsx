import type { ReactNode } from "react";

// One motion stand-in for every UI test.
//
// `motion` is a proxy that turns `motion.form` into `"form"`, because a mock
// listing the tags it happens to have seen breaks the moment a component uses
// a different one — which is how three suites failed with "element type is
// invalid" and nothing to do with what they were testing.
export const motion = new Proxy(
  {},
  { get: (_t, tag) => (typeof tag === "string" ? tag : "div") },
) as Record<string, string>;

export const AnimatePresence = ({ children }: { children: ReactNode }) =>
  children;
export const Stagger = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);
export const StaggerItem = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);
export const Reveal = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);
export const AnimatedNumber = ({ value }: { value: number }) => <span>{value}</span>;
export const AnimatedBar = () => <div />;
export const PresenceDot = () => <span />;
export const EASE = [0, 0, 1, 1];
export const SPRING = {};
