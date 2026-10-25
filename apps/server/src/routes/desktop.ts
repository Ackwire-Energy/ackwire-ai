import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requestIp } from "../http/client-ip";
import { apiError, errorResponse } from "../http/errors";
import { type AppDeps, json } from "./app/context";

const tags = ["Desktop app"];

/**
 * Where desktop builds live (ADR 0036 §9): GitHub Releases of a private
 * repository, read with a fine-grained token. Convention (the desktop CI
 * follows it): tag `desktop-v<semver>`; per platform a download with its
 * `.sha256` and an updater bundle with its minisign signature `.sig` (Tauri
 * updater), named as `desktopAssets` says; an optional line
 * `min-version: x.y.z` in the release body (the rest of the body is the notes).
 */
export const DESKTOP_TAG_PREFIX = "desktop-v";
const LATEST_TTL_MS = 5 * 60_000;
const GITHUB_API = "https://api.github.com";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FILE_NAME = /^[\w.-]{1,200}$/;

export interface DesktopRelease {
  version: string;
  url: string;
  sha256: string;
  notes: string;
  publishedAt: string;
  minVersion?: string;
  /** The Tauri updater bundle and its signature; absent on builds made before the updater. */
  updater?: { url: string; signature: string };
}

interface GitHubAsset {
  name: string;
  url: string;
  size?: number;
  content_type?: string;
}

interface GitHubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  published_at?: string | null;
  created_at?: string;
  assets?: GitHubAsset[];
}

export const dmgName = (version: string) => `agentes_${version}_universal.dmg`;
export const updaterName = (version: string) => `agentes_${version}_universal.app.tar.gz`;

/** The platforms the app is built for, as the Tauri updater names them (`{{target}}`). */
export type DesktopTarget = "darwin" | "windows" | "linux";

/**
 * A platform's files in a release: what a person downloads, and what the app's updater installs. Windows'
 * installer is its own updater bundle; on Linux the deb is the download (a deb updates by downloading again)
 * and the AppImage updates itself.
 */
export function desktopAssets(target: DesktopTarget, version: string): { download: string; updater: string } {
  if (target === "windows")
    return { download: `agentes_${version}_x64-setup.exe`, updater: `agentes_${version}_x64-setup.exe` };
  if (target === "linux")
    return { download: `agentes_${version}_amd64.deb`, updater: `agentes_${version}_amd64.AppImage` };
  return { download: dmgName(version), updater: updaterName(version) };
}

/** Mac architectures, as Rust (`aarch64`, `x86_64`) and Node (`arm64`, `x64`) name them. */
const MAC_ARCHES = new Set(["aarch64", "arm64", "x86_64", "x64"]);
/** Windows and Linux builds are x64 only for now. */
const X64 = new Set(["x86_64", "x64"]);

/** The query's platform when there is a build for it (one universal Mac build; x64 elsewhere). */
export function desktopTarget(target: string | undefined, arch: string | undefined): DesktopTarget | null {
  if (target === "darwin") return !arch || MAC_ARCHES.has(arch) ? "darwin" : null;
  if (target === "windows" || target === "linux") return !arch || X64.has(arch) ? target : null;
  return null;
}

/** `min-version: x.y.z` out of a release body, and the notes without that line. */
export function parseReleaseBody(body: string | null | undefined): { notes: string; minVersion?: string } {
  let minVersion: string | undefined;
  const lines = (body ?? "").split(/\r?\n/).filter((line) => {
    const m = line.match(/^\s*min-version:\s*v?(\S+)\s*$/i);
    if (!m) return true;
    if (m[1] && SEMVER.test(m[1])) minVersion = m[1];
    return false;
  });
  return { notes: lines.join("\n").trim(), ...(minVersion ? { minVersion } : {}) };
}

