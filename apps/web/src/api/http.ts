/**
 * Fetch wrapper for the private web-app API (same origin, cookie session).
 * Errors come back as `{ error: { code, message } }` and are thrown as
 * `ApiError`. Writes are always JSON: the API refuses anything else (CSRF).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Details for the translated text (`{ error: { params } }`), e.g. who can't see a range. */
  readonly params?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, params?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (params) this.params = params;
  }
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: Method;
  json?: unknown;
  query?: Record<string, string | number | undefined | null>;
}

export function createRequester(fetchImpl: FetchLike = (input, init) => fetch(input, init), base = "") {
  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? (options.json === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { accept: "application/json" };
    const hasBody = method !== "GET" && method !== "DELETE";
    if (hasBody) headers["content-type"] = "application/json";
    let url = base + path;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) if (v !== undefined && v !== null) params.set(k, String(v));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const res = await fetchImpl(url, {
      method,
      headers,
      credentials: "same-origin",
      body: hasBody ? JSON.stringify(options.json ?? {}) : undefined,
    });
    return parseResponse<T>(res);
  };
}

/** JSON body, or `ApiError` from `{ error: { code, message } }`. */
async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const error = (
      data as { error?: { code?: string; message?: string; params?: Record<string, unknown> } } | undefined
    )?.error;
    throw new ApiError(
      res.status,
      error?.code ?? `http_${res.status}`,
      error?.message ?? (res.statusText || `HTTP ${res.status}`),
      error?.params && typeof error.params === "object" ? error.params : undefined,
    );
  }
  return data as T;
}

export type Requester = ReturnType<typeof createRequester>;

/**
 * Multipart uploads (only the Drive's two file routes accept them) and raw
 * downloads (file previews). Same origin and cookie as the JSON requests.
 */
export function createFileRequester(fetchImpl: FetchLike = (input, init) => fetch(input, init), base = "") {
  return {
    /** `POST` a form; the browser sets the multipart boundary. */
    async upload<T>(path: string, form: FormData): Promise<T> {
      const res = await fetchImpl(base + path, {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        body: form,
      });
      return parseResponse<T>(res);
    },
    /** The bytes of a download. */
    async blob(path: string): Promise<Blob> {
      const res = await fetchImpl(base + path, { method: "GET", credentials: "same-origin" });
      if (!res.ok) await parseResponse<never>(res);
      return res.blob();
    },
  };
}

export const enc = encodeURIComponent;
