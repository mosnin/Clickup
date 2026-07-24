"use client";

import { useEffect } from "react";
import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";

// react-bits Counter (JS-CSS variant), vendored — rolling odometer digits
// driven by springs, same API as the source (value / places / fontSize /
// padding / gap / textColor / fontWeight / digitPlaceHolders). Tailored to
// this design system: textColor defaults to currentColor so tiles keep
// their ink (including danger tints), no baked-in background or gradient
// masks, and reduced-motion users get instant jumps instead of rolls.
// Styles live in globals.css under `.counter-*`.

function NumberRoll({
  mv,
  number,
  height,
}: {
  mv: MotionValue<number>;
  number: number;
  height: number;
}) {
  const y = useTransform(mv, (latest) => {
    const placeValue = latest % 10;
    const offset = (10 + number - placeValue) % 10;
    let memo = offset * height;
    if (offset > 5) memo -= 10 * height;
    return memo;
  });
  return (
    <motion.span className="counter-number" style={{ y }}>
      {number}
    </motion.span>
  );
}

function Digit({
  place,
  value,
  height,
}: {
  place: number;
  value: number;
  height: number;
}) {
  const valueRoundedToPlace = Math.floor(value / place);
  const reduced = useReducedMotion();
  const animatedValue = useSpring(valueRoundedToPlace, {
    stiffness: 260,
    damping: 32,
  });
  useEffect(() => {
    if (reduced) animatedValue.jump(valueRoundedToPlace);
    else animatedValue.set(valueRoundedToPlace);
  }, [animatedValue, valueRoundedToPlace, reduced]);
  return (
    <div className="counter-digit" style={{ height }}>
      {Array.from({ length: 10 }, (_, i) => (
        <NumberRoll key={i} mv={animatedValue} number={i} height={height} />
      ))}
    </div>
  );
}

/** Digit places covering `value` (e.g. 128 → [100, 10, 1]). */
export function placesFor(value: number): number[] {
  const digits = Math.max(1, String(Math.max(0, Math.floor(value))).length);
  return Array.from({ length: digits }, (_, i) => 10 ** (digits - 1 - i));
}

export default function Counter({
  value,
  places = [100, 10, 1],
  fontSize = 80,
  padding = 5,
  gap = 10,
  textColor = "currentColor",
  fontWeight = 900,
  digitPlaceHolders = false,
}: {
  value: number;
  places?: number[];
  fontSize?: number;
  padding?: number;
  gap?: number;
  textColor?: string;
  fontWeight?: number | string;
  digitPlaceHolders?: boolean;
}) {
  const height = fontSize + padding;
  // Without placeholders, leading zero-places drop off so 7 renders as
  // "7", not "007".
  const visiblePlaces = digitPlaceHolders
    ? places
    : places.filter((p) => p <= Math.max(1, 10 ** (String(Math.max(0, Math.floor(value))).length - 1)));
  return (
    <span
      className="counter-container"
      style={{ gap, color: textColor, fontWeight, fontSize }}
    >
      <span className="counter-counter" style={{ height }}>
        {visiblePlaces.map((place) => (
          <Digit key={place} place={place} value={value} height={height} />
        ))}
      </span>
    </span>
  );
}
