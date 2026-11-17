import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { accountEnv } from "./accounts";
import {
  type CliRun,
  envValue,
  findOnWindowsPath,
  isFile,
  NO_CWD_LOOKUP,
  resolveCommand,
  windowsShellLine,
} from "./executors";

/**
 * Codex on Windows (ADR 0032 "Codex", ADR 0053's addendum of 2026-11-12): how it starts there, and the sandbox a
 * `plan` or `work` turn runs in.
 *
 * - It starts as the native `codex.exe`, found on the PATH, never in the current folder (`findOnWindowsPath`); npm's
 *   `codex.cmd` as the `codex.exe` behind it. Nothing goes through cmd.exe then: its line stops at 8,191 characters
 *   and expands `%NAME%` even in quotes.
 * - The sandbox is MXC (Microsoft Execution Containers, Windows 11 24H2 and later): Windows' own isolation, no setup,
 *   no network, writes in the agent's folders. Codex picks no sandbox on Windows by itself, and its other two hold
 *   less (`unelevated` keeps the network out only through proxy variables) or need an administrator's setup that
 *   several Codex homes (each AI account's folder, ADR 0041) can't share (`elevated`). A computer where Codex's own
 *   MXC check fails runs no `plan` or `work` turn: it fails with `windows_sandbox`. A `chat` turn needs none: with no
 *   sandbox, Codex refuses every command of its own there, and the turn stops at the first one anyway.
 * - Nothing asks on Windows (`approvalPolicy: never`): the command policy reads POSIX shells, not the PowerShell Codex
 *   runs its commands in, so the sandbox is the whole limit, as for `codex exec` everywhere. Nothing lifts it, on any
 *   system (`brain-codex.ts`): no one's own Codex rules (an allow there runs a command outside the sandbox, unasked:
 *   `codexRulesNear`), no network and no folder beyond the agent's, whatever the Codex home's config says.
 */

/** Where npm puts the native Codex for each Windows CPU (`@openai/codex`'s platform packages). */
const NPM_TARGETS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
  arm64: { pkg: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
};

/**
 * The `codex.exe` npm's `codex.cmd` runs (through `node` and the package's launcher): in the platform package, nested
 * in `@openai/codex` as a global install puts it, or beside it, or in the package's own `vendor` folder. It finds its
 * helpers (the sandbox's, the code mode host, `rg`) next to itself, so it works started directly. Null: laid out
 * some other way.
 */
export function codexExeBehindShim(shim: string, arch: string = process.arch, exists = isFile): string | null {
  const target = NPM_TARGETS[arch];
  if (!target) return null;
  const dir = path.win32.dirname(shim);
  const main = path.win32.join(dir, "node_modules", "@openai", "codex");
  const exes = [
    path.win32.join(main, "node_modules", "@openai", target.pkg),
    path.win32.join(dir, "node_modules", "@openai", target.pkg),
    main,
  ].map((pkg) => path.win32.join(pkg, "vendor", target.triple, "bin", "codex.exe"));
  return exes.find((exe) => exists(exe)) ?? null;
}

/** cmd.exe's longest line (8,191 characters), with room to spare. */
const CMD_LINE_MAX = 8000;

/** How `codex` starts, or why it can't (`missing`: not installed). */
export type CodexLaunch = CliRun | { error: string; missing?: true };

/**
 * How `codex <args>` starts. Elsewhere: its full path on the PATH, as before. On Windows: found on the PATH, never in
 * the current folder; a `codex.exe` as it is; npm's `codex.cmd` as the `codex.exe` behind it (with what npm's
 * launcher tells it, how it was installed). A launcher laid out some other way goes through cmd.exe, only with our own
 * words in it (paths, ids and settings: nothing cmd.exe would read, `%`, `!` or a line break) and within its line.
 * Every Windows start carries `NO_CWD_LOOKUP` (an `.exe` may be a launcher too, as Bun's are).
 */
export function codexLaunch(
  args: readonly string[],
  opts: {
    bin?: string;
    pathList?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    pathExt?: string;
    exists?: (file: string) => boolean;
  } = {},
): CodexLaunch {
  const platform = opts.platform ?? process.platform;
  const bin = opts.bin ?? "codex";
  if (platform !== "win32") return { file: resolveCommand(bin, opts.pathList), args: [...args] };
  const exists = opts.exists ?? isFile;
  const found = findOnWindowsPath(
    bin,
    opts.pathList ?? envValue(process.env, "PATH", platform) ?? "",
    opts.pathExt ?? envValue(process.env, "PATHEXT", platform),
    exists,
  );
  if (!found) return { error: "Codex is not installed on this computer.", missing: true };
  if (/\.(?:exe|com)$/i.test(found)) return { file: found, args: [...args], env: { ...NO_CWD_LOOKUP } };
  if (!/\.(?:cmd|bat)$/i.test(found)) {
    return {
      error: `Codex here starts through ${path.win32.basename(found)}, which agents can't run. Install it with npm or OpenAI's installer.`,
    };
  }
  const exe = codexExeBehindShim(found, opts.arch ?? process.arch, exists);
  if (exe) return { file: exe, args: [...args], env: { ...NO_CWD_LOOKUP, CODEX_MANAGED_BY_NPM: "1" } };
  const launcher = "Codex here starts through a launcher agents can't hand this turn to";
  if (args.some((a) => /[%!\r\n]/.test(a))) {
    return { error: `${launcher} (its settings have a % or ! in them). Install Codex with npm or OpenAI's installer.` };
  }
  const run = windowsShellLine(found, args);
  if ((run.args.at(-1) ?? "").length > CMD_LINE_MAX) {
    return { error: `${launcher} (its settings are too long for it). Install Codex with npm or OpenAI's installer.` };
  }
  return run;
}

