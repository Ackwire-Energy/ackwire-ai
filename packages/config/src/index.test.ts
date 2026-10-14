import { describe, expect, test } from "bun:test";
import { ConfigError, envVars, loadConfig, redactConfig, testConfig } from "./index";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  AGENTES_SECRET: "x".repeat(48),
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.RUN_MIGRATIONS_ON_BOOT).toBe(true);
    expect(config.ALLOW_SIGNUP).toBe(false);
    expect(config.AGENT_DEFAULT_MODEL).toBe("claude-sonnet-5-5");
    expect(config.ROUTER_MODEL).toBe("claude-haiku-5-5");
    expect(config.AGENT_MAX_HOPS).toBe(3);
  });

  test("treats empty strings as unset", () => {
    expect(loadConfig({ ...valid, PORT: "" }).PORT).toBe(3000);
  });

  test("parses booleans and numbers", () => {
    const config = loadConfig({ ...valid, PORT: "8080", ALLOW_SIGNUP: "true", AGENT_MAX_HOPS: "5" });
    expect(config.PORT).toBe(8080);
    expect(config.ALLOW_SIGNUP).toBe(true);
    expect(config.AGENT_MAX_HOPS).toBe(5);
  });

  test("reports every problem at once", () => {
    try {
      loadConfig({ PORT: "nope" });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("DATABASE_URL is required");
      expect(issues).toContain("AGENTES_SECRET is required");
      expect(issues).toContain("PORT:");
    }
  });

  test("rejects a short secret and a non-postgres URL", () => {
    expect(() => loadConfig({ ...valid, AGENTES_SECRET: "short" })).toThrow(/AGENTES_SECRET/);
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  test("rejects malformed model ids", () => {
    expect(() => loadConfig({ ...valid, AGENT_DEFAULT_MODEL: "Claude Sonnet" })).toThrow(/AGENT_DEFAULT_MODEL/);
  });

  test("ignores variables that are not in the schema", () => {
    const config = loadConfig({ ...valid, SOMETHING_ELSE: "1" }) as Record<string, unknown>;
    expect(config.SOMETHING_ELSE).toBeUndefined();
  });
});

describe("redactConfig", () => {
  test("masks every secret", () => {
    const redacted = redactConfig(loadConfig({ ...valid, GITHUB_CLIENT_SECRET: "gh" }));
    expect(redacted.DATABASE_URL).toBe("********");
    expect(redacted.AGENTES_SECRET).toBe("********");
    expect(redacted.GITHUB_CLIENT_SECRET).toBe("********");
    expect(redacted.PORT).toBe(3000);
  });

  test("every secret-looking variable is flagged secret", () => {
    for (const [name, def] of Object.entries(envVars)) {
      if (/SECRET|DATABASE_URL/.test(name))
        expect({ name, secret: (def as { secret?: boolean }).secret }).toEqual({ name, secret: true });
    }
  });
});

test("testConfig needs no environment", () => {
  expect(testConfig().NODE_ENV).toBe("test");
});

test(".env.example is up to date with the schema", async () => {
  const proc = Bun.spawnSync(["bun", `${import.meta.dir}/../scripts/generate-docs.ts`, "--check"]);
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
});
