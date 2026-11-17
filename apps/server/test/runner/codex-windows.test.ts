import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CODEX_WINDOWS_CONFIG,
  codexExeBehindShim,
  codexLaunch,
  codexStdinPrompt,
  MXC_CHECK_ARGS,
  runMxcCheck,
  WINDOWS_MXC_RETRY_MS,
  windowsMxcReady,
} from "../../runner/codex-windows";
import { removeDirs, tempDir } from "./helpers";

/**
 * Codex on Windows (`codex-windows.ts`): how it starts, and whether MXC holds its commands. The lookups take which
 * files exist as given, so they run anywhere.
 */

const dirs: string[] = [];
afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE_CODEX = path.join(import.meta.dir, "fake-codex-app.mjs");
const NPM = "C:\\Users\\user\\AppData\\Roaming\\npm";
const SHIM = `${NPM}\\codex.cmd`;
const OPENAI = "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin";
const PATH_WIN = `${NPM};${OPENAI}`;
const NO_CWD_LOOKUP = { NoDefaultCurrentDirectoryInExePath: "1" };
const nested = (pkg: string, triple: string) =>
  `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\${pkg}\\vendor\\${triple}\\bin\\codex.exe`;
const NESTED = nested("codex-win32-x64", "x86_64-pc-windows-msvc");
const has =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

test("npm's codex.cmd: the codex.exe its package carries, nested as a global install puts it, beside it, or its own", () => {
  expect(codexExeBehindShim(SHIM, "x64", has(NESTED))).toBe(NESTED);
  expect(codexExeBehindShim(SHIM, "arm64", has(nested("codex-win32-arm64", "aarch64-pc-windows-msvc")))).toBe(
    nested("codex-win32-arm64", "aarch64-pc-windows-msvc"),
  );
  const hoisted = `${NPM}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  expect(codexExeBehindShim(SHIM, "x64", has(hoisted))).toBe(hoisted);
  const own = `${NPM}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  expect(codexExeBehindShim(SHIM, "x64", has(own))).toBe(own);
  // Another CPU's, or a layout we don't know: not ours to guess.
  expect(codexExeBehindShim(SHIM, "arm64", has(NESTED))).toBeNull();
  expect(codexExeBehindShim(SHIM, "ia32", () => true)).toBeNull();
});

