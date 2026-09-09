import type { AnchorHTMLAttributes, MouseEvent } from "react";

type Href = string | { pathname?: string; query?: Record<string, string> };
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: Href;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean;
};

export function hrefString(href: Href): string {
  if (typeof href === "string") return href;
  const params = new URLSearchParams(href.query);
  const query = params.toString();
  return `${href.pathname ?? window.location.pathname}${query ? `?${query}` : ""}`;
}

export default function Link({ href, replace, onClick, children, ...props }: Props) {
  const target = hrefString(href);
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      props.target === "_blank" ||
      /^https?:\/\//.test(target)
    ) return;
    event.preventDefault();
    history[replace ? "replaceState" : "pushState"]({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  return <a {...props} href={target} onClick={navigate}>{children}</a>;
}
