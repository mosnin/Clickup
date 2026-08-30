import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const cursorPart = z.string().min(1).max(1_024);

const snapshotCursorSchema = z
  .object({
    v: z.literal(1),
    phase: z.enum([
      "workspace",
      "spaces",
      "projects",
      "legacy_projects",
      "space_lists",
      "project_lists",
      "folder_lists",
      "space_tasks",
      "project_tasks",
      "folder_tasks",
      "agents",
      "runs",
      "done",
    ]),
    cursor: cursorPart.nullable().optional(),
    spaceCursor: cursorPart.nullable().optional(),
    spaceId: cursorPart.optional(),
    spaceDone: z.boolean().optional(),
    projectCursor: cursorPart.nullable().optional(),
    projectId: cursorPart.optional(),
    projectDone: z.boolean().optional(),
    listCursor: cursorPart.nullable().optional(),
    listId: cursorPart.optional(),
    listDone: z.boolean().optional(),
    agentCursor: cursorPart.nullable().optional(),
    agentId: cursorPart.optional(),
    agentDone: z.boolean().optional(),
    childCursor: cursorPart.nullable().optional(),
    checkpoint: cursorPart.optional(),
  })
  .strict();

export type CompanyOsSnapshotCursor = z.infer<typeof snapshotCursorSchema>;

export function initialCompanyOsSnapshotCursor(): CompanyOsSnapshotCursor {
  return { v: 1, phase: "workspace" };
}

export function encodeCompanyOsSnapshotCursor(
  state: CompanyOsSnapshotCursor,
  binding: string,
) {
  const parsed = snapshotCursorSchema.parse(state);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8").toString(
    "base64url",
  );
  return `${payload}.${cursorSignature(payload, binding)}`;
}

export function decodeCompanyOsSnapshotCursor(
  value: string | null,
  binding: string,
): CompanyOsSnapshotCursor {
  if (!value) return initialCompanyOsSnapshotCursor();
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("cursor is invalid");
  }
  try {
    const [payload, signature] = value.split(".");
    const expected = cursorSignature(payload, binding);
    const actualBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new Error("cursor signature is invalid");
    }
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return snapshotCursorSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("cursor is invalid");
  }
}

export function companyOsSnapshotCursorBinding(accessToken: string) {
  return createHash("sha256").update(accessToken).digest("hex");
}

function cursorSignature(payload: string, binding: string) {
  const secret =
    process.env.COMPANYOS_CURSOR_SECRET?.trim() ||
    process.env.CLERK_SECRET_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("COMPANYOS_CURSOR_SECRET is not configured");
  }
  return createHmac("sha256", secret)
    .update(`companyos-snapshot-v1\0${binding}\0${payload}`)
    .digest("base64url");
}