test("starting Codex on Windows: codex.exe as it is, npm's launcher as the exe behind it, cmd.exe only with our words", () => {
  const args = [
    "exec",
    "--json",
    "-c",
    'windows.sandbox="mxc"',
    "-c",
    "sandbox_workspace_write.writable_roots=[]",
    "-",
  ];
  const win = { platform: "win32" as const, arch: "x64", pathList: PATH_WIN, pathExt: ".COM;.EXE;.BAT;.CMD" };
  // OpenAI's installer, winget, Scoop: a codex.exe on the PATH, started as it is, nothing looked up in the folder.
  expect(codexLaunch(args, { ...win, exists: has(`${OPENAI}\\codex.exe`) })).toEqual({
    file: `${OPENAI}\\codex.exe`,
    args,
    env: NO_CWD_LOOKUP,
  });
  // npm's launcher (first on the PATH): the codex.exe behind it, told how it was installed.
  expect(codexLaunch(args, { ...win, exists: has(SHIM, NESTED, `${OPENAI}\\codex.exe`) })).toEqual({
    file: NESTED,
    args,
    env: { ...NO_CWD_LOOKUP, CODEX_MANAGED_BY_NPM: "1" },
  });
  // A launcher laid out some other way: through cmd.exe, by its full path, nothing looked up in the current folder.
  const shell = codexLaunch(args, { ...win, exists: has(SHIM) });
  expect(shell).toMatchObject({ windowsVerbatimArguments: true, env: NO_CWD_LOOKUP });
  expect("args" in shell && shell.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
  expect("args" in shell && shell.args[4]?.startsWith(`""${SHIM}" "exec"`)).toBe(true);
  // ...and never with what cmd.exe would read, nor past its line.
  expect(codexLaunch(["exec", "-c", 'x="%USERPROFILE%"'], { ...win, exists: has(SHIM) })).toMatchObject({
    error: expect.stringContaining("% or !"),
  });
  expect(codexLaunch(["exec", "x".repeat(9000)], { ...win, exists: has(SHIM) })).toMatchObject({
    error: expect.stringContaining("too long"),
  });
  // Not on the PATH (the current folder is never searched).
  expect(codexLaunch(args, { ...win, exists: () => false })).toEqual({
    error: "Codex is not installed on this computer.",
    missing: true,
  });
  // Elsewhere: its full path, as before.
  expect(codexLaunch(args, { platform: "linux", bin: "/opt/codex/codex" })).toEqual({ file: "/opt/codex/codex", args });
});

test("a plan or work turn's sandbox on Windows is MXC by name; a new thread's instructions lead its prompt on stdin", () => {
  expect(CODEX_WINDOWS_CONFIG).toEqual(['windows.sandbox="mxc"']);
  expect(codexStdinPrompt("Be brief.", "Say pong")).toBe("Be brief.\n\nSay pong");
  expect(codexStdinPrompt("  ", "Say pong")).toBe("Say pong");
});

test("whether MXC holds Codex is Codex's own check, once per Codex: a yes kept, a no for a while, no answer never", async () => {
  const home = tempDir("codex-windows-");
  dirs.push(home);
  type Check = (args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<boolean | null>;
  const checkOf = (answers: Array<boolean | null>) => {
    const calls: Array<{ args: readonly string[]; cwd: string; codexHome: string | undefined }> = [];
    const check: Check = async (args, o) => {
      calls.push({ args, cwd: o.cwd, codexHome: o.env.CODEX_HOME });
      return answers.length ? (answers.shift() ?? null) : null;
    };
    return { calls, check };
  };
  const ask = (bin: string, check: Check, at = 0) =>
    windowsMxcReady({ runnerHome: home, version: "codex-cli 0.170.0", bin, check, now: () => at });

  const yes = checkOf([true]);
  expect(await ask("codex-a", yes.check)).toBe(true);
  expect(await ask("codex-a", yes.check, 99 * WINDOWS_MXC_RETRY_MS)).toBe(true);
  // In an empty Codex home of the runner's: none of a person's config in it.
  const checkHome = path.join(home, "brain", "codex-windows-check");
  expect(yes.calls).toEqual([{ args: MXC_CHECK_ARGS, cwd: checkHome, codexHome: checkHome }]);

  const no = checkOf([null, false, true]);
  expect(await ask("codex-b", no.check)).toBeNull();
  expect(await ask("codex-b", no.check)).toBe(false);
  expect(await ask("codex-b", no.check, WINDOWS_MXC_RETRY_MS - 1)).toBe(false);
  // Windows may have been updated since.
  expect(await ask("codex-b", no.check, WINDOWS_MXC_RETRY_MS)).toBe(true);
  expect(no.calls).toHaveLength(3);
});

test.if(posix)("Codex's MXC check: MXC_OK and a good end is a yes, its own failure a no", async () => {
  const home = tempDir("codex-windows-check-");
  dirs.push(home);
  const log = path.join(home, "cli.log");
  process.env.FAKE_CODEX_LOG = log;
  const run = { file: process.execPath, args: [FAKE_CODEX, ...MXC_CHECK_ARGS] };
  expect(await runMxcCheck(run, { cwd: home, env: { ...process.env, FAKE_CODEX_MXC: "1" } })).toBe(true);
  const started = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] ?? "{}") as { args?: unknown };
  expect(started.args).toEqual(MXC_CHECK_ARGS);
  expect(await runMxcCheck(run, { cwd: home, env: process.env })).toBe(false);
  // It didn't start: nobody knows yet.
  expect(await runMxcCheck({ file: path.join(home, "nowhere"), args: [] }, { cwd: home, env: process.env })).toBeNull();
});
