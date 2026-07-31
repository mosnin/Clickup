// `next/link` outside a Next app has no router context to push to. The
// gallery only needs the anchor.
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
