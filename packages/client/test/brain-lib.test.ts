import { describe, expect, test } from "bun:test";
import { engineOfBrain, engineOfExecutor, engineStateOfOption } from "../src/lib/brain";

describe("the engine an agent thinks with (IconesMotor.html)", () => {
  test("agents.brain maps to its engine; the API and anything unknown is the agent itself", () => {
    expect(engineOfBrain("claude_code")).toBe("claude_code");
    expect(engineOfBrain("codex")).toBe("codex");
    expect(engineOfBrain("model")).toBe("agent");
    expect(engineOfBrain("something_new")).toBe("agent");
    expect(engineOfBrain(null)).toBe("agent");
    expect(engineOfBrain(undefined)).toBe("agent");
  });

  test("a mission's executor maps to the same engines", () => {
    expect(engineOfExecutor("claude")).toBe("claude_code");
    expect(engineOfExecutor("codex")).toBe("codex");
    expect(engineOfExecutor("agent")).toBe("agent");
    expect(engineOfExecutor(null)).toBe("agent");
  });

  test("an option is off when it can't run now or its computer is offline; the API never is", () => {
    const online = { online: true };
    const offline = { online: false };
    expect(engineStateOfOption({ kind: "claude_code", available: true }, online)).toBe("idle");
    expect(engineStateOfOption({ kind: "claude_code", available: true }, offline)).toBe("off");
    expect(engineStateOfOption({ kind: "codex", available: false }, online)).toBe("off");
    expect(engineStateOfOption({ kind: "codex", available: true }, null)).toBe("idle");
    expect(engineStateOfOption({ kind: "model", available: true }, offline)).toBe("idle");
    expect(engineStateOfOption({ kind: "model", available: false })).toBe("idle");
  });
});
