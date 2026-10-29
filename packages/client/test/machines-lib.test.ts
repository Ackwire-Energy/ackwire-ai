import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../src/api/http";
import { keys } from "../src/api/keys";
import type { AccountLoginStatus, MachineAccount } from "../src/api/types";
import {
  type AccountLoginInput,
  allowFolderCommand,
  allowsInApp,
  beginLogin,
  commandInReason,
  computerKind,
  computerState,
  desktopTargetOf,
  downloadHref,
  folderName,
  foldersOfAgent,
  formatUserCode,
  freeDuplicate,
  installCommand,
  isHandheld,
  isPaused,
  locationText,
  normalizeUserCode,
  platformOf,
  shellQuote,
  toolOffReason,
  toolOnCommand,
} from "../src/lib/machines";
import { accessOf, applyComputerEvent, applyMachineEvent, pauseOf } from "../src/realtime/machines";

describe("connected computers helpers (ADR 0036)", () => {
  test("device codes: normalized for the API, shown with a dot to compare", () => {
    expect(normalizeUserCode(" k7q·4zp")).toBe("K7Q4ZP");
    // Letters that look alike (0/O, 1/I/L) are never in a code.
    expect(normalizeUserCode("O0I1L")).toBe("");
    expect(formatUserCode("K7Q4ZP")).toBe("K7Q·4ZP");
    expect(formatUserCode("K7Q")).toBe("K7Q");
  });

  test("commands: the installer has no code; granting quotes paths that need it", () => {
    expect(installCommand("https://agentes.chat/")).toBe(
      "curl -fsSL https://agentes.chat/api/machines/install.sh | sh",
    );
    expect(allowFolderCommand("/Users/you/Projects/loja-v5", "bento")).toBe(
      "agentes-runner folders allow /Users/you/Projects/loja-v5 --agent bento",
    );
    expect(allowFolderCommand("/Users/you/Meus Projetos")).toBe(
      "agentes-runner folders allow '/Users/you/Meus Projetos'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    // What a runner says is missing: the command in it, to copy.
    expect(commandInReason("Install what desktop use needs: `sudo apt install xdotool` (missing: xdotool)")).toBe(
      "sudo apt install xdotool",
    );
    expect(commandInReason("Desktop use runs on Linux computers only")).toBeNull();
    expect(commandInReason(null)).toBeNull();
  });

  test("folders: the name, and the ones an agent may use", () => {
    expect(folderName("/Users/you/Projects/loja-v5/")).toBe("loja-v5");
    expect(folderName("C:\\Users\\w\\docs")).toBe("docs");
    const access = {
      folders: [
        { path: "/a", agents: ["x"] },
        { path: "/b", agents: [] },
      ],
      tools: { claude: true, codex: false, commands: false },
    };
    expect(foldersOfAgent(access, "x").map((f) => f.path)).toEqual(["/a"]);
    expect(foldersOfAgent(null, "x")).toEqual([]);
  });

  test("pause: until resumed, until a time, or over", () => {
    const now = Date.parse("2026-10-17T15:00:00.000Z");
    expect(isPaused({ paused: { paused: true, until: null } }, now)).toBe(true);
    expect(isPaused({ paused: { paused: true, until: "2026-10-17T16:24:00.000Z" } }, now)).toBe(true);
    expect(isPaused({ paused: { paused: true, until: "2026-10-17T14:00:00.000Z" } }, now)).toBe(false);
    expect(isPaused({ paused: { paused: false } }, now)).toBe(false);
    expect(isPaused({}, now)).toBe(false);
  });

  test("events are checked before they touch the cache", () => {
    expect(pauseOf({ paused: true })).toEqual({ paused: true, until: null });
    // The server's own shape: `{ until }` while paused, null when not.
    expect(pauseOf({ until: "2026-10-17T16:24:00.000Z", timezone: null })).toEqual({
      paused: true,
      until: "2026-10-17T16:24:00.000Z",
    });
    expect(pauseOf(null)).toEqual({ paused: false });
    expect(isPaused({ paused: { until: null } })).toBe(true);
    expect(isPaused({ paused: null })).toBe(false);
    expect(pauseOf({ paused: false, until: "x" })).toEqual({ paused: false });
    expect(pauseOf("yes")).toBeUndefined();
    expect(accessOf(null)).toBeNull();
    expect(accessOf({ folders: "no" })).toBeUndefined();
  });

  test("download link and location", () => {
    expect(downloadHref("/api/desktop/download/0.2.0/a.dmg", "https://agentes.chat")).toBe(
      "https://agentes.chat/api/desktop/download/0.2.0/a.dmg",
    );
    expect(downloadHref("https://cdn.example/a.dmg", "https://agentes.chat")).toBe("https://cdn.example/a.dmg");
    expect(locationText({ city: "Curitiba", region: null, country: "Brasil" })).toBe("Curitiba, Brasil");
  });

  test("the app to download follows the visitor's system: one build for both Mac chips, x64 elsewhere", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
    const linux = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
    const arm = "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    expect([mac, windows, linux].map(platformOf)).toEqual(["mac", "windows", "linux"]);
    expect(desktopTargetOf(mac)).toEqual({ target: "darwin", arch: "aarch64" });
    expect(desktopTargetOf(windows)).toEqual({ target: "windows", arch: "x86_64" });
    expect(desktopTargetOf(linux)).toEqual({ target: "linux", arch: "x86_64" });
    // A phone reads as Linux or a Mac, and a Linux on ARM has no build: none of them gets one.
    expect([platformOf(android), platformOf(iphone)]).toEqual(["linux", "mac"]);
    expect([android, iphone, arm].map(desktopTargetOf)).toEqual([null, null, null]);
    expect([android, iphone, linux, mac].map(isHandheld)).toEqual([true, true, false, false]);
  });

  test("a tool turned off: the app's Preferences on a Mac or a PC, the command too elsewhere (sudo in system mode)", () => {
    expect(toolOnCommand({ mode: "single" }, "browser")).toBe("agentes-runner tools enable browser");
    expect(toolOnCommand({ mode: "system" }, "desktop")).toBe("sudo agentes-runner tools enable desktop");
    expect([allowsInApp("darwin"), allowsInApp("windows"), allowsInApp("linux"), allowsInApp("other")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(toolOffReason({ os: "darwin", mode: "single" }, "claude_code")).toEqual({
      key: "brain.reasons.tool_off",
      command: "",
    });
    expect(toolOffReason({ os: "windows", mode: "single" }, "codex").key).toBe("brain.reasons.tool_off");
    expect(toolOffReason({ os: "linux", mode: "system" }, "claude_code")).toEqual({
      key: "brain.reasons.tool_offLinux",
      command: "sudo agentes-runner tools enable claude",
    });
    expect(toolOffReason({ os: "linux", mode: "single" }, "codex").command).toBe("agentes-runner tools enable codex");
    // Not known yet: the app's line, as before.
    expect(toolOffReason(undefined, "codex").key).toBe("brain.reasons.tool_off");
  });

  test("portraits: the kind from the machine's os, the state with pause over online", () => {
    expect(computerKind("darwin")).toBe("mac");
    expect(computerKind("windows")).toBe("windows");
    expect(computerKind("linux")).toBe("linux");
    expect(computerKind("other")).toBe("linux");
    expect(computerKind(null)).toBe("linux");
    expect(computerState({ online: true, paused: null })).toBe("online");
    expect(computerState({ online: false, paused: null })).toBe("offline");
    expect(computerState({ online: true, paused: { until: null } })).toBe("paused");
    expect(computerState({ online: true, paused: { until: "2026-01-01T00:00:00Z" } }, Date.parse("2026-02-01"))).toBe(
      "online",
    );
  });

  test("the browser and who thinks refetch when the computer allows something new, or the agent moves", () => {
    const qc = new QueryClient();
    const browser = keys.agentBrowser("o1", "a1");
    const brain = keys.agentBrain("o1", "a1");
    const stale = () => [browser, brain].map((k) => qc.getQueryState(k)?.isInvalidated ?? false);
    const fresh = () => {
      qc.setQueryData(browser, { available: false });
      qc.setQueryData(brain, { brain: "model" });
    };
    fresh();
    // A rename alone changes neither.
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", name: "Mac" } as { type: string });
    expect(stale()).toEqual([false, false]);
    // The person turned the browser on in the app's Ferramentas: no reload needed.
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", access: true } as { type: string });
    expect(stale()).toEqual([true, true]);
    fresh();
    applyComputerEvent(qc, "o1", { type: "agent.computer", agentId: "a1", target: { kind: "none" } } as {
      type: string;
    });
    expect(stale()).toEqual([true, true]);
  });

  test("a sign-in starts with no address asked: Claude's hint is the account's own, dropped if the server refuses it", async () => {
    const sent: AccountLoginInput[] = [];
    const begin = async (input: AccountLoginInput) => {
      sent.push(input);
      return input;
    };
    // A first sign-in names nothing; signing in again names the account, and Claude gets its email as the hint.
    expect(await beginLogin(begin, "claude_code", {})).toEqual({});
    expect(await beginLogin(begin, "claude_code", { again: "a1", hint: "walt@acme.com" })).toEqual({
      accountId: "a1",
      email: "walt@acme.com",
    });
    // ChatGPT and a coding plan's key take no hint.
    expect(await beginLogin(begin, "codex", { again: "a2", hint: "walt@acme.com" })).toEqual({ accountId: "a2" });
    expect(await beginLogin(begin, "claude_code", { provider: "zai", hint: "walt@acme.com" })).toEqual({
      provider: "zai",
    });
    // The hint only steered Claude's page: refused, the sign-in starts without it; anything else stays an error.
    const strict = async (input: AccountLoginInput) => {
      if (input.email) throw new ApiError(400, "account.invalid_email", "Use a plain email address");
      return begin(input);
    };
    sent.length = 0;
    expect(await beginLogin(strict, "claude_code", { again: "a1", hint: "o'brien@acme.com" })).toEqual({
      accountId: "a1",
    });
    expect(sent).toEqual([{ accountId: "a1" }]);
    const offline = async (): Promise<AccountLoginInput> => {
      throw new ApiError(409, "machine.offline", "Offline");
    };
    expect(await beginLogin(offline, "claude_code", { hint: "walt@acme.com" }).catch((e) => e.code)).toBe(
      "machine.offline",
    );
  });

  test("the account a sign-in came back as, already there: theirs to use while it's signed in and thinks for no one", () => {
    const account: MachineAccount = {
      id: "a1",
      kind: "claude_code",
      label: "Claude Max",
      email: "walt@acme.com",
      plan: "max",
      status: "active",
      ownerId: "u1",
      ownerName: "Walter",
      mine: true,
      usedBy: [],
      usage: null,
      provider: null,
      keyHint: null,
    };
    const failed = (duplicate: AccountLoginStatus["duplicate"]): AccountLoginStatus => ({ state: "failed", duplicate });
    expect(freeDuplicate(failed({ label: "Claude Max", account }))).toBe(account);
    expect(freeDuplicate(failed({ label: "Claude Max", account: { ...account, usedBy: ["Theo"] } }))).toBeNull();
    expect(freeDuplicate(failed({ label: "Claude Max", account: { ...account, status: "signed_out" } }))).toBeNull();
    // An older server names it only.
    expect(freeDuplicate(failed({ label: "Claude Max" }))).toBeNull();
    expect(freeDuplicate({ state: "failed" })).toBeNull();
    expect(freeDuplicate(undefined)).toBeNull();
  });
});
