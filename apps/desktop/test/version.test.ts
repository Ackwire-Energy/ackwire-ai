import { describe, expect, test } from "bun:test";
import {
  archParam,
  compareVersions,
  isNewer,
  latestUrl,
  noteLines,
  parseLatest,
  targetParam,
  updateStateOf,
} from "../src/control/version";

describe("compareVersions", () => {
  test("numeric order, not text order", () => {
    expect(compareVersions("0.10.0", "0.9.3")).toBe(1);
    expect(compareVersions("0.9.3", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });
  test("a prerelease comes before its release", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });
  test("isNewer", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
  });
});

describe("latest release", () => {
  test("the URL names the platform and the architecture as the server reads them", () => {
    expect(archParam("aarch64")).toBe("arm64");
    expect(archParam("x86_64")).toBe("x64");
    expect(targetParam("macos")).toBe("darwin");
    expect(targetParam("windows")).toBe("windows");
    expect(targetParam("linux")).toBe("linux");
    expect(latestUrl("macos", "aarch64")).toBe("https://hub.ackwire.app/api/desktop/latest?target=darwin&arch=arm64");
    expect(latestUrl("windows", "x86_64")).toBe("https://hub.ackwire.app/api/desktop/latest?target=windows&arch=x64");
    expect(latestUrl("linux", "x86_64")).toBe("https://hub.ackwire.app/api/desktop/latest?target=linux&arch=x64");
  });
  test("parses the endpoint and refuses downloads off our site", () => {
    const ok = parseLatest({
      version: "0.2.0",
      url: "https://hub.ackwire.app/api/desktop/download/0.2.0/agentes_0.2.0_universal.dmg",
      sha256: "abc",
      notes: "- Pastas\n- Pedidos",
    });
    expect(ok?.version).toBe("0.2.0");
    expect(parseLatest({ version: "0.2.0", url: "https://evil.example/agentes.dmg" })).toBeNull();
    expect(parseLatest({ version: "x", url: "https://hub.ackwire.app/x" })).toBeNull();
    expect(parseLatest(null)).toBeNull();
  });
  test("available and required", () => {
    const latest = { version: "0.3.0", url: "https://hub.ackwire.app/d", minVersion: "0.2.0" };
    expect(updateStateOf("0.1.0", latest)).toMatchObject({ available: true, required: true });
    expect(updateStateOf("0.2.5", latest)).toMatchObject({ available: true, required: false });
    expect(updateStateOf("0.3.0", latest)).toMatchObject({ available: false, required: false });
    expect(updateStateOf("0.1.0", null)).toMatchObject({ available: false, required: false });
  });
  test("notes become list lines", () => {
    expect(noteLines("## 0.2.0\n- Pastas\n* Pedidos\n\nTarefas longas")).toEqual([
      "Pastas",
      "Pedidos",
      "Tarefas longas",
    ]);
  });
});
