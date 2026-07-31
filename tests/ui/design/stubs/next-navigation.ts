// The route the gallery believes it is on. Several surfaces derive context
// from the URL — the sidebar picks which workspace's tree to show from it.
export const galleryRoute = { pathname: "/dashboard/l/l1" };

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
