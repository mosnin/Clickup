import { query } from "./_generated/server";

// Public and deliberately content-free: Vercel, uptime monitors, and release
// automation can prove that the application can reach its system of record
// without possessing a user or agent credential.
export const ping = query({
  args: {},
  handler: async () => ({ ok: true }),
});
