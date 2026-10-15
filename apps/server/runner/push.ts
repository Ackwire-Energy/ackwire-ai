import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { MachineReplies } from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import { resolveInWorkspace } from "./paths";
import { zipFolder } from "./zip";

export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const TYPES: Record<string, string> = {
  zip: "application/zip",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  gz: "application/gzip",
  tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The upload's content type, from the file name's extension. */
export function contentTypeFor(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PushOptions {
  workspaceReal: string;
  token: string;
  path: string;
  url: string;
  uploadId: string;
  maxBytes: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** What the upload's error body says, for people. */
async function serverMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof body.error === "object" && typeof body.error?.message === "string") return body.error.message;
    if (typeof body.error === "string") return body.error;
    if (typeof body.message === "string") return body.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 500) || `HTTP ${res.status}`;
}

/**
 * Sends a file (or a folder, zipped in memory) straight to our upload URL.
 * The bytes never pass through the WebSocket or the model.
 */
export async function pushPath(opts: PushOptions): Promise<MachineReplies["push"]> {
  if (!/^https?:\/\//i.test(opts.url)) throw new RunnerError("bad_request", "The upload URL must be http(s)");
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes));
  const target = await resolveInWorkspace(opts.workspaceReal, opts.path);
  if (!target.exists) throw new RunnerError("not_found", `${opts.path} doesn't exist`);
  const st = await stat(target.abs);
  let bytes: Uint8Array;
  let name: string;
  if (st.isDirectory()) {
    const folder = target.rel === "" ? path.basename(opts.workspaceReal) : (target.rel.split("/").pop() as string);
    name = `${folder || "workspace"}.zip`;
    bytes = await zipFolder(target.abs, { prefix: folder || "workspace", maxBytes, workspaceReal: opts.workspaceReal });
  } else if (st.isFile()) {
    if (st.size > maxBytes) throw new RunnerError("too_large", `The file has ${st.size} bytes (max ${maxBytes})`);
    name = path.basename(target.rel);
    bytes = await readFile(target.abs);
    if (bytes.byteLength > maxBytes) throw new RunnerError("too_large", `The file is larger than ${maxBytes} bytes`);
  } else {
    throw new RunnerError("bad_request", `${opts.path} is not a file or folder`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contentType = contentTypeFor(name);
  const signals = [AbortSignal.timeout(UPLOAD_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await doFetch(opts.url, {
      method: "PUT",
      body: bytes as unknown as RequestInit["body"],
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": contentType,
        "x-agentes-file-name": encodeURIComponent(name),
        "x-agentes-sha256": sha256,
        "x-agentes-upload-id": opts.uploadId,
      },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new RunnerError("internal", "Canceled");
    const message = err instanceof Error ? err.message : String(err);
    throw new RunnerError("upload_failed", `The upload failed: ${message}`);
  }
  if (!res.ok) throw new RunnerError("upload_failed", await serverMessage(res));
  await res.body?.cancel().catch(() => {});
  return { name, size: bytes.byteLength, sha256, contentType };
}
