import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next 308s `/oauth/token/` → `/oauth/token` and many OAuth clients
  // drop the POST body. Middleware rewrites those paths instead; this
  // stops Next from issuing the 308 after `next()`.
  skipTrailingSlashRedirect: true,
  outputFileTracingIncludes: {
    "/skills/operate/*": ["./plugins/operate/skills/**"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "images.clerk.dev" },
    ],
  },
};

export default withSerwist(nextConfig);
