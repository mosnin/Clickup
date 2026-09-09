export const MAC_APP_DOWNLOAD_PATH = "/download/mac";

/**
 * The public button always targets a same-origin route. The route resolves the
 * current signed artifact at request time, so rotating a release never requires
 * rebuilding the marketing site and an unsigned local build cannot be exposed
 * accidentally.
 */
export function resolveMacAppDownloadUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
