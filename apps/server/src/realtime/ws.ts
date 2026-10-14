import {
  channelTopic,
  orgTopic,
  type Presence,
  type PubSub,
  type RateLimiter,
  type Unsubscribe,
  userTopic,
} from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import { ForbiddenError, getMembership, NotFoundError, type OrgEvent, requireChannelAccess } from "@agenteschat/engine";
import { type Auth, type SessionUser, sessionUser } from "../auth";
import type { Logger } from "../logger";
import { allowedOrigins } from "../routes/app/context";

/**
 * WebSocket endpoint `GET /api/ws?orgId=<uuid>` (docs/adr/0010-realtime.md).
 *
 * - The upgrade requires a session cookie, an allowed `Origin` (cross-site
 *   WebSocket hijacking), and membership of `orgId`.
 * - Clients then send `{"type":"subscribe","channelId":"…"}`; the server
 *   checks the channel belongs to that org and the person is a member of it
 *   (`requireChannelAccess`, the same check as the HTTP API) before
 *   forwarding the channel's events.
 * - Server → client frames: `ready`, `subscribed`, `unsubscribed` (with a
 *   `reason` when the server dropped it: `revoked`, `archived`), `error`, and
 *   channel events (`message.created`, `agent.delta`, `agent.run`,
 *   `approval.*`) wrapped as `{"type":"event","channelId":…,"event":{…}}`.
 *   Events for this person only (approvals waiting for them, DMs) arrive as
 *   `{"type":"event","scope":"user","event":{…}}`.
 * - Membership changes take effect at once: leaving (or being removed from) a
 *   channel drops that subscription; leaving the organization closes the
 *   socket with code 4403.
 */
export interface RealtimeDeps {
  db: Database;
  auth: Auth;
  config: Config;
  pubsub: PubSub;
  presence: Presence;
  rateLimiter: RateLimiter;
  log: Logger;
}

export interface SocketData {
  connectionId: string;
  user: SessionUser;
  orgId: string;
  subscriptions: Map<string, Unsubscribe>;
  /** Org and user topic listeners. */
  system: Unsubscribe[];
  /** Channels being authorized right now; a revocation during the check marks them. */
  pending: Map<string, { revoked: boolean }>;
}

