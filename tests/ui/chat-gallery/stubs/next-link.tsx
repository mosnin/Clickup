// `next/link` outside a Next app has no router to push to; the gallery only
// needs the anchor, and needs it not to navigate away from the shot.
import * as React from "react";

export default function Link({
  href,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} onClick={(e) => e.preventDefault()} {...rest}>
      {children}
    </a>
  );
}
