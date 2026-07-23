"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Download, FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { Stagger, StaggerItem } from "@/components/motion";

// Task file attachments. Bytes go straight to Convex file storage via a
// short-lived upload URL (same pattern as Clips); a metadata row then points
// at the blob. Multiple files upload in sequence with per-file error toasts.

const MAX_BYTES = 50 * 1024 * 1024;

type AttachmentRow = {
  _id: Id<"attachments">;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string | null;
};

export function Attachments({ taskId }: { taskId: Id<"tasks"> }) {
  const files = useQuery(api.attachments.listForTask, { taskId });
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl);
  const create = useMutation(api.attachments.create);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function uploadOne(file: File) {
    if (file.size > MAX_BYTES) {
      toast(`${file.name} is over the 50 MB limit`, { kind: "error" });
      return;
    }
    const uploadUrl = await generateUploadUrl({});
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const { storageId } = (await res.json()) as { storageId: string };
    await create({
      taskId,
      storageId: storageId as Id<"_storage">,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
  }

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        try {
          await uploadOne(file);
        } catch (err) {
          toast(
            err instanceof Error ? err.message : `Couldn't upload ${file.name}`,
            { kind: "error" },
          );
        }
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => onFiles(e.currentTarget.files)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <>
            <Upload className="h-3.5 w-3.5 animate-pulse" /> Uploading…
          </>
        ) : (
          <>
            <Paperclip className="h-3.5 w-3.5" /> Attach files
          </>
        )}
      </Button>

      {files === undefined ? (
        <div className="h-12 animate-pulse rounded-xl bg-muted/40" />
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attachments yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Stagger className="divide-y divide-border">
            {files.map((f) => (
              <StaggerItem key={f._id}>
                <AttachmentCard row={f} />
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCard({ row }: { row: AttachmentRow }) {
  const remove = useMutation(api.attachments.remove);
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  if (deleting) return null;

  const isImage = row.mimeType.startsWith("image/");

  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/20">
      {isImage && row.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={row.url}
          alt={row.name}
          className="h-10 w-10 flex-shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="icon-tile h-10 w-10">
          {isImage ? (
            <ImageIcon className="h-4 w-4" />
          ) : (
            <FileText className="h-4 w-4" />
          )}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
        <Badge
          variant="outline"
          className="mt-1 text-[10px] font-normal text-muted-foreground"
        >
          {formatBytes(row.sizeBytes)}
        </Badge>
      </div>

      {row.url && (
        <a
          href={row.url}
          download={row.name}
          target="_blank"
          rel="noreferrer"
          aria-label={`Download ${row.name}`}
          className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-4 w-4" />
        </a>
      )}
      <button
        type="button"
        aria-label={`Delete ${row.name}`}
        onClick={() => {
          setDeleting(true);
          toast("Attachment deleted", {
            action: { label: "Undo", onClick: () => setDeleting(false) },
            onExpire: () => {
              remove({ attachmentId: row._id }).catch((err) => {
                setDeleting(false);
                toast(
                  err instanceof Error
                    ? err.message
                    : "Couldn't delete attachment",
                  { kind: "error" },
                );
              });
            },
          });
        }}
        className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
