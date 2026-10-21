import { describe, expect, test } from "bun:test";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import { serverFromPref, siteOf } from "../src/control/server";
import type { Home } from "../src/control/store";

const home = (status: Partial<ControlStatus> | null): Home => ({
  homeId: "h1",
  dir: "/tmp/h1",
  running: true,
  hello: null,
  status: status
    ? {
        paired: true,
        connection: "online",
        version: "0.7.0",
        protocol: 12,
        paused: { paused: false },
        executors: {},
        agents: [],
        browsers: [],
        ...status,
      }
    : null,
  jobs: [],
  requests: [],
  access: null,
  logo: null,
});

describe("the server the app signs in to", () => {
  test("agentes.chat until another one is chosen", () => {
    expect(serverFromPref(null)).toBe("https://agentes.chat");
    expect(serverFromPref("https://box.tail1234.ts.net")).toBe("https://box.tail1234.ts.net");
    expect(serverFromPref("http://box.tail1234.ts.net")).toBe("https://agentes.chat");
  });

  test("the site opens on the organization's own server, else on the chosen one", () => {
    const chosen = "https://box.tail1234.ts.net";
    expect(siteOf([home({ server: "https://chat.example.com" })], chosen)).toBe("https://chat.example.com");
    expect(siteOf([home({ paired: false, server: "https://chat.example.com" })], chosen)).toBe(chosen);
    expect(siteOf([home(null)], chosen)).toBe(chosen);
    expect(siteOf([], chosen)).toBe(chosen);
  });
});
