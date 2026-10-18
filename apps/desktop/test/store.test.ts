import { expect, test } from "bun:test";
import type { ControlEvent, ControlStatus } from "@agenteschat/adapters/runner-control";
import { DesktopStore } from "../src/control/store";
import type { Host } from "../src/host/types";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function status(logoEtag?: string): ControlStatus {
  return {
    paired: true,
    org: { id: "o1", name: "Acme", ...(logoEtag ? { logoEtag } : {}) },
    connection: "online",
    version: "0.1.0",
    protocol: 10,
    paused: { paused: false, until: null },
    executors: {},
    agents: [],
  };
}

/** A host with one running home whose runner answers from `state`. */
function setup() {
  const state = { status: status('"a.png"'), logo: PNG as string | null, logoAsks: 0 };
  let onLine: (homeId: string, line: string) => void = () => {};
  const host = {
    window: "popover",
    fake: true,
    listRunners: async () => [{ homeId: "h1", dir: "/tmp/h1", running: true, hello: null }],
    onLine: (cb: typeof onLine) => {
      onLine = cb;
      return () => {};
    },
    onRunnerState: () => () => {},
    send: async (homeId: string, line: string) => {
      const req = JSON.parse(line) as { id: string; type: string };
      let data: unknown = {};
      if (req.type === "status") data = state.status;
      if (req.type === "jobs") data = { jobs: [] };
      if (req.type === "access.pending") data = { requests: [] };
      if (req.type === "access.get") data = { folders: [], tools: { claude: false, codex: false, commands: false } };
      if (req.type === "org.logo") {
        state.logoAsks += 1;
        data = { logo: state.logo };
      }
      queueMicrotask(() => onLine(homeId, JSON.stringify({ type: "reply", id: req.id, ok: true, data })));
    },
  } as unknown as Host;
  const store = new DesktopStore(host, { idPrefix: "t" });
  const event = (e: ControlEvent) => onLine("h1", JSON.stringify({ type: "event", event: e }));
  return { store, state, event };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("the org logo: asked once per etag, again when it changes, cleared when the runner has none", async () => {
  const { store, state, event } = setup();
  store.start();
  await settle();
  expect(store.home("h1")?.logo).toBe(PNG);
  expect(state.logoAsks).toBe(1);

  // Same etag: not asked again.
  event({ kind: "status", status: status('"a.png"') });
  await settle();
  expect(state.logoAsks).toBe(1);

  // A new logo: asked again.
  state.logo = "data:image/webp;base64,UklGRg==";
  event({ kind: "status", status: status('"b.webp"') });
  await settle();
  expect(state.logoAsks).toBe(2);
  expect(store.home("h1")?.logo).toBe("data:image/webp;base64,UklGRg==");

  // Removed on the site: back to the initial.
  event({ kind: "status", status: status() });
  await settle();
  expect(store.home("h1")?.logo).toBeNull();

  // Anything that isn't a PNG/JPEG/WebP data URL is not drawn.
  state.logo = "https://evil.example/logo.png";
  event({ kind: "status", status: status('"c.png"') });
  await settle();
  expect(store.home("h1")?.logo).toBeNull();
});
