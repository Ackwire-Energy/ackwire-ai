import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerToolchains } from "@agenteschat/adapters/machine-protocol";
import { findAdb, findSdk } from "./adb";
import { readJson, writeJson } from "./json-file";
import { extraToolDirs, runTool, which } from "./phones";
import { type AppleLook, type AppleTeam, appleLook, appleLookOf, teamLabel } from "./wda";

/**
 * What this computer can build and drive phones with (`hello.toolchains`): versions found, best effort. A look runs
 * each tool's version command (Maestro's starts a JVM, about 2 s), so it is cached in `<home>/toolchains.json`:
 * `hello` carries the last look, and a new one runs in the background at start and every `TOOLCHAINS_TTL_MS`. On a
 * Mac, Xcode's part (its version, its iPhone SDK, the Apple team) is looked at every `APPLE_LOOK_MS`: a person
 * setting up an iPhone signs in to Xcode and waits for the step to turn done.
 */
export const TOOLCHAINS_TTL_MS = 6 * 3600_000;
export const APPLE_LOOK_MS = 60_000;
export const TOOLCHAINS_FILE = "toolchains.json";

export interface ToolchainsProbe {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  dirs?: string[];
  /** Tests: the teams of Xcode's Apple Accounts, or the whole look (default `appleLook`). */
  teams?: () => Promise<AppleTeam[] | AppleLook>;
  /** Tests: the folder Xcode is looked for in (default `/Applications`, as `findXcodeApp`). */
  apps?: string;
}

type AppleKeys = Pick<RunnerToolchains, "xcode" | "xcodeSdk" | "appleTeam" | "appleAccount" | "xcodeBlocked">;

/** `/Applications/Xcode.app`, else the newest-named other Xcode there (`Xcode-beta.app`, `Xcode_27.2.app`). */
export function findXcodeApp(apps = "/Applications"): string | null {
  if (existsSync(path.join(apps, "Xcode.app"))) return path.join(apps, "Xcode.app");
  let names: string[] = [];
  try {
    names = readdirSync(apps).filter((n) => /^Xcode.*\.app$/.test(n));
  } catch {
    return null;
  }
  const name = names.sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
  return name ? path.join(apps, name) : null;
}

/** The first version-looking word after `prefix` in `text`. */
const version = (text: string, prefix: RegExp) =>
  new RegExp(`${prefix.source}\\s*v?(\\d+(?:\\.\\d+)+)`, prefix.flags).exec(text)?.[1];

function finder(opts: ToolchainsProbe) {
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
  return { env, platform, home, dirs, find, say };
}

/** Xcode's part, on a Mac with the developer tools (`devTools`): its version, iPhone SDK and Apple team. */
async function appleKeys(opts: ToolchainsProbe, devTools?: boolean): Promise<AppleKeys> {
  const { env, platform, find, say } = finder(opts);
  if (platform !== "darwin") return {};
  // macOS's /usr/bin xcodebuild and xcrun are stubs that open an install dialog when the tools aren't there.
  if (!(devTools ?? (await say(find("xcode-select"), ["-p"])) !== "")) return {};
  const [xcodeV, sdkV, found] = await Promise.all([
    say(find("xcodebuild"), ["-version"]),
    say(find("xcrun"), ["--sdk", "iphoneos", "--show-sdk-version"]),
    (opts.teams ?? (() => appleLook({ env })))(),
  ]);
  const look = Array.isArray(found) ? appleLookOf(found, 0) : found;
  const sdk = /^\s*(\d+(?:\.\d+)+)\s*$/.exec(sdkV)?.[1];
  const xcode = version(xcodeV, /Xcode/);
  return {
    xcode,
    xcodeSdk: sdk,
    appleTeam: look.teams[0] ? teamLabel(look.teams[0]) : undefined,
    appleAccount: look.account,
    xcodeBlocked: xcode ? undefined : await xcodeBlocked(opts),
  };
}

/**
 * Why Xcode is on the Mac yet `xcodebuild` doesn't answer, when it's something the person fixes with one command:
 * the developer folder still on the Command Line Tools (installed before Xcode, `xcode-select` never moved), or
 * Xcode's license not agreed to. Neither is "install Xcode", which the setup would otherwise say.
 */
