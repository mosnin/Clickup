import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  addEventListener("popstate", callback);
  return () => removeEventListener("popstate", callback);
}

function locationSnapshot() {
  return `${location.pathname}${location.search}${location.hash}`;
}

function go(href: string, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePathname() {
  useSyncExternalStore(subscribe, locationSnapshot);
  return location.pathname;
}

export function useSearchParams() {
  useSyncExternalStore(subscribe, locationSnapshot);
  return new URLSearchParams(location.search);
}

export function useParams<T extends Record<string, string>>() {
  return {} as T;
}

export function useRouter() {
  useSyncExternalStore(subscribe, locationSnapshot);
  return {
    push: (href: string, _options?: { scroll?: boolean }) => go(href),
    replace: (href: string, _options?: { scroll?: boolean }) => go(href, true),
    back: () => history.back(),
    forward: () => history.forward(),
    refresh: () => dispatchEvent(new PopStateEvent("popstate")),
    prefetch: async () => undefined,
  };
}

export function redirect(href: string): never {
  go(href, true);
  throw new Error(`redirect:${href}`);
}

export const permanentRedirect = redirect;
