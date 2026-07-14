// Vite supplies import.meta.glob at runtime (vitest); declare it for the
// bare `tsc --noEmit` pass, which doesn't load vite/client types.
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
