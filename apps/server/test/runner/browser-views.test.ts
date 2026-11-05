import { expect, test } from "bun:test";
import { decodeBrowserFrame, type RunnerFrame, STREAM_CLOSE } from "@agenteschat/adapters/machine-protocol";
import { BrowserViews } from "../../runner/browser-views";
import type { DataListener, DataSocket } from "../../runner/streams";
import { waitFor } from "./helpers";

type Frame = Extract<RunnerFrame, { type: "browser.frame" }>;

/** A view's data socket in memory: what went out on it, how it closed, and the server's side to answer on. */
class FakeData {
  sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | null = null;
  listener: DataListener | null = null;
  readonly socket: DataSocket = {
    send: (data) => {
      if (typeof data !== "string") this.sent.push(data);
    },
    close: (code, reason) => {
      if (this.closed) return;
      this.closed = { code, reason };
      this.listener?.closed();
    },
    bufferedAmount: 0,
    listen: (on) => {
      this.listener = on;
    },
  };
  /** The server answers a frame. */
  ack() {
    this.listener?.control?.({ type: "ack" });
  }
  /** The frames sent, as their `seq`. */
  seqs() {
    return this.sent.map((bytes) => decodeBrowserFrame(bytes)?.seq);
  }
}

const frame = (agentId: string, seq: number): Frame => ({
  type: "browser.frame",
  agentId,
  seq,
  data: Buffer.from([0xff, 0xd8, seq, 0xff, 0xd9]).toString("base64"),
  metadata: { deviceWidth: 1280, deviceHeight: 800, url: "https://shop.example.com/" },
});

function setup(opts: { window?: number; stallMs?: number } = {}) {
  const dialed: { streamId: string; data: FakeData }[] = [];
  const views = new BrowserViews({
    ...opts,
    dial: async (streamId) => {
      const data = new FakeData();
      dialed.push({ streamId, data });
      return data.socket;
    },
  });
  return { views, dialed, last: () => dialed.at(-1)?.data as FakeData };
}

test("an agent with no view: its frames are the caller's to send as before", () => {
  const { views } = setup();
  expect(views.push(frame("ana", 1))).toBe(false);
});

test("a view's frames go as bytes, at most the window's on their way; only the newest waits for an ack", async () => {
  const { views, dialed, last } = setup({ window: 2 });
  expect(await views.open("ana", "S".repeat(43))).toEqual({ opened: true });
  expect(dialed[0]?.streamId).toBe("S".repeat(43));
  const data = last();
  for (const seq of [1, 2, 3, 4]) expect(views.push(frame("ana", seq))).toBe(true);
  // 3 never goes: 4 came while the window was still full.
  expect(data.seqs()).toEqual([1, 2]);
  const sent = decodeBrowserFrame(data.sent[0] as Uint8Array);
  expect(sent?.metadata).toEqual(frame("ana", 1).metadata);
  expect([...(sent?.jpeg ?? [])]).toEqual([0xff, 0xd8, 1, 0xff, 0xd9]);
  data.ack();
  expect(data.seqs()).toEqual([1, 2, 4]);
  // Acks with nothing waiting free the window for what comes next.
  data.ack();
  data.ack();
  views.push(frame("ana", 5));
  views.push(frame("ana", 6));
  expect(data.seqs()).toEqual([1, 2, 4, 5, 6]);
  // Another agent's frames aren't this view's.
  expect(views.push(frame("bia", 1))).toBe(false);
});

test("a full window with no ack for a while sends the newest frame anyway", async () => {
  const { views, last } = setup({ window: 1, stallMs: 5 });
  await views.open("ana", "S".repeat(43));
  for (const seq of [1, 2, 3]) views.push(frame("ana", seq));
  expect(last().seqs()).toEqual([1]);
  await waitFor(() => last().seqs().length === 2);
  expect(last().seqs()).toEqual([1, 3]);
});

test("a view ends with its stream, its socket, the connection, or a new view of the same agent", async () => {
  const { views, dialed } = setup();
  await views.open("ana", "A".repeat(43));
  await views.open("bia", "B".repeat(43));
  const [ana, bia] = dialed.map((d) => d.data) as [FakeData, FakeData];
  // The stream ended: its view closes, and frames go back to the caller.
  views.end("ana");
  expect(ana.closed?.code).toBe(STREAM_CLOSE.normal);
  expect(views.push(frame("ana", 1))).toBe(false);
  // The server closed it.
  bia.socket.close(STREAM_CLOSE.restarting);
  expect(views.push(frame("bia", 1))).toBe(false);
  // A new view of the same agent replaces the one it had.
  await views.open("ana", "C".repeat(43));
  await views.open("ana", "D".repeat(43));
  expect(dialed[2]?.data.closed?.code).toBe(STREAM_CLOSE.normal);
  expect(views.viewing()).toEqual(["ana"]);
  views.closeAll();
  expect(dialed[3]?.data.closed?.code).toBe(STREAM_CLOSE.normal);
  expect(views.viewing()).toEqual([]);
});

test("a dial that fails leaves no view: frames go as before", async () => {
  const views = new BrowserViews({ dial: () => Promise.reject(new Error("refused")) });
  await expect(views.open("ana", "S".repeat(43))).rejects.toThrow("refused");
  expect(views.push(frame("ana", 1))).toBe(false);
});