export async function xcodeBlocked(opts: ToolchainsProbe): Promise<RunnerToolchains["xcodeBlocked"]> {
  const { env, find, say } = finder(opts);
  const selected = await say(find("xcode-select"), ["-p"]);
  // No developer tools at all: macOS's /usr/bin/xcodebuild stub would open an install dialog.
  if (!selected) return undefined;
  if (/CommandLineTools/.test(selected) && findXcodeApp(opts.apps)) return "command_line_tools";
  const xcodebuild = find("xcodebuild");
  if (!xcodebuild) return undefined;
  const r = await runTool(xcodebuild, ["-version"], { timeoutMs: 20_000, env });
  // "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' …", exit 69.
  const said = `${r.stdout.toString("utf8")}\n${r.stderr}`;
  return r.code !== 0 && /xcodebuild -license|license agreement/i.test(said) ? "license" : undefined;
}

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function probeToolchains(opts: ToolchainsProbe = {}): Promise<RunnerToolchains> {
  const { env, platform, home, dirs, find, say } = finder(opts);
  // macOS's /usr/bin git and java are stubs that open an install dialog when the tools aren't there.
  const devTools = platform !== "darwin" || (await say(find("xcode-select"), ["-p"])) !== "";
  const stub = (bin: string | null) => platform === "darwin" && bin?.startsWith("/usr/bin/");
  const git = find("git");
  const java = find("java");
  const hasJava = !stub(java) || (await say("/usr/libexec/java_home", [])) !== "";
  const [gitV, javaV, adbV, scrcpyV, maestroV, nodeV, podmanV, apple] = await Promise.all([
    stub(git) && !devTools ? "" : say(git, ["--version"]),
    hasJava ? say(java, ["-version"]) : "",
    say(findAdb(env, platform, home, dirs), ["version"]),
    say(find("scrcpy"), ["--version"]),
    say(find("maestro"), ["--version"]),
    say(find("node"), ["--version"]),
    say(find("podman"), ["--version"]),
    appleKeys(opts, devTools),
  ]);
  const sdk = findSdk(env, platform, home);
  return defined<RunnerToolchains>({
    git: version(gitV, /git version/),
    java: /version "([^"]+)"/.exec(javaV)?.[1],
    ...(sdk ? { androidSdk: sdk } : {}),
    adb: version(adbV, /^Version/m) ?? version(adbV, /Android Debug Bridge version/),
    scrcpy: version(scrcpyV, /scrcpy/),
    maestro: /^\s*(\d+(?:\.\d+)+)\s*$/m.exec(maestroV)?.[1],
    ...apple,
    node: version(nodeV, /^/),
    podman: version(podmanV, /podman version/),
  });
}

/**
 * The last look, and a fresh one in the background now and every `TOOLCHAINS_TTL_MS` (written to `file`). `apple.look`
 * (a Mac): Xcode's part every `APPLE_LOOK_MS`. Whenever a look differs from what the server heard, `onChange` gets the
 * whole list (false: not sent, tried again the next minute).
 */
export function cachedToolchains(
  file: string,
  probe: () => Promise<RunnerToolchains> = () => probeToolchains(),
  apple: { look?: () => Promise<AppleKeys>; onChange: (toolchains: RunnerToolchains) => unknown } | null = null,
) {
  let current = readJson<RunnerToolchains>(file);
  const said = (t: RunnerToolchains | null) => JSON.stringify(t ?? {});
  /** The list as the server last heard it (`hello` reads `get`, or a frame that went out). */
  let told = said(current);
  const tell = (t: RunnerToolchains) => {
    if (apple && said(t) !== told && apple.onChange(t) !== false) told = said(t);
  };
  let looking: Promise<void> | null = null;
  const look = () =>
    (looking ??= probe()
      .then((found) => {
        current = found;
        writeJson(file, found);
        // `hello` went out with the last look's list: a git, adb or Node found since reaches the server now.
        tell(found);
      })
      .catch(() => undefined)
      .finally(() => {
        looking = null;
      }));
  void look();
  const timer = setInterval(() => void look(), TOOLCHAINS_TTL_MS);
  timer.unref?.();
  let appleLooking = false;
  /** One look at Xcode's part; resolves once it is stored (and told, when it changed). */
  const lookApple = async () => {
    if (!apple?.look || appleLooking || looking) return;
    appleLooking = true;
    try {
      const keys = defined(await apple.look());
      const before = current ?? {};
      const next = defined<RunnerToolchains>({
        ...before,
        xcode: undefined,
        xcodeSdk: undefined,
        appleTeam: undefined,
        appleAccount: undefined,
        xcodeBlocked: undefined,
        ...keys,
      });
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        current = next;
        writeJson(file, next);
      }
      // Against what the server heard, not the last look: a hello sent before the start's full look finished.
      tell(next);
    } catch {
      // the next minute's look
    } finally {
      appleLooking = false;
    }
  };
  const appleTimer = apple?.look ? setInterval(() => void lookApple(), APPLE_LOOK_MS) : null;
  appleTimer?.unref?.();
  return {
    get: () => {
      told = said(current);
      return current ?? undefined;
    },
    look,
    lookApple,
    stop: () => {
      clearInterval(timer);
      if (appleTimer) clearInterval(appleTimer);
    },
  };
}

/** Xcode's part of the toolchains, the 60 s look (`cachedToolchains`'s `apple`). */
export const appleToolchains = (opts: ToolchainsProbe = {}) => appleKeys(opts);