/** The first 64-hex word of a `.sha256` file (`shasum -a 256` writes `<hash>  <file>`). */
export function parseSha256(text: string): string | null {
  return text.match(/\b([0-9a-f]{64})\b/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * Reads releases with the token (`fetch` injectable: tests use a fake
 * GitHub). The latest answer is cached 5 minutes, per process.
 */
export function createDesktopReleases(options: {
  token: string | undefined;
  repo: string;
  publicUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const latest = new Map<DesktopTarget, { at: number; value: DesktopRelease | null }>();
  let list: { at: number; value: GitHubRelease[] } | null = null;
  const base = options.publicUrl.replace(/\/+$/, "");
  const headers = () => ({
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "agentes.chat",
  });

  async function getJson<T>(path: string): Promise<T | null> {
    const res = await http(`${GITHUB_API}${path}`, { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** An asset's bytes: GitHub redirects to a signed URL, which must not get our token. */
  async function assetResponse(asset: GitHubAsset): Promise<Response> {
    const first = await http(asset.url, {
      headers: { ...headers(), accept: "application/octet-stream" },
      redirect: "manual",
    });
    const location = first.headers.get("location");
    if (first.status >= 300 && first.status < 400 && location) return http(location, { redirect: "follow" });
    return first;
  }

  const versionOf = (tag: string) => tag.slice(DESKTOP_TAG_PREFIX.length);

  /** The release list, read at most once in 5 minutes for every platform. */
  async function releaseList(): Promise<GitHubRelease[]> {
    if (list && now() - list.at < LATEST_TTL_MS) return list.value;
    const value = (await getJson<GitHubRelease[]>(`/repos/${options.repo}/releases?per_page=30`)) ?? [];
    list = { at: now(), value };
    return value;
  }

  /** The newest `desktop-v*` release with this platform's download (a release may lack a platform). */
  async function readLatest(target: DesktopTarget): Promise<DesktopRelease | null> {
    const release = (await releaseList()).find((r) => {
      if (r.draft || r.prerelease || !r.tag_name.startsWith(DESKTOP_TAG_PREFIX)) return false;
      const version = versionOf(r.tag_name);
      return SEMVER.test(version) && (r.assets ?? []).some((a) => a.name === desktopAssets(target, version).download);
    });
    if (!release) return null;
    const version = versionOf(release.tag_name);
    const names = desktopAssets(target, version);
    const assets = release.assets ?? [];
    const file = assets.find((a) => a.name === names.download);
    if (!file) return null;
    const sumAsset = assets.find((a) => a.name === `${names.download}.sha256`);
    const sha256 = sumAsset ? parseSha256(await (await assetResponse(sumAsset)).text()) : null;
    if (!sha256) return null;
    const { notes, minVersion } = parseReleaseBody(release.body);
    const bundle = assets.find((a) => a.name === names.updater);
    const sigAsset = assets.find((a) => a.name === `${names.updater}.sig`);
    const signature = bundle && sigAsset ? (await (await assetResponse(sigAsset)).text()).trim() : "";
    return {
      version,
      url: `${base}/api/desktop/download/${version}/${file.name}`,
      sha256,
      notes,
      publishedAt: release.published_at ?? release.created_at ?? "",
      ...(minVersion ? { minVersion } : {}),
      ...(bundle && signature
        ? { updater: { url: `${base}/api/desktop/download/${version}/${bundle.name}`, signature } }
        : {}),
    };
  }

  return {
    enabled: Boolean(options.token),

    /** The newest `desktop-v*` release with this platform's download and checksum; null when there is none. */
    async latest(target: DesktopTarget = "darwin"): Promise<DesktopRelease | null> {
      if (!options.token) return null;
      const cached = latest.get(target);
      if (cached && now() - cached.at < LATEST_TTL_MS) return cached.value;
      const value = await readLatest(target);
      latest.set(target, { at: now(), value });
      return value;
    },

    /** The bytes of one asset of the `desktop-v<version>` release; null when it isn't one. */
    async download(version: string, file: string): Promise<{ response: Response; name: string } | null> {
      if (!options.token || !SEMVER.test(version) || !FILE_NAME.test(file)) return null;
      const release = await getJson<GitHubRelease>(
        `/repos/${options.repo}/releases/tags/${encodeURIComponent(`${DESKTOP_TAG_PREFIX}${version}`)}`,
      );
      if (!release || release.draft || !release.tag_name.startsWith(DESKTOP_TAG_PREFIX)) return null;
      const asset = (release.assets ?? []).find((a) => a.name === file);
      if (!asset) return null;
      const response = await assetResponse(asset);
      return response.ok ? { response, name: asset.name } : null;
    },
  };
}

export type DesktopReleases = ReturnType<typeof createDesktopReleases>;

/** Light limits: the app checks every 6 hours; downloads are people clicking. */
const LATEST_LIMIT = { limit: 60, windowMs: 60_000 };
const DOWNLOAD_LIMIT = { limit: 20, windowMs: 60_000 };

const Latest = z
  .object({
    version: z.string().openapi({ example: "0.1.0" }),
    url: z.string().openapi({ description: "Our download URL for the platform's file (opens in the browser)." }),
    sha256: z.string(),
    notes: z.string(),
    publishedAt: z.string(),
    minVersion: z.string().optional().openapi({ description: 'Below this the app says "Atualize para continuar".' }),
  })
  .openapi("DesktopRelease");

/**
 * `GET /api/desktop/latest`, `GET /api/desktop/update` (the Tauri updater) and
 * `GET /api/desktop/download/{version}/{file}` (ADR 0036 §9): public, no session;
 * 404 (204 for the updater) without `DESKTOP_RELEASES_TOKEN`.
 */
export function registerDesktopRoutes(api: OpenAPIHono, deps: AppDeps, releases: DesktopReleases) {
  const { rateLimiter } = deps.adapters;

  // The desktop app's web view (origin `tauri://localhost`) reads it with fetch: public data, no credentials.
  api.use("/desktop/latest", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "86400",
      });
    }
    await next();
    c.res.headers.set("access-control-allow-origin", "*");
  });

  api.openapi(
    createRoute({
      method: "get",
      path: "/desktop/latest",
      tags,
      summary: "The newest desktop app build (notes, download link, minimum version)",
      request: {
        query: z.object({
          target: z.string().max(20).openapi({ example: "darwin", description: "darwin, windows or linux" }),
          arch: z.string().max(20).optional().openapi({ example: "arm64", description: "arm64 or x64" }),
        }),
      },
      responses: {
        200: json(Latest),
        404: errorResponse("No build for this target (or releases are not configured)"),
        429: errorResponse("Too many requests"),
      },
    }),
    async (c) => {
      const limit = await rateLimiter.consume(`desktop-latest:${requestIp(c.req.raw.headers)}`, LATEST_LIMIT);
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again in a minute");
      const { target, arch } = c.req.valid("query");
      // One universal build for both Mac architectures (Rust and Node names alike); x64 on Windows and Linux.
      const platform = desktopTarget(target, arch);
      const release = platform ? await releases.latest(platform).catch(() => null) : null;
      if (!release) return apiError(c, 404, "desktop.no_release", "No desktop build for this computer yet");
      const { updater: _, ...latest } = release;
      return c.json(latest, 200);
    },
  );

  // The app's updater (Rust, no web view): Tauri's format, 204 when there is nothing to install.
  // It installs only a newer version whose bundle matches the public key built into the app.
  api.get("/desktop/update", async (c) => {
    const limit = await rateLimiter.consume(`desktop-update:${requestIp(c.req.raw.headers)}`, LATEST_LIMIT);
    if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again in a minute");
    const platform = desktopTarget(c.req.query("target"), c.req.query("arch"));
    const release = platform ? await releases.latest(platform).catch(() => null) : null;
    if (!release?.updater) return c.body(null, 204);
    return c.json(
      {
        version: release.version,
        notes: release.notes,
        pub_date: release.publishedAt,
        url: release.updater.url,
        signature: release.updater.signature,
      },
      200,
    );
  });

  api.get("/desktop/download/:version/:file", async (c) => {
    const limit = await rateLimiter.consume(`desktop-download:${requestIp(c.req.raw.headers)}`, DOWNLOAD_LIMIT);
    if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again in a minute");
    const found = await releases.download(c.req.param("version"), c.req.param("file")).catch(() => null);
    if (!found) return apiError(c, 404, "desktop.not_found", "This build is not available");
    const upstream = found.response;
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "content-disposition": `attachment; filename="${found.name}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(upstream.body, { status: 200, headers });
  });
}
