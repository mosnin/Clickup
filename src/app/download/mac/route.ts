import { NextResponse } from "next/server";
import { resolveMacAppDownloadUrl } from "@/lib/mac-app";

export const dynamic = "force-dynamic";

export function GET() {
  const download = resolveMacAppDownloadUrl(
    process.env.OPERATE_MAC_APP_DOWNLOAD_URL,
  );

  if (!download) {
    return NextResponse.json(
      {
        error: "mac_app_unavailable",
        message: "The signed Mac app is not available for download yet.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "3600",
        },
      },
    );
  }

  const response = NextResponse.redirect(download, 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
