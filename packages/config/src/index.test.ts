import { describe, expect, test } from "bun:test";
import { ConfigError, envVars, loadConfig, redactConfig, testConfig } from "./index";
import { parsePemKey } from "./pem";

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
    expect(config.LANDING_PAGE).toBe(false);
    expect(config.S3_PATH_STYLE).toBe(false);
    expect(config.MILLIONSEND_API_URL).toBe("https://api.millionsend.com");
    // Unset: the email senders use ola@ on the host of PUBLIC_URL.
    expect(config.EMAIL_FROM).toBeUndefined();
  });

  test("FILES_DIR must be absolute; SMTP_URL must be smtp:// or smtps://", () => {
    expect(loadConfig({ ...valid, FILES_DIR: "/data/files" }).FILES_DIR).toBe("/data/files");
    expect(() => loadConfig({ ...valid, FILES_DIR: "data/files" })).toThrow(/FILES_DIR/);
    expect(loadConfig({ ...valid, SMTP_URL: "smtps://u:p@smtp.example.com:465" }).SMTP_URL).toBe(
      "smtps://u:p@smtp.example.com:465",
    );
    expect(() => loadConfig({ ...valid, SMTP_URL: "https://smtp.example.com" })).toThrow(/SMTP_URL/);
    // An unencoded / in the password (AWS SES passwords are base64) fails here, not inside nodemailer at boot.
    const unencoded = "smtps://AKIA:abc/def+ghi@email-smtp.us-east-1.amazonaws.com:465";
    expect(() => loadConfig({ ...valid, SMTP_URL: unencoded })).toThrow(/SMTP_URL: .*percent-encoded/);
    expect(loadConfig({ ...valid, SMTP_URL: "smtp://u:abc%2Fdef@smtp.example.com:587" }).SMTP_URL).toBe(
      "smtp://u:abc%2Fdef@smtp.example.com:587",
    );
  });

  test("agentes.chat's own site keeps its landing page and legal links without extra settings", () => {
    const site = loadConfig({ ...valid, PUBLIC_URL: "https://agentes.chat" });
    expect(site.LANDING_PAGE).toBe(true);
    expect(site.TERMS_URL).toBe("https://agentes.chat/terms");
    expect(site.PRIVACY_URL).toBe("https://agentes.chat/privacy");
    expect(loadConfig({ ...valid, PUBLIC_URL: "https://agentes.chat", LANDING_PAGE: "false" }).LANDING_PAGE).toBe(
      false,
    );
    const selfHosted = loadConfig({ ...valid, PUBLIC_URL: "https://chat.example.com" });
    expect([selfHosted.LANDING_PAGE, selfHosted.TERMS_URL, selfHosted.PRIVACY_URL]).toEqual([
      false,
      undefined,
      undefined,
    ]);
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

  test("external provisioning needs the operator API, which serves its requests, and no computer of the server's own", () => {
    expect(loadConfig(valid).MACHINE_PROVISIONING).toBe("off");
    expect(() => loadConfig({ ...valid, MACHINE_PROVISIONING: "external" })).toThrow(/OPERATOR_API_TOKEN/);
    const token = "t".repeat(32);
    const external = { ...valid, MACHINE_PROVISIONING: "external", OPERATOR_API_TOKEN: token };
    expect(loadConfig(external).MACHINE_PROVISIONING).toBe("external");
    expect(() => loadConfig({ ...external, HOST_COMPUTER_TOKEN: "h".repeat(32) })).toThrow(/HOST_COMPUTER_TOKEN/);
    expect(loadConfig({ ...valid, HOST_COMPUTER_TOKEN: "h".repeat(32) }).HOST_COMPUTER_TOKEN).toBe("h".repeat(32));
  });

  test("the usage report is on unless TELEMETRY says off (on/off, or any yes/no word)", () => {
    expect(loadConfig(valid).TELEMETRY).toBe("on");
    expect(loadConfig(valid).TELEMETRY_URL).toBe("https://telemetry.agentes.chat/v1/report");
    expect(loadConfig({ ...valid, TELEMETRY: "off" }).TELEMETRY).toBe("off");
    expect(loadConfig({ ...valid, TELEMETRY: "false" }).TELEMETRY).toBe("off");
    expect(loadConfig({ ...valid, TELEMETRY: "on" }).TELEMETRY).toBe("on");
    expect(() => loadConfig({ ...valid, TELEMETRY: "sometimes" })).toThrow(/TELEMETRY/);
    expect(loadConfig(valid).INSTALL_MODE).toBeUndefined();
    expect(() => loadConfig({ ...valid, INSTALL_MODE: "kubernetes" })).toThrow(/INSTALL_MODE/);
  });

  test("ignores variables that are not in the schema", () => {
    const config = loadConfig({ ...valid, SOMETHING_ELSE: "1" }) as Record<string, unknown>;
    expect(config.SOMETHING_ELSE).toBeUndefined();
  });
});

describe("redactConfig", () => {
  test("masks every secret", () => {
    const redacted = redactConfig(
      loadConfig({ ...valid, GITHUB_CLIENT_SECRET: "gh", SMTP_URL: "smtps://u:p@smtp.example.com" }),
    );
    expect(redacted.DATABASE_URL).toBe("********");
    expect(redacted.AGENTES_SECRET).toBe("********");
    expect(redacted.GITHUB_CLIENT_SECRET).toBe("********");
    expect(redacted.SMTP_URL).toBe("********");
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

describe("GITHUB_APP_PRIVATE_KEY", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef==\n-----END RSA PRIVATE KEY-----";

  test("accepts the PEM, the PEM with \\n, and base64 of the PEM file", () => {
    expect(parsePemKey(`${pem}\n`)).toBe(pem);
    expect(parsePemKey(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(parsePemKey(Buffer.from(`${pem}\n`).toString("base64"))).toBe(pem);
    expect(
      loadConfig({ ...valid, GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64") }).GITHUB_APP_PRIVATE_KEY,
    ).toBe(pem);
  });

  test("anything else fails the config with a clear message", () => {
    expect(() => parsePemKey("not-a-key")).toThrow("base64 of the PEM file");
    expect(() => loadConfig({ ...valid, GITHUB_APP_PRIVATE_KEY: "not-a-key" })).toThrow("GITHUB_APP_PRIVATE_KEY");
  });
});
