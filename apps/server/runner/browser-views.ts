import {
  BROWSER_VIEW,
  encodeBrowserFrame,
  type RunnerFrame,
  STREAM_CLOSE,
} from "@agenteschat/adapters/machine-protocol";
import type { DataSocket } from "./streams";

type Frame = Extract<RunnerFrame, { type: "browser.frame" }>;

interface View {
  agentId: string;
  socket: DataSocket;
  /** Frames sent and not acknowledged yet. */
  inflight: number;
  /** The newest frame while the window is full: it goes at the next acknowledgement, older ones never do. */
  held: Frame | null;
  stall: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export interface BrowserViewsOptions {
  /** Dials the data socket `streamId` names (`DataSockets.dial`, counted as `browserView`). */
  dial(streamId: string): Promise<DataSocket>;
  /** Tests: smaller or shorter than `BROWSER_VIEW`. */
  window?: number;
  stallMs?: number;
}

/**
 * The live views of the agents' browsers on this computer (ADR 0040 §7.1, protocol 46): one data socket per agent
 * (or browser profile) the server asked for with `browser.view.open`, held by the process that holds the server's
 * connection (root in system mode: the workers pass their frames up as before, and only root has the machine's
 * token). That agent's frames go there as bytes (`encodeBrowserFrame`), never as `browser.frame` on the machine
 * socket, so a picture never delays a command and the bytes carry no base64. At most `window` frames are on their
 * way unacknowledged (the server answers each with `{"type":"ack"}`); a frame that finds the window full waits in
 * place of the one waiting before it. A slow link then shows the page as it is now, never the seconds it fell
 * behind. Frames of an agent with no view are the caller's to send as before.
 */
export class BrowserViews {
  private readonly views = new Map<string, View>();

  constructor(private readonly opts: BrowserViewsOptions) {}

  /** `browser.view.open`: answers once the server took the data socket; a view this agent had closes. */
  async open(agentId: string, streamId: string): Promise<{ opened: true }> {
    const socket = await this.opts.dial(streamId);
    const old = this.views.get(agentId);
    if (old) this.end(agentId, old);
    const view: View = { agentId, socket, inflight: 0, held: null, stall: null, closed: false };
    this.views.set(agentId, view);
    socket.listen({
      // Nothing comes down as bytes on a view: what a person sends goes on the machine socket.
      bytes: () => undefined,
      control: (frame) => {
        if (frame.type === "ack") this.acked(view);
      },
      closed: () => this.drop(view),
    });
    return { opened: true };
  }

  /** One of an agent's frames: true when its view took it (sent, or kept as the newest), false when there is none. */
  push(frame: Frame): boolean {
    const view = this.views.get(frame.agentId);
    if (!view) return false;
    if (view.inflight >= (this.opts.window ?? BROWSER_VIEW.window)) {
      view.held = frame;
      view.stall ??= setTimeout(() => {
        view.stall = null;
        // No acknowledgement in all this time: the frames on their way were lost, not slow.
        view.inflight = 0;
        this.release(view);
      }, this.opts.stallMs ?? BROWSER_VIEW.stallMs);
      return true;
    }
    this.send(view, frame);
    return true;
  }

  /** The agent's stream ended: its view closes, and the server opens a new one with its next stream. */
  end(agentId: string, view = this.views.get(agentId)) {
    if (!view) return;
    this.drop(view);
    view.socket.close(STREAM_CLOSE.normal, "the stream ended");
  }

  /** The server's connection dropped: every view goes (the server opens them again with the streams). */
  closeAll() {
    for (const view of [...this.views.values()]) this.end(view.agentId, view);
  }

  /** Agents with a view open (tests, the activity log). */
  viewing(): string[] {
    return [...this.views.keys()];
  }

  private send(view: View, frame: Frame) {
    const jpeg = Buffer.from(frame.data, "base64");
    view.socket.send(encodeBrowserFrame({ seq: frame.seq, metadata: frame.metadata }, jpeg));
    view.inflight++;
  }

  private acked(view: View) {
    if (view.closed) return;
    view.inflight = Math.max(0, view.inflight - 1);
    this.release(view);
  }

  /** The frame waiting goes, when there is room for it. */
  private release(view: View) {
    if (view.stall) clearTimeout(view.stall);
    view.stall = null;
    const held = view.held;
    view.held = null;
    if (held && !view.closed) this.push(held);
  }

  private drop(view: View) {
    if (view.closed) return;
    view.closed = true;
    view.held = null;
    if (view.stall) clearTimeout(view.stall);
    view.stall = null;
    if (this.views.get(view.agentId) === view) this.views.delete(view.agentId);
  }
}
