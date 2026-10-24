import { describe, expect, test } from "bun:test";
import { BRAIN_PROTOCOL, MISSION_PROTOCOL } from "@agenteschat/adapters";
import {
  brainModelId,
  brainOf,
  brainOptions,
  defaultBrainModel,
  executorBrain,
  normalizeBrainModel,
} from "../src/brain-settings";

const mac = (patch: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "mac",
  protocol: BRAIN_PROTOCOL,
  execAllowed: true,
  executors: { claude: { version: "2.1.0" }, detectedAt: "2026-10-17" },
  online: true,
  lastSeenAt: new Date(),
  deletedAt: null,
  ...patch,
});

describe("brain settings", () => {
  test("stored values read back; executors map to brains", () => {
    expect(brainOf("claude_code")).toBe("claude_code");
    expect(brainOf("robot")).toBe("model");
    expect(brainOf(null)).toBe("model");
    expect(executorBrain("claude")).toBe("claude_code");
    expect(executorBrain("codex")).toBe("codex");
    expect(executorBrain("agent")).toBe("model");
  });

  test("models: Claude Code aliases mapped to today's ids, Codex free text, defaults", () => {
    expect(normalizeBrainModel("claude_code", "Opus")).toBe("opus");
    expect(normalizeBrainModel("claude_code", "claude-sonnet-5-5")).toBe("sonnet");
    expect(normalizeBrainModel("claude_code", null)).toBeNull();
    expect(() => normalizeBrainModel("claude_code", "gpt-6-sol")).toThrow();
    expect(normalizeBrainModel("codex", "gpt-6.1-codex")).toBe("gpt-6.1-codex");
    expect(() => normalizeBrainModel("codex", "rm -rf /")).toThrow();
    expect(() => normalizeBrainModel("model", "opus")).toThrow();
    expect(defaultBrainModel("claude_code")).toBe("sonnet");
    expect(defaultBrainModel("codex")).toBe("gpt-6.1-sol");
    expect(defaultBrainModel("model")).toBeNull();
    expect(brainModelId("claude_code", "opus")).toBe("claude-opus-5-5");
    expect(brainModelId("claude_code", null)).toBe("claude-sonnet-5-5");
    expect(brainModelId("codex", "gpt-6.1-codex")).toBe("gpt-6.1-codex");
  });

  test("options: only what the computer has; why the rest can't be chosen", () => {
    const reasons = (m: ReturnType<typeof mac> | null) =>
      brainOptions(m).map((o) => [o.kind, o.available, o.reason ?? null]);
    expect(reasons(null)).toEqual([
      ["model", true, null],
      ["claude_code", false, "no_computer"],
      ["codex", false, "no_computer"],
    ]);
    expect(reasons(mac())).toEqual([
      ["model", true, null],
      ["claude_code", true, null],
      ["codex", false, "not_installed"],
    ]);
    expect(reasons(mac({ execAllowed: false }))[1]).toEqual(["claude_code", false, "exec_off"]);
    expect(reasons(mac({ protocol: MISSION_PROTOCOL - 1 }))[1]).toEqual(["claude_code", false, "runner_old"]);
    // A runner with missions (protocol 5–7) but without `brain.turn`: the engine would refuse every run.
    expect(reasons(mac({ protocol: BRAIN_PROTOCOL - 1 })).slice(1)).toEqual([
      ["claude_code", false, "runner_old"],
      ["codex", false, "runner_old"],
    ]);
    expect(reasons(mac({ protocol: BRAIN_PROTOCOL }))[1]).toEqual(["claude_code", true, null]);
    const oldCodex = mac({ executors: { codex: { version: "codex-cli 0.100.0" }, detectedAt: "x" } });
    expect(reasons(oldCodex).slice(1)).toEqual([
      ["claude_code", false, "not_installed"],
      ["codex", false, "outdated"],
    ]);
    const both = mac({ executors: { claude: { version: "2" }, codex: { version: "0.170.0" }, detectedAt: "x" } });
    expect(brainOptions(both).every((o) => o.available)).toBe(true);
    expect(brainOptions(both).find((o) => o.kind === "codex")?.experimental).toBe(true);
    // Installed but turned off in the app's Tools: says so (not "not installed"); turned on, available.
    const off = mac({ ...both, access: { tools: { claude: false, codex: true } } });
    expect(reasons(off).slice(1)).toEqual([
      ["claude_code", false, "tool_off"],
      ["codex", true, null],
    ]);
    expect(reasons(mac({ access: { tools: { claude: true } } }))[1]).toEqual(["claude_code", true, null]);
  });
});
