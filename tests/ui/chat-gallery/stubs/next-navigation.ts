// Where the gallery believes it is standing. The Chat shell derives the active
// room, the sidebar's current row and the top strip's location line from the
// pathname alone, so this one value drives all three.
export const galleryRoute = { pathname: "/chat/c/flight-path" };

export function usePathname() {
  return galleryRoute.pathname;
}
export function useRouter() {
  return { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} };
}
export function useSearchParams() {
  return new URLSearchParams();
}
export function useParams() {
  return {};
}
export function redirect() {}
export function notFound() {}
