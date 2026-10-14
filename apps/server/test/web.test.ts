import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

/**
 * One process serves the API and the built web app (apps/web → WEB_DIR),
 * like Tierbird serves its dashboard. Client-side routes fall back to
 * index.html; /api/* never does.
 */
let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentes-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  app = createApp({ edition: "cloud", version: "test", modules: [], pingDatabase: async () => {}, webDir: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("web app serving", () => {
  test("serves built assets", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  test("client-side routes get index.html", async () => {
    for (const path of ["/", "/login", "/org/abc/c/def", "/invite/some-token"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test("unknown API routes stay JSON 404s", async () => {
    const res = await app.request("/api/app/nothing-here");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});