export type ClientFrame = { type: "subscribe" | "unsubscribe"; channelId: string } | { type: "ping" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SUBSCRIPTIONS = 200;

export function parseClientFrame(raw: string | Buffer): ClientFrame | null {
  if (raw.length > 4096) return null;
  try {
    const frame = JSON.parse(String(raw)) as { type?: unknown; channelId?: unknown };
    if (frame.type === "ping") return { type: "ping" };
    if (
      (frame.type === "subscribe" || frame.type === "unsubscribe") &&
      typeof frame.channelId === "string" &&
      UUID.test(frame.channelId)
    ) {
      return { type: frame.type, channelId: frame.channelId };
    }
  } catch {}
  return null;
}

/**
 * Whether this person may receive a channel's events through a connection
 * opened for `orgId`. Returns null when allowed, or a short reason.
 */
export async function authorizeSubscription(
  db: Database,
  userId: string,
  orgId: string,
  channelId: string,
): Promise<string | null> {
  try {
    await requireChannelAccess(db, userId, orgId, channelId);
    return null;
  } catch (error) {
    if (error instanceof ForbiddenError) return "forbidden";
    if (error instanceof NotFoundError) return "not_found";
    throw error;
  }
}

export function createRealtime(deps: RealtimeDeps) {
  const origins = allowedOrigins(deps.config);
  const send = (ws: Bun.ServerWebSocket<SocketData>, frame: unknown): void => {
    ws.send(JSON.stringify(frame));
  };

  return {
    path: "/api/ws",

    /** Called from `Bun.serve`'s fetch for `/api/ws`. Returns a Response on refusal, undefined once upgraded. */
    async upgrade(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
      const origin = req.headers.get("origin");
      if (!origin || !origins.has(origin)) return new Response("Cross-origin WebSocket refused", { status: 403 });
      const orgId = new URL(req.url).searchParams.get("orgId") ?? "";
      if (!UUID.test(orgId)) return new Response("orgId is required", { status: 400 });
      const user = await sessionUser(deps.auth, req.headers);
      if (!user) return new Response("Sign in to continue", { status: 401 });
      if (!(await getMembership(deps.db, user.id, orgId)))
        return new Response("Not a member of this organization", { status: 403 });
      const data: SocketData = {
        connectionId: crypto.randomUUID(),
        user,
        orgId,
        subscriptions: new Map(),
        system: [],
        pending: new Map(),
      };
      return server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },

    websocket: {
      maxPayloadLength: 16 * 1024,
      idleTimeout: 120,
      async open(ws: Bun.ServerWebSocket<SocketData>) {
        const { orgId, user } = ws.data;
        const drop = (channelId: string, reason: string) => {
          const pending = ws.data.pending.get(channelId);
          if (pending) pending.revoked = true;
          const off = ws.data.subscriptions.get(channelId);
          if (!off) return;
          off();
          ws.data.subscriptions.delete(channelId);
          if (ws.readyState === 1) send(ws, { type: "unsubscribed", channelId, reason });
        };
        ws.data.system.push(
          deps.pubsub.subscribe(orgTopic(orgId), (raw) => {
            const event = raw as unknown as OrgEvent;
            if (event.type === "channel.archived") return drop(event.channelId, "archived");
            if (event.type !== "membership.revoked" || event.userId !== user.id) return;
            if (event.channelId) return drop(event.channelId, "revoked");
            for (const channelId of [...ws.data.subscriptions.keys(), ...ws.data.pending.keys()])
              drop(channelId, "revoked");
            if (ws.readyState === 1) {
              send(ws, { type: "error", code: "membership_revoked" });
              // Closed outside the publisher's call stack (in-memory pub/sub delivers synchronously).
              ws.close(4403, "membership revoked");
            }
          }),
          deps.pubsub.subscribe(userTopic(orgId, user.id), (event) => {
            if (ws.readyState === 1) send(ws, { type: "event", scope: "user", event });
          }),
        );
        await deps.presence.connect(ws.data.orgId, ws.data.user.id, ws.data.connectionId);
        send(ws, { type: "ready", orgId: ws.data.orgId, userId: ws.data.user.id });
      },
      async message(ws: Bun.ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
        const limit = await deps.rateLimiter.consume(`ws:${ws.data.connectionId}`, { limit: 60, windowMs: 10_000 });
        if (!limit.allowed) return send(ws, { type: "error", code: "rate_limited" });
        const frame = parseClientFrame(raw);
        if (!frame) return send(ws, { type: "error", code: "bad_frame" });
        if (frame.type === "ping") return send(ws, { type: "pong" });

        const { channelId } = frame;
        if (frame.type === "unsubscribe") {
          ws.data.subscriptions.get(channelId)?.();
          ws.data.subscriptions.delete(channelId);
          return send(ws, { type: "unsubscribed", channelId });
        }
        if (ws.data.subscriptions.has(channelId)) return send(ws, { type: "subscribed", channelId });
        if (ws.data.subscriptions.size >= MAX_SUBSCRIPTIONS)
          return send(ws, { type: "error", code: "too_many_subscriptions", channelId });
        const check = { revoked: false };
        ws.data.pending.set(channelId, check);
        let denied: string | null;
        try {
          denied = await authorizeSubscription(deps.db, ws.data.user.id, ws.data.orgId, channelId);
        } finally {
          ws.data.pending.delete(channelId);
        }
        // A revocation that arrived while we were checking wins over a stale "allowed".
        if (!denied && check.revoked) denied = "forbidden";
        if (denied) return send(ws, { type: "error", code: denied, channelId });
        if (ws.data.subscriptions.has(channelId)) return send(ws, { type: "subscribed", channelId });
        const off = deps.pubsub.subscribe(channelTopic(channelId), (event) => {
          if (ws.readyState === 1) send(ws, { type: "event", channelId, event });
        });
        ws.data.subscriptions.set(channelId, off);
        send(ws, { type: "subscribed", channelId });
      },
      async close(ws: Bun.ServerWebSocket<SocketData>) {
        for (const off of ws.data.subscriptions.values()) off();
        ws.data.subscriptions.clear();
        for (const off of ws.data.system) off();
        ws.data.system = [];
        await deps.presence.disconnect(ws.data.orgId, ws.data.user.id, ws.data.connectionId);
      },
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
