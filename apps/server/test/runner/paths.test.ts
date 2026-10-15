import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { normalizeRequestPath, resolveInWorkspace } from "../../runner/paths";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });

test("request paths are relative to the workspace; /workspace/ and backslashes are accepted", () => {
  expect(normalizeRequestPath("a/b.txt")).toBe("a/b.txt");
  expect(normalizeRequestPath("./a//b/")).toBe("a/b");
  expect(normalizeRequestPath("a\\b\\c.txt")).toBe("a/b/c.txt");
  expect(normalizeRequestPath("/workspace/a/b")).toBe("a/b");
  expect(normalizeRequestPath("\\workspace\\a")).toBe("a");
  expect(normalizeRequestPath("/workspace")).toBe("");
  expect(normalizeRequestPath("")).toBe("");
  expect(normalizeRequestPath(".")).toBe("");
});

test("'..', absolute paths and drive letters are refused", async () => {
  for (const bad of [
    "../x",
    "a/../../x",
    "a/..",
    "/etc/passwd",
    "/workspacex/a",
    "C:/Windows",
    "c:\\x",
    "\\\\server\\share",
  ]) {
    expect(await errorCode(() => normalizeRequestPath(bad))).toBe("outside_workspace");
  }
  expect(await errorCode(() => normalizeRequestPath("a\0b"))).toBe("bad_request");
});

test("symlinks that leave the workspace are refused for reads, writes and listings", async () => {
  const ws = tempDir();
  const outside = tempDir("runner-outside-");
  dirs.push(ws, outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  mkdirSync(path.join(ws, "sub"));
  writeFileSync(path.join(ws, "sub", "ok.txt"), "ok");
  symlinkSync(outside, path.join(ws, "link"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "file-link"));
  symlinkSync(path.join(outside, "missing.txt"), path.join(ws, "dangling"));
  symlinkSync(path.join(ws, "sub"), path.join(ws, "inlink"));

  expect(await errorCode(() => resolveInWorkspace(ws, "link/secret.txt"))).toBe("outside_workspace");
  expect(await errorCode(() => resolveInWorkspace(ws, "file-link"))).toBe("outside_workspace");
  expect(await errorCode(() => resolveInWorkspace(ws, "link/new/deep.txt"))).toBe("outside_workspace");
  expect(await errorCode(() => resolveInWorkspace(ws, "dangling"))).toBe("outside_workspace");

  const inside = await resolveInWorkspace(ws, "/workspace/inlink/ok.txt");
  expect(inside).toEqual({ rel: "inlink/ok.txt", abs: path.join(ws, "sub", "ok.txt"), exists: true });
  const missing = await resolveInWorkspace(ws, "new/dir/file.txt");
  expect(missing).toEqual({ rel: "new/dir/file.txt", abs: path.join(ws, "new", "dir", "file.txt"), exists: false });

  const ctx = { workspaceReal: ws, exec: false, token: "agm_x" };
  expect(
    await errorCode(() => handleRequest(ctx, { op: "read", path: "link/secret.txt", maxBytes: 100 }, scope())),
  ).toBe("outside_workspace");
  const write = { op: "write" as const, path: "link/planted.txt", base64: Buffer.from("x").toString("base64") };
  expect(await errorCode(() => handleRequest(ctx, write, scope()))).toBe("outside_workspace");
  expect(existsSync(path.join(outside, "planted.txt"))).toBe(false);
  expect(await errorCode(() => handleRequest(ctx, { ...write, path: "dangling" }, scope()))).toBe("outside_workspace");
  expect(existsSync(path.join(outside, "missing.txt"))).toBe(false);

  const listed = (await handleRequest(ctx, { op: "list", path: "", depth: 2 }, scope())) as {
    entries: { path: string; isDir: boolean; size: number }[];
  };
  const paths = listed.entries.map((e) => e.path).sort();
  expect(paths).toEqual(["inlink", "sub", "sub/ok.txt"]);
  expect(listed.entries.find((e) => e.path === "inlink")?.isDir).toBe(true);
});

test("read, write and list inside the workspace", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const ctx = { workspaceReal: ws, exec: false, token: "agm_x" };
  const base64 = Buffer.from("hello").toString("base64");
  expect(await handleRequest(ctx, { op: "write", path: "/workspace/a/b/c.txt", base64 }, scope())).toEqual({ size: 5 });
  expect(await handleRequest(ctx, { op: "read", path: "a/b/c.txt", maxBytes: 100 }, scope())).toEqual({
    base64,
    size: 5,
  });
  expect(await handleRequest(ctx, { op: "read", path: "nope.txt", maxBytes: 100 }, scope())).toEqual({
    base64: null,
    size: 0,
  });
  expect(await errorCode(() => handleRequest(ctx, { op: "read", path: "a/b/c.txt", maxBytes: 2 }, scope()))).toBe(
    "too_large",
  );
  expect(await errorCode(() => handleRequest(ctx, { op: "read", path: "a", maxBytes: 100 }, scope()))).toBe(
    "bad_request",
  );
  expect(await handleRequest(ctx, { op: "list", path: "missing", depth: 1 }, scope())).toEqual({ entries: [] });
  expect(await handleRequest(ctx, { op: "list", path: "a", depth: 1 }, scope())).toEqual({
    entries: [{ path: "a/b", isDir: true, size: 0 }],
  });
  expect(await handleRequest(ctx, { op: "list", path: "a", depth: 5 }, scope())).toEqual({
    entries: [
      { path: "a/b", isDir: true, size: 0 },
      { path: "a/b/c.txt", isDir: false, size: 5 },
    ],
  });
});
