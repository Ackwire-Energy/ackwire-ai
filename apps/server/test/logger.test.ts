import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createFakeErrorReporter } from "@agenteschat/adapters";
import { createLogger } from "../src/logger";

describe("logger", () => {
  let out: ReturnType<typeof spyOn<Console, "log">>;
  let err: ReturnType<typeof spyOn<Console, "error">>;
  beforeEach(() => {
    out = spyOn(console, "log").mockImplementation(() => {});
    err = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    out.mockRestore();
    err.mockRestore();
  });
  const written = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => JSON.parse(String(call[0])));

  test("the default format writes level and msg, with no severity", () => {
    createLogger("debug").info("booted", { port: 3000 });
    const [line] = written(out);
    expect(line.level).toBe("info");
    expect(line.msg).toBe("booted");
    expect(line.port).toBe(3000);
    expect("severity" in line).toBe(false);
    expect("message" in line).toBe(false);
    expect(Object.keys(line)).toEqual(["time", "level", "msg", "port"]);
  });

  test("gcp writes severity and message instead, and warn becomes WARNING", () => {
    const log = createLogger("debug", undefined, "gcp");
    log.debug("d");
    log.info("i");
    log.warn("w", { orgId: "o" });
    const lines = written(out);
    expect(lines.map((line) => line.severity)).toEqual(["DEBUG", "INFO", "WARNING"]);
    expect(lines.map((line) => line.message)).toEqual(["d", "i", "w"]);
    expect(lines[2].orgId).toBe("o");
    expect("level" in lines[0]).toBe(false);
    expect("msg" in lines[0]).toBe(false);
    expect(Number.isNaN(Date.parse(lines[0].time))).toBe(false);
  });

  test("the minimum level still filters in gcp", () => {
    const log = createLogger("warn", undefined, "gcp");
    log.debug("d");
    log.info("i");
    log.warn("w");
    expect(written(out).map((line) => line.message)).toEqual(["w"]);
  });

  test("a gcp error goes to stderr and is reported", () => {
    const errors = createFakeErrorReporter();
    const boom = new Error("boom");
    createLogger("info", errors, "gcp").error("job failed", { error: boom, job: "x" });
    expect(out).not.toHaveBeenCalled();
    const [line] = written(err);
    expect(line.severity).toBe("ERROR");
    expect(line.message).toBe("job failed");
    expect(errors.reports).toHaveLength(1);
    expect(errors.reports[0]?.error).toBe(boom);
    expect(errors.reports[0]?.tags.job).toBe("x");
  });

  test("a gcp error carries its stack as stack_trace and keeps the short message", () => {
    const boom = new Error("boom");
    createLogger("info", undefined, "gcp").error("job failed", { error: boom });
    const [line] = written(err);
    expect(line.stack_trace).toBe(boom.stack);
    expect(line.message).toBe("job failed");
    expect(line.error).toBe("Error: boom");
  });

  test("a gcp error that is not an Error has no stack_trace", () => {
    createLogger("info", undefined, "gcp").error("job failed", { error: "text" });
    const [line] = written(err);
    expect("stack_trace" in line).toBe(false);
    expect(line.error).toBe("text");
  });

  test("the json format never writes stack_trace", () => {
    createLogger("info").error("job failed", { error: new Error("boom") });
    const [line] = written(err);
    expect("stack_trace" in line).toBe(false);
  });

  test("gcp fields named severity or message do not replace the level or the text", () => {
    createLogger("info", undefined, "gcp").info("booted", { severity: "x", message: "y" });
    const [line] = written(out);
    expect(line.severity).toBe("INFO");
    expect(line.message).toBe("booted");
  });
});
