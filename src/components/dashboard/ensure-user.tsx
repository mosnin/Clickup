"use client";

import { useEffect } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";

// Bootstrap the current user record + personal space the first time the
// dashboard loads. Idempotent on the server side.
export function EnsureUser() {
  const { isAuthenticated } = useConvexAuth();
  const ensureCurrent = useMutation(api.users.ensureCurrent);

  useEffect(() => {
    if (!isAuthenticated) return;
    ensureCurrent({}).catch(() => {
      // Server-side log will surface the failure — the next render will retry.
    });
  }, [isAuthenticated, ensureCurrent]);

  return null;
}
