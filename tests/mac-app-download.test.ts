import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/download/mac/route";
import {
  MAC_APP_DOWNLOAD_PATH,
  resolveMacAppDownloadUrl,
} from "@/lib/mac-app";

describe("Mac app download boundary", () => {
  const originalDownloadUrl = process.env.OPERATE_MAC_APP_DOWNLOAD_URL;

  afterEach(() => {
    if (originalDownloadUrl === undefined) {
      delete process.env.OPERATE_MAC_APP_DOWNLOAD_URL;
    } else {
      process.env.OPERATE_MAC_APP_DOWNLOAD_URL = originalDownloadUrl;
    }
  });

  it("keeps the public button on a stable same-origin route", () => {
    expect(MAC_APP_DOWNLOAD_PATH).toBe("/download/mac");
  });

  it("accepts only credential-free HTTPS artifact URLs", () => {
    expect(
      resolveMacAppDownloadUrl(
        "https://releases.operate.to/operate.to-1.0.0.dmg?signature=ok",
      )?.hostname,
    ).toBe("releases.operate.to");
    expect(resolveMacAppDownloadUrl("http://releases.operate.to/app.dmg")).toBeNull();
    expect(resolveMacAppDownloadUrl("https://user:pass@example.com/app.dmg")).toBeNull();
    expect(resolveMacAppDownloadUrl("https://example.com/app.dmg#unsafe")).toBeNull();
    expect(resolveMacAppDownloadUrl(undefined)).toBeNull();
  });

  it("fails closed until a signed artifact URL is configured", async () => {
    delete process.env.OPERATE_MAC_APP_DOWNLOAD_URL;
    const response = GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: "mac_app_unavailable",
    });
  });

  it("redirects through the stable route without caching", () => {
    process.env.OPERATE_MAC_APP_DOWNLOAD_URL =
      "https://releases.operate.to/operate.to-1.0.0.dmg";
    const response = GET();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://releases.operate.to/operate.to-1.0.0.dmg",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
