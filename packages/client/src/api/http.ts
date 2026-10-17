/**
 * Fetch wrapper for the private app API. The web app calls it on the same
 * origin with its cookie session; the phone app passes `baseUrl` and sends its
 * own session headers (`headers`). Errors come back as
 * `{ error: { code, message } }` and are thrown as `ApiError`. Writes are
 * always JSON: the API refuses anything else (CSRF).
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

/** Headers added to every request (the phone app's session cookie and client marker). */
export type HeadersSource = () => Record<string, string> | Promise<Record<string, string>>;

/** Where requests go and how. Defaults: same origin, the global `fetch`, the browser's cookie. */
export interface TransportOptions {
  /** e.g. "https://agentes.chat" (no trailing slash needed); "" or absent = same origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  headers?: HeadersSource;
}

interface Transport {
  fetch: FetchLike;
  base: string;
  /** Same origin sends the browser cookie; another origin sends only what `headers` gives. */
  credentials: "omit" | "same-origin";
  /** The caller's headers; absent on the web (no extra tick before `fetch`). */
  headers?: HeadersSource;
}

function transport(options: TransportOptions): Transport {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  return {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    base,
    credentials: base ? "omit" : "same-origin",
    headers: options.headers,
  };
}

export function createRequester(options: TransportOptions = {}) {
  const t = transport(options);
  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? (options.json === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {
      ...(t.headers ? await t.headers() : {}),
      accept: "application/json",
    };
    const hasBody = method !== "GET" && method !== "DELETE";
    if (hasBody) headers["content-type"] = "application/json";
    let url = t.base + path;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) if (v !== undefined && v !== null) params.set(k, String(v));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const res = await t.fetch(url, {
      method,
      headers,
      credentials: t.credentials,
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
 * downloads (file previews). Same origin, cookie and headers as the JSON requests.
 */
export function createFileRequester(options: TransportOptions = {}) {
  const t = transport(options);
  return {
    /** `POST` a form; the platform sets the multipart boundary. */
    async upload<T>(path: string, form: FormData): Promise<T> {
      const res = await t.fetch(t.base + path, {
        method: "POST",
        headers: { ...(t.headers ? await t.headers() : {}), accept: "application/json" },
        credentials: t.credentials,
        body: form,
      });
      return parseResponse<T>(res);
    },
    /** The bytes of a download. */
    async blob(path: string): Promise<Blob> {
      const res = await t.fetch(t.base + path, {
        method: "GET",
        headers: t.headers ? await t.headers() : {},
        credentials: t.credentials,
      });
      if (!res.ok) await parseResponse<never>(res);
      return res.blob();
    },
  };
}

export const enc = encodeURIComponent;
