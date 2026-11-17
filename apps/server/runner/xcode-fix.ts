import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { XcodeBlocked, XcodeFix, XcodeFixKind } from "@agenteschat/adapters/machine-protocol";
import { killTree } from "./exec";
import { shQuote } from "./install-script";
import { pageLocale, XCODE_PROMPT } from "./page-words";
import { findXcodeApp } from "./toolchains";

/**
 * A Mac fixing its own Xcode for an iPhone's setup (`xcode.fix`, the desktop app's `iphone.fixXcode`): `select` runs
 * `xcode-select -s`, `xcodebuild -license accept` and `xcodebuild -runFirstLaunch` as root through macOS's own
 * password window (`osascript … with administrator privileges`), so the password never passes through us; `update`
 * runs `xcrun devicectl manage ddis update`, which needs none. The script is fixed here: nothing in a request becomes
 * a command. One fix at a time; it outlives the request that started it and ends with the runner.
 */

/** How long macOS's password window waits for someone at the Mac. */
export const XCODE_FIX_ASK_MS = 3 * 60_000;
/** `-runFirstLaunch` installs packages: a slow Mac takes minutes. */
export const XCODE_FIX_RUN_MS = 20 * 60_000;
export const XCODE_FIX_STEPS = 3;
const POLL_MS = 500;

/** The line macOS's password window shows, in the Mac's own language when it is one of the app's, else English. */
export function xcodeFixPrompt(locale = Intl.DateTimeFormat().resolvedOptions().locale): string {
  return XCODE_PROMPT[pageLocale(locale)];
}

export interface XcodeFixOptions {
  log: (line: string) => void;
  /**
   * Once a fix is done: Xcode is looked at again at once (`toolchains.changed`), resolving to why it is still blocked
   * if it is: a `select` then ends `failed` with that cause (`still`) instead of `done`, so the apps offer a way out.
   */
  onDone?: () => Promise<XcodeBlocked | undefined> | undefined;
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  /** Tests: where Xcode is looked for, and the tools' paths (default `/usr/bin/<name>`). */
  apps?: string;
  bin?: (name: "osascript" | "xcode-select" | "xcodebuild" | "xcrun") => string;
  askMs?: number;
  runMs?: number;
  prompt?: string;
}

export class XcodeFixer {
  private fix: XcodeFix | null = null;
  private child: ChildProcess | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private dir: string | null = null;

  constructor(private readonly opts: XcodeFixOptions) {}

  private bin(name: Parameters<NonNullable<XcodeFixOptions["bin"]>>[0]) {
    return this.opts.bin?.(name) ?? `/usr/bin/${name}`;
  }

  private live() {
    return this.fix?.state === "asking" || this.fix?.state === "running";
  }

  state(): XcodeFix | null {
    return this.fix ? { ...this.fix } : null;
  }

  /** The machine op: start (or the one already under way), where it stands, or stop it. */
  handle(req: { action?: unknown; kind?: unknown }): { fix: XcodeFix | null } {
    if (req.action === "start") return { fix: this.start(req.kind === "update" ? "update" : "select") };
    if (req.action === "cancel") return { fix: this.cancel() };
    return { fix: this.state() };
  }

