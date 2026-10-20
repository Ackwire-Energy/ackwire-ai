import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import {
  allowFolderCommand,
  computerKind,
  computerState,
  downloadHref,
  folderName,
  foldersOfAgent,
  formatUserCode,
  installCommand,
  isPaused,
  locationText,
  normalizeUserCode,
  shellQuote,
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
    expect(allowFolderCommand("/Users/walter/Projects/viajolo-v5", "bento")).toBe(
      "agentes-runner folders allow /Users/walter/Projects/viajolo-v5 --agent bento",
    );
    expect(allowFolderCommand("/Users/walter/Meus Projetos")).toBe(
      "agentes-runner folders allow '/Users/walter/Meus Projetos'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("folders: the name, and the ones an agent may use", () => {
    expect(folderName("/Users/walter/Projects/viajolo-v5/")).toBe("viajolo-v5");
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

  test("portraits: the kind from the machine's os, the state with pause over online", () => {
    expect(computerKind("darwin")).toBe("mac");
    expect(computerKind("windows")).toBe("windows");
    expect(computerKind("linux")).toBe("linux");
    expect(computerKind("other")).toBe("linux");
    expect(computerKind(null)).toBe("linux");
    expect(computerKind("darwin", true)).toBe("cloud");
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
    applyComputerEvent(qc, "o1", { type: "agent.computer", agentId: "a1", target: { kind: "cloud" } } as {
      type: string;
    });
    expect(stale()).toEqual([true, true]);
  });
});
