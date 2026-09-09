import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@clerk/nextjs", replacement: fileURLToPath(new URL("./src/shims/clerk.ts", import.meta.url)) },
      { find: "next/link", replacement: fileURLToPath(new URL("./src/shims/link.tsx", import.meta.url)) },
      { find: "next/navigation", replacement: fileURLToPath(new URL("./src/shims/navigation.ts", import.meta.url)) },
      { find: "next/dynamic", replacement: fileURLToPath(new URL("./src/shims/dynamic.tsx", import.meta.url)) },
      { find: /^@\/(.*)/, replacement: `${root}/src/$1` },
      { find: /^@convex\/(.*)/, replacement: `${root}/convex/$1` }
    ]
  },
  define: {
    "process.env.NEXT_PUBLIC_CONVEX_URL": JSON.stringify(process.env.VITE_CONVEX_URL ?? ""),
    "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify("https://www.operate.to")
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false
  }
});