  start(kind: XcodeFixKind): XcodeFix {
    if (this.live() && this.fix) return { ...this.fix };
    const platform = this.opts.platform ?? process.platform;
    const uid = this.opts.uid ?? process.getuid?.() ?? -1;
    // Root (system mode) has no person's screen to ask on.
    const app = kind === "select" ? findXcodeApp(this.opts.apps) : null;
    if (platform !== "darwin" || uid === 0 || (kind === "select" && !app)) {
      this.fix = { kind, state: "unsupported", step: 0 };
      return { ...this.fix };
    }
    this.end();
    this.fix = { kind, state: kind === "select" ? "asking" : "running", step: 0 };
    let child: ChildProcess;
    let stepFile: string | null = null;
    try {
      if (kind === "select" && app) {
        this.dir = mkdtempSync(path.join(os.tmpdir(), "agentes-xcode-"));
        stepFile = path.join(this.dir, "step");
        const mark = (n: number) => `echo ${n} > ${shQuote(stepFile as string)}`;
        const script = [
          `${shQuote(this.bin("xcode-select"))} -s ${shQuote(path.join(app, "Contents", "Developer"))}`,
          mark(1),
          `${shQuote(this.bin("xcodebuild"))} -license accept`,
          mark(2),
          `${shQuote(this.bin("xcodebuild"))} -runFirstLaunch`,
          mark(3),
        ].join(" && ");
        child = spawn(
          this.bin("osascript"),
          [
            "-e",
            "on run argv",
            "-e",
            "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
            "-e",
            "end run",
            script,
            this.opts.prompt ?? xcodeFixPrompt(),
          ],
          { env: this.opts.env ?? process.env, stdio: ["ignore", "ignore", "pipe"], detached: true },
        );
      } else {
        child = spawn(this.bin("xcrun"), ["devicectl", "manage", "ddis", "update"], {
          env: this.opts.env ?? process.env,
          stdio: ["ignore", "ignore", "pipe"],
          detached: true,
        });
      }
    } catch (err) {
      this.fix = { kind, state: "failed", step: 0, message: err instanceof Error ? err.message : String(err) };
      return { ...this.fix };
    }
    this.child = child;
    let said = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      said = `${said}${chunk.toString("utf8")}`.slice(-2000);
    });
    const readStep = () => {
      if (!stepFile || this.child !== child || !this.fix) return;
      let step = 0;
      try {
        step = Number.parseInt(readFileSync(stepFile, "utf8"), 10) || 0;
      } catch {
        // not written yet: the password window is still open
      }
      if (step > this.fix.step) this.fix = { ...this.fix, state: "running", step: Math.min(step, XCODE_FIX_STEPS) };
    };
    const stopWith = (state: XcodeFix["state"], message?: string) => {
      if (this.child !== child || !this.fix) return;
      this.fix = { ...this.fix, state, ...(message ? { message } : {}) };
      this.end();
      killTree(child, "SIGTERM");
    };
    this.timers.push(
      setInterval(readStep, POLL_MS),
      setTimeout(() => {
        readStep();
        if (this.fix?.state === "asking") stopWith("no_answer");
      }, this.opts.askMs ?? XCODE_FIX_ASK_MS),
      setTimeout(() => stopWith("failed", "It took too long"), this.opts.runMs ?? XCODE_FIX_RUN_MS),
    );
    for (const t of this.timers) t.unref?.();
    const events = child as unknown as EventEmitter;
    const finish = (code: number | null) => {
      if (this.child !== child || !this.fix) return;
      readStep();
      const fix = this.fix;
      // "execution error: User canceled. (-128)": Cancel in the password window.
      const last =
        said
          .trim()
          .split("\n")
          .at(-1)
          ?.replace(/^.*execution error:\s*/, "")
          .slice(0, 300) ?? "";
      if (code === 0) this.fix = { ...fix, state: "done", step: kind === "select" ? XCODE_FIX_STEPS : 0 };
      else if (/\(-128\)/.test(said)) this.fix = { ...fix, state: "canceled" };
      else this.fix = { ...fix, state: "failed", ...(last ? { message: last } : {}) };
      this.end();
      this.opts.log(`xcode: ${kind} ${this.fix.state}${last && code !== 0 ? `: ${last}` : ""}`);
      if (code !== 0) return;
      const done = this.fix;
      void Promise.resolve(this.opts.onDone?.())
        .then((still) => {
          if (kind === "select" && still && this.fix === done) this.fix = { ...done, state: "failed", still };
        })
        .catch(() => undefined);
    };
    events.on("error", (err: Error) => {
      said = err.message;
      finish(null);
    });
    events.on("close", finish);
    this.opts.log(`xcode: ${kind} started`);
    return { ...this.fix };
  }

  cancel(): XcodeFix | null {
    const child = this.child;
    if (child && this.live() && this.fix) {
      this.fix = { ...this.fix, state: "canceled" };
      this.end();
      killTree(child, "SIGTERM");
    }
    return this.state();
  }

  private end() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.child = null;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  stop() {
    const child = this.child;
    this.end();
    if (child) killTree(child, "SIGTERM");
  }
}