/**
 * A `plan` or `work` turn's sandbox on Windows, named in `-c`: MXC, explicitly, so a sandbox the computer's own Codex
 * config names (`unelevated`) never stands in for it, and a computer where it stopped working fails closed (Codex
 * refuses to run a command there rather than run it elsewhere).
 */
export const CODEX_WINDOWS_CONFIG = ['windows.sandbox="mxc"'];

/** What a `plan` or `work` turn says where Windows can't hold Codex's commands. */
export const WINDOWS_SANDBOX_MESSAGE =
  "This computer can't isolate Codex's commands: agents that think with Codex on Windows need Windows 11 24H2 or newer, with Microsoft Execution Containers (MXC). Update Windows there, or choose another way for this agent to think.";

/**
 * A thread's first prompt on Windows when it runs on `codex exec`: its instructions lead it, on stdin, as the plan
 * router's do (`codexRoute`). A command line can't carry them there (32,767 characters, 8,191 through cmd.exe).
 */
export const codexStdinPrompt = (instructions: string, prompt: string) =>
  instructions.trim() ? `${instructions.trim()}\n\n${prompt}` : prompt;

/**
 * Codex's own check of MXC (Codex 0.162.0 and later): `echo MXC_OK` run inside MXC, with the workspace's permissions
 * and any managed requirements.
 */
export const MXC_CHECK_ARGS = [
  "-c",
  'windows.sandbox="mxc"',
  "sandbox",
  "--include-managed-config",
  "--permission-profile",
  ":workspace",
  "--",
  "cmd.exe",
  "/d",
  "/c",
  "echo",
  "MXC_OK",
];

const MXC_CHECK_TIMEOUT_MS = 60_000;

/**
 * Runs Codex's MXC check: true when it printed `MXC_OK` and ended well (MXC ran a command here), false when it ran and
 * didn't (no MXC, or a policy that forbids it), null when it couldn't tell (it didn't start, or didn't end in time).
 */
export function runMxcCheck(
  run: CliRun,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<boolean | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        run.file,
        run.args,
        {
          cwd: opts.cwd,
          env: run.env ? { ...opts.env, ...run.env } : opts.env,
          encoding: "utf8",
          timeout: opts.timeoutMs ?? MXC_CHECK_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (err, stdout) => {
          if (!err) return resolve(/\bMXC_OK\b/.test(stdout));
          const failed = err as { code?: unknown; killed?: boolean };
          // It ran and said no (its exit code), against it not starting or not ending in time.
          resolve(typeof failed.code === "number" && !failed.killed ? false : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** How long a "no MXC here" is kept before asking again (Windows may have been updated meanwhile). */
export const WINDOWS_MXC_RETRY_MS = 10 * 60_000;

const mxcChecks = new Map<string, { ok: boolean; at: number }>();

/**
 * Whether MXC holds Codex's commands on this computer: Codex's own check (`MXC_CHECK_ARGS`), in an empty Codex home of
 * the runner's (none of a person's config in it), which runs a command inside MXC. Kept per Codex version: a yes for as
 * long as the runner runs, a no for `WINDOWS_MXC_RETRY_MS`. Null: it couldn't tell (not kept).
 */
export async function windowsMxcReady(input: {
  runnerHome: string;
  version: string;
  bin?: string;
  check?: (args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<boolean | null>;
  now?: () => number;
}): Promise<boolean | null> {
  const now = input.now ?? Date.now;
  const key = `${input.bin ?? "codex"}@${input.version}`;
  const kept = mxcChecks.get(key);
  if (kept && (kept.ok || now() - kept.at < WINDOWS_MXC_RETRY_MS)) return kept.ok;
  const home = path.join(input.runnerHome, "brain", "codex-windows-check");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = accountEnv("codex", home);
  const check =
    input.check ??
    ((args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const launch = codexLaunch(args, {
        ...(input.bin ? { bin: input.bin } : {}),
        pathList: envValue(o.env, "PATH") ?? "",
      });
      return "error" in launch ? Promise.resolve(null) : runMxcCheck(launch, o);
    });
  const ok = await check(MXC_CHECK_ARGS, { cwd: home, env });
  if (ok === null) return null;
  mxcChecks.set(key, { ok, at: now() });
  return ok;
}
