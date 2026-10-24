import { isTerminalSize, STREAM_CLOSE, type StreamRequest } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import type { RunnerLink, Stream, StreamBroker, StreamInput, StreamSocket } from "@agenteschat/engine";
import type { Auth } from "../auth";
import { allowedOrigins } from "../routes/app/context";
import { personUpgrade, UUID } from "./ws";

/**
 * Agents' desktops and terminals (ADR 0058 §11), relayed by the engine's
 * stream broker:
 *
 * - `GET /api/desktop?orgId&agentId&mode=watch|control` (raw RFB, binary) and
 *   `GET /api/terminal?orgId&agentId&cols&rows` (the shell's bytes; text
 *   frames: `resize` out, `exit` in) are a person's sockets, refused before
 *   the upgrade like `/api/ws` (401 without a session, 403 for a foreign
 *   Origin or a non-member, 400 for bad parameters). After it, a refusal is a
 *   close code the panel turns into a state (`STREAM_CLOSE`).
 * - `GET /api/machines/stream` is the runner's data socket for one stream: a
 *   request with an Origin is refused, so no web page opens one. Its first
 *   frame, `stream.hello`, carries the machine's token and the stream's id.
 *
 * Matched exactly: the desktop app's own downloads live under `/api/desktop/…`.
 */
export const STREAM_PATHS = {
  desktop: "/api/desktop",
  terminal: "/api/terminal",
  data: "/api/machines/stream",
} as const;

/** A person's desktop or terminal socket. */
export interface ViewerSocketData {
  kind: "stream.viewer";
  input: StreamInput;
  stream: Stream | null;
}

/** A runner's data socket. */
export interface DataSocketData {
  kind: "stream.data";
  link: RunnerLink | null;
}

export type StreamSocketData = ViewerSocketData | DataSocketData;
type Socket = Bun.ServerWebSocket<StreamSocketData>;

const socketOf = (ws: Socket): StreamSocket => ({
  send: (data) => {
    ws.send(data);
  },
  close: (code, reason) => ws.close(code, reason),
  buffered: () => ws.getBufferedAmount(),
  ping: () => {
    ws.ping();
  },
});

const upgraded = (ok: boolean) => (ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 }));

/** What a viewer's address asks for; null when it is malformed. */
function viewerRequest(path: string, q: URLSearchParams): StreamRequest | null {
  if (path === STREAM_PATHS.desktop) {
    const mode = q.get("mode");
    return mode === "watch" || mode === "control" ? { kind: "desktop", mode } : null;
  }
  const cols = Number(q.get("cols"));
  const rows = Number(q.get("rows"));
  return isTerminalSize(cols, rows) ? { kind: "terminal", cols, rows } : null;
}

export function createStreamSockets(deps: { db: Database; auth: Auth; config: Config; broker: StreamBroker }) {
  const origins = allowedOrigins(deps.config);
  const { broker } = deps;
  return {
    paths: new Set<string>(Object.values(STREAM_PATHS)),

    async upgrade(req: Request, server: Bun.Server<StreamSocketData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === STREAM_PATHS.data) {
        if (req.headers.get("origin")) return new Response("Browsers can't connect here", { status: 403 });
        return upgraded(server.upgrade(req, { data: { kind: "stream.data", link: null } }));
      }
      const q = url.searchParams;
      const orgId = q.get("orgId") ?? "";
      const user = await personUpgrade(deps, origins, req, orgId);
      if (user instanceof Response) return user;
      const agentId = q.get("agentId") ?? "";
      const request = viewerRequest(url.pathname, q);
      if (!UUID.test(agentId) || !request) {
        return new Response("agentId and a mode (or a terminal's cols and rows) are required", { status: 400 });
      }
      const data: ViewerSocketData = {
        kind: "stream.viewer",
        input: { userId: user.id, orgId, agentId, request },
        stream: null,
      };
      return upgraded(server.upgrade(req, { data }));
    },

    open(ws: Socket) {
      if (ws.data.kind === "stream.data") ws.data.link = broker.accept(socketOf(ws));
      else ws.data.stream = broker.open(socketOf(ws), ws.data.input);
    },

    async message(ws: Socket, raw: string | Buffer) {
      if (ws.data.kind === "stream.viewer") {
        if (ws.data.stream) broker.fromViewer(ws.data.stream, raw);
      } else if (ws.data.link) await broker.fromRunner(ws.data.link, raw);
    },

    close(ws: Socket, code: number) {
      if (ws.data.kind === "stream.viewer") {
        if (ws.data.stream) broker.close(ws.data.stream, STREAM_CLOSE.normal, "the viewer left");
      } else if (ws.data.link) broker.runnerClosed(ws.data.link, code);
    },
  };
}

export type StreamSockets = ReturnType<typeof createStreamSockets>;
