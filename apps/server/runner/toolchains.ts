import os from "node:os";
import path from "node:path";
import type { RunnerToolchains } from "@agenteschat/adapters/machine-protocol";
import { findAdb, findSdk } from "./adb";
import { readJson, writeJson } from "./json-file";
import { extraToolDirs, runTool, which } from "./phones";
import { type AppleTeam, teamLabel, xcodeTeams } from "./wda";

/**
 * What this computer can build and drive phones with (`hello.toolchains`): versions found, best effort. A look runs
 * each tool's version command (Maestro's starts a JVM, about 2 s), so it is cached in `<home>/toolchains.json`:
 * `hello` carries the last look, and a new one runs in the background at start and every `TOOLCHAINS_TTL_MS`.
 */
export const TOOLCHAINS_TTL_MS = 6 * 3600_000;
export const TOOLCHAINS_FILE = "toolchains.json";

export interface ToolchainsProbe {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  dirs?: string[];
  /** Tests: the teams of Xcode's Apple Accounts (default `xcodeTeams`). */
  teams?: () => Promise<AppleTeam[]>;
}

/** The first version-looking word after `prefix` in `text`. */
const version = (text: string, prefix: RegExp) =>
  new RegExp(`${prefix.source}\\s*v?(\\d+(?:\\.\\d+)+)`, prefix.flags).exec(text)?.[1];

export async function probeToolchains(opts: ToolchainsProbe = {}): Promise<RunnerToolchains> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const dirs = [...(env.PATH ?? "").split(path.delimiter), ...(opts.dirs ?? extraToolDirs(home))];
  const find = (name: string) => which(name, dirs, platform);
  const say = async (bin: string | null, args: string[]) => {
    if (!bin) return "";
    const r = await runTool(bin, args, { timeoutMs: 20_000, env: { ...env, MAESTRO_CLI_NO_ANALYTICS: "1" } });
    return r.code === 0 ? `${r.stdout.toString("utf8")}\n${r.stderr}` : "";
  };
  // macOS's /usr/bin git, java and xcodebuild are stubs that open an install dialog when the tools aren't there.
  const devTools = platform !== "darwin" || (await say(find("xcode-select"), ["-p"])) !== "";
  const stub = (bin: string | null) => platform === "darwin" && bin?.startsWith("/usr/bin/");
  const git = find("git");
  const java = find("java");
  const hasJava = !stub(java) || (await say("/usr/libexec/java_home", [])) !== "";
  const [gitV, javaV, adbV, scrcpyV, maestroV, xcodeV, nodeV, teams] = await Promise.all([
    stub(git) && !devTools ? "" : say(git, ["--version"]),
    hasJava ? say(java, ["-version"]) : "",
    say(findAdb(env, platform, home, dirs), ["version"]),
    say(find("scrcpy"), ["--version"]),
    say(find("maestro"), ["--version"]),
    platform === "darwin" && devTools ? say(find("xcodebuild"), ["-version"]) : "",
    say(find("node"), ["--version"]),
    platform === "darwin" && devTools ? (opts.teams ?? (() => xcodeTeams(env)))() : [],
  ]);
  const sdk = findSdk(env, platform, home);
  const found: RunnerToolchains = {
    git: version(gitV, /git version/),
    java: /version "([^"]+)"/.exec(javaV)?.[1],
    ...(sdk ? { androidSdk: sdk } : {}),
    adb: version(adbV, /^Version/m) ?? version(adbV, /Android Debug Bridge version/),
    scrcpy: version(scrcpyV, /scrcpy/),
    maestro: /^\s*(\d+(?:\.\d+)+)\s*$/m.exec(maestroV)?.[1],
    xcode: version(xcodeV, /Xcode/),
    appleTeam: teams[0] ? teamLabel(teams[0]) : undefined,
    node: version(nodeV, /^/),
  };
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined)) as RunnerToolchains;
}

/** The last look, and a fresh one in the background now and every `TOOLCHAINS_TTL_MS` (written to `file`). */
export function cachedToolchains(file: string, probe: () => Promise<RunnerToolchains> = () => probeToolchains()) {
  let current = readJson<RunnerToolchains>(file);
  let looking: Promise<void> | null = null;
  const look = () =>
    (looking ??= probe()
      .then((found) => {
        current = found;
        writeJson(file, found);
      })
      .catch(() => undefined)
      .finally(() => {
        looking = null;
      }));
  void look();
  const timer = setInterval(() => void look(), TOOLCHAINS_TTL_MS);
  timer.unref?.();
  return {
    get: () => current ?? undefined,
    look,
    stop: () => clearInterval(timer),
  };
}
