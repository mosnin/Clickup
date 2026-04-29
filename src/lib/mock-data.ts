// Static placeholder data used by the dashboard until Convex queries are
// wired in. Once `npx convex dev` has been run and `convex/_generated/api`
// exists, replace each `getMock*` call site with the corresponding
// `useQuery(api.*)` hook.

export type MockSpace = {
  id: string;
  name: string;
  color: string;
};

export type MockWorkspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  spaces: MockSpace[];
};

export const mockPersonalSpaces: MockSpace[] = [
  { id: "personal-default", name: "Personal", color: "#6366f1" },
];

export const mockTeamWorkspaces: MockWorkspace[] = [
  {
    id: "ws-acme",
    name: "Acme Inc.",
    role: "owner",
    spaces: [
      { id: "ws-acme-product", name: "Product", color: "#10b981" },
      { id: "ws-acme-design", name: "Design", color: "#f59e0b" },
    ],
  },
];
