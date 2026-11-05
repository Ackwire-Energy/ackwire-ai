import {
  channelTopic,
  chatActivityTopic,
  MAX_FRAME_BYTES,
  orgTopic,
  type Presence,
  type PubSub,
  type RateLimiter,
  typingTopic,
  type Unsubscribe,
  userTopic,
} from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import { and, type Database, eq, inArray, isNotNull, isNull, or, schema, sql } from "@agenteschat/db";
import {
  activityAudience,
  announcePresence,
  type BrowserLive,
  closedRefusal,
  closesWorkspace,
  ForbiddenError,
  getMembership,
  isConnected,
  NotFoundError,
  type OrgEvent,
  profileIdOfKey,
  requireBrowserAccess,
  requireChannelAccess,
  requireProfileWatcher,
  taskReaderSql,
  touchLastSeen,
} from "@agenteschat/engine";
import type { Auth, SessionUser } from "../auth";
import type { Logger } from "../logger";
import { allowedOrigins, requestOriginAllowed } from "../routes/app/context";
import {
  BROWSER_INPUT_PER_SECOND,
  type BrowserClientFrame,
  MAX_WATCHED_BROWSERS,
  parseBrowserClientFrame,
} from "./browser";
import type { MachineSocketData, MachineSockets } from "./machines";
import type { StreamSocketData, StreamSockets } from "./streams";

/**
 * WebSocket endpoint `GET /api/ws?orgId=<uuid>` (docs/adr/0010-realtime.md).
 *
 * - The upgrade requires a session cookie, an allowed `Origin` (cross-site
 *   WebSocket hijacking), and membership of `orgId`.
 * - Clients then send `{"type":"subscribe","channelId":"…"}`; the server
 *   checks the channel belongs to that org and the person is a member of it
 *   (`requireChannelAccess`, the same check as the HTTP API) before
 *   forwarding the channel's events.
 * - `{"type":"typing","channelId","threadId"?}` (throttled by the client; the
 *   server keeps at most two every 2 s) fans out `user.typing` to the channel,
 *   valid for `ttlMs` (5 s).
 * - Server → client frames: `ready`, `subscribed`, `unsubscribed` (with a
 *   `reason` when the server dropped it: `revoked`, `archived`), `error`, and
 *   channel events (`message.created`, `agent.delta`, `agent.run`,
 *   `approval.*`) wrapped as `{"type":"event","channelId":…,"event":{…}}`.
 *   Events for this person only (approvals waiting for them, DMs) arrive as
 *   `{"type":"event","scope":"user","event":{…}}`.
 * - Membership changes normally take effect through pub/sub at once. A
 *   periodic database check also drops subscriptions or closes the socket if
 *   that notification was lost.
 * - A revoked session closes its socket on the next frame or periodic check.
 */
export interface RealtimeDeps {
  db: Database;
  auth: Auth;
  config: Config;
  pubsub: PubSub;
  presence: Presence;
  rateLimiter: RateLimiter;
  log: Logger;
  /** Connected computers' runners (`/api/machines/connect`, ADR 0025): same server, own handlers. */
  machines?: MachineSockets;
  /** The agent browser's live view (ADR 0040, `browser.*` frames); absent = not offered. */
  browserLive?: BrowserLive;
  /** Agents' desktops and terminals (ADR 0058): people's stream sockets and the runners' data sockets. */
  streams?: StreamSockets;
  /** How often an open socket checks its session and channels again (`SESSION_RECHECK_MS`; tests go faster). */
  sessionRecheckMs?: number;
}

/** A browser tab of the web app. */
export interface BrowserSocketData {
  kind: "browser";
  connectionId: string;
  user: SessionUser;
  sessionToken: string;
  sessionValidatedAt: number;
  sessionCheckInFlight: Promise<boolean> | null;
  sessionTimer: ReturnType<typeof setInterval> | null;
  orgId: string;
  subscriptions: Map<string, Unsubscribe>;
  /** Org and user topic listeners. */
  system: Unsubscribe[];
  /** Channels being authorized right now; a revocation during the check marks them. */
  pending: Map<string, { revoked: boolean }>;
  /** Agents' browsers this socket watches (ADR 0040), by agent id: the stop function. */
  browsers: Map<string, () => void>;
}

/** Every socket of the server: browsers (`/api/ws`), runners (`/api/machines/connect`) and streams (ADR 0058). */
export type SocketData = BrowserSocketData | MachineSocketData | StreamSocketData;

type BrowserSocket = Bun.ServerWebSocket<BrowserSocketData>;
type MachineSocket = Bun.ServerWebSocket<MachineSocketData>;
type StreamSocket = Bun.ServerWebSocket<StreamSocketData>;
const isMachine = (ws: Bun.ServerWebSocket<SocketData>): ws is MachineSocket => ws.data.kind === "machine";
const isStream = (ws: Bun.ServerWebSocket<SocketData>): ws is StreamSocket =>
  ws.data.kind === "stream.viewer" || ws.data.kind === "stream.data";

export type ClientFrame =
  | { type: "subscribe" | "unsubscribe"; channelId: string }
  | { type: "typing"; channelId: string; threadId: string | null }
  | { type: "ping" };

/** How long a typing indicator lasts without a new `typing` frame. */
export const TYPING_TTL_MS = 5000;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SUBSCRIPTIONS = 200;
/** Bound the lifetime of an idle socket after its session is revoked. */
export const SESSION_RECHECK_MS = 15_000;
/** Incoming frames recheck at most once this often, to avoid a database query per mouse event. */
const SESSION_FRAME_RECHECK_MS = 2_000;
const MEMBERSHIP_CHECK_TIMEOUT_MS = 5_000;

/**
 * The checks before a person's socket opens (`/api/ws`, and the desktop and
 * terminal streams): our Origin, or the phone app without one (cross-site
 * WebSocket hijacking); a session from the cookie; membership of `orgId`,
 * a workspace that isn't closed (`closedRefusal`). The person, or the refusal.
 */
export async function personUpgrade(
  deps: Pick<RealtimeDeps, "auth" | "db">,
  origins: Set<string>,
  req: Request,
  orgId: string,
): Promise<(SessionUser & { sessionToken: string }) | Response> {
  if (!requestOriginAllowed(origins, req.headers)) {
    return new Response("Cross-origin WebSocket refused", { status: 403 });
  }
  if (!UUID.test(orgId)) return new Response("orgId is required", { status: 400 });
  // An upgrade is a new long-lived capability: resolve the session against the
  // database instead of accepting a signed cookie that outlived its DB row.
  const session = await deps.auth.api.getSession({ headers: req.headers, query: { disableCookieCache: true } });
  if (!session) return new Response("Sign in to continue", { status: 401 });
  const user = session.user as SessionUser;
  const membership = await getMembership(deps.db, user.id, orgId);
  if (!membership || closedRefusal(membership.standing)) {
    return new Response("Not a member of this organization", { status: 403 });
  }
  return { ...user, sessionToken: session.session.token };
}

export function parseClientFrame(raw: string | Buffer): ClientFrame | null {
  if (raw.length > 4096) return null;
  try {
    const frame = JSON.parse(String(raw)) as { type?: unknown; channelId?: unknown; threadId?: unknown };
    if (frame.type === "ping") return { type: "ping" };
    if (frame.type === "typing" && typeof frame.channelId === "string" && UUID.test(frame.channelId)) {
      const threadId = typeof frame.threadId === "string" && UUID.test(frame.threadId) ? frame.threadId : null;
      return { type: "typing", channelId: frame.channelId, threadId };
    }
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

/** Reconcile an existing socket against durable membership when a revocation event was lost. */
export async function currentSubscriptions(
  db: Database,
  userId: string,
  orgId: string,
  channelIds: string[],
): Promise<Set<string> | null> {
  const member = await getMembership(db, userId, orgId);
  if (!member || closedRefusal(member.standing)) return null;
  if (channelIds.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .leftJoin(
      schema.channelMembers,
      and(
        eq(schema.channelMembers.orgId, orgId),
        eq(schema.channelMembers.channelId, schema.channels.id),
        eq(schema.channelMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.channels.orgId, orgId),
        inArray(schema.channels.id, channelIds),
        isNull(schema.channels.archivedAt),
        or(
          eq(schema.channels.kind, "forum"),
          isNotNull(schema.channelMembers.id),
          // A task's conversation: whoever sees the task (ADR 0145).
          and(eq(schema.channels.kind, "task"), taskReaderSql(sql`${schema.channels.id}`, sql`${userId}::text`)),
        ),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

export function createRealtime(deps: RealtimeDeps) {
  const origins = allowedOrigins(deps.config);
  const send = (ws: BrowserSocket, frame: unknown): void => {
    ws.send(JSON.stringify(frame));
  };
  // A new message reaches its members' sockets on this replica as `channel.activity` (no content): their lists
  // count it as unread without subscribing to every channel. The author's own sockets never hear it.
  // ponytail: one audience query per message per replica with sockets; a per-channel member cache if that shows up.
  const browsers = new Set<BrowserSocket>();
  deps.pubsub.subscribe(chatActivityTopic, (raw) => {
    if (browsers.size === 0) return;
    const { channelId, threadId, authorUserId, mentionedUserIds } = raw as {
      channelId?: unknown;
      threadId?: unknown;
      authorUserId?: unknown;
      mentionedUserIds?: unknown;
    };
    if (typeof channelId !== "string" || !UUID.test(channelId)) return;
    const thread = typeof threadId === "string" && UUID.test(threadId) ? threadId : null;
    const mentioned = Array.isArray(mentionedUserIds)
      ? mentionedUserIds.filter((id): id is string => typeof id === "string")
      : [];
    void activityAudience(deps.db, channelId, thread, mentioned)
      .then(({ orgId, dm, userIds }) => {
        const event = { type: "channel.activity", channelId, threadId: thread, dm };
        for (const ws of browsers)
          if (
            ws.readyState === 1 &&
            ws.data.orgId === orgId &&
            ws.data.user.id !== authorUserId &&
            userIds.has(ws.data.user.id)
          )
            send(ws, { type: "event", scope: "user", event });
      })
      .catch(() => {});
  });

  async function liveSession(ws: BrowserSocket, force = false): Promise<boolean> {
    if (ws.readyState !== 1) return false;
    if (!force && Date.now() - ws.data.sessionValidatedAt < SESSION_FRAME_RECHECK_MS) return true;
    if (ws.data.sessionCheckInFlight) return ws.data.sessionCheckInFlight;
    const check = (async () => {
      try {
        const { internalAdapter } = await deps.auth.$context;
        const found = await internalAdapter.findSession(ws.data.sessionToken);
        if (!found || found.session.userId !== ws.data.user.id || found.session.expiresAt <= new Date()) {
          if (ws.readyState === 1) ws.close(4401, "session revoked");
          return false;
        }
        ws.data.sessionValidatedAt = Date.now();
        return true;
      } catch {
        // If the session store cannot be checked, stop forwarding private events.
        if (ws.readyState === 1) ws.close(1011, "session unavailable");
        return false;
      }
    })();
    ws.data.sessionCheckInFlight = check;
    try {
      return await check;
    } finally {
      ws.data.sessionCheckInFlight = null;
    }
  }

  /** Each socket's last input frame on its way into the live view (`browserInput`). */
  const inputLanes = new WeakMap<BrowserSocket, Promise<unknown>>();

  /**
   * A person's input frame. Frames of one socket enter the live view strictly in the order they came, one after
   * another: the checks on the way await (the session, the rate limiter), and a later frame whose await ended first
   * would otherwise overtake, reordering typed text or putting a click before the moves that lead to it. Only
   * entering is in line: the answer is awaited outside it, so frames keep coming while a batch is on its way.
   */
  function browserInput(ws: BrowserSocket, frame: Extract<BrowserClientFrame, { type: "browser.input" }>) {
    const live = deps.browserLive;
    if (!live) return;
    const { agentId } = frame;
    const { orgId, user } = ws.data;
    const entered = (inputLanes.get(ws) ?? Promise.resolve()).then(async () => {
      if (!(await liveSession(ws))) return null;
      const t = await deps.rateLimiter.consume(`ws-browser:${ws.data.connectionId}`, {
        limit: BROWSER_INPUT_PER_SECOND,
        windowMs: 1000,
      });
      if (!t.allowed) return void send(ws, { type: "error", code: "rate_limited", agentId });
      if (!ws.data.browsers.has(agentId)) return void send(ws, { type: "error", code: "not_in_control", agentId });
      // Wrapped: a bare promise returned here would hold the line until the computer answers.
      return { sent: live.input(user.id, orgId, agentId, frame.events) };
    });
    const settled = entered.catch(() => {
      if (ws.readyState === 1) send(ws, { type: "browser.unavailable", agentId, reason: "unavailable" });
      return null;
    });
    inputLanes.set(ws, settled);
    return settled.then(async (step) => {
      if (!step) return;
      try {
        const sent = await step.sent;
        if (sent.refused) send(ws, { type: "error", code: "not_in_control", agentId });
      } catch (error) {
        if (ws.readyState === 1) {
          send(ws, { type: "browser.unavailable", agentId, reason: "unavailable", message: String(error) });
        }
      }
    });
  }

  /** Placeholders of browser views still starting (`browser.watch` in flight). */
  const startingBrowsers = new WeakSet<() => void>();

  /** An agent's browser on this socket (ADR 0040): watch, stop watching, a person's input. */
  async function browserMessage(ws: BrowserSocket, frame: BrowserClientFrame): Promise<void> {
    const live = deps.browserLive;
    if (!live) return;
    const { agentId } = frame;
    const { orgId, user } = ws.data;
    if (frame.type === "browser.unwatch") {
      ws.data.browsers.get(agentId)?.();
      ws.data.browsers.delete(agentId);
      return;
    }
    const limit = await deps.rateLimiter.consume(`ws:${ws.data.connectionId}`, { limit: 60, windowMs: 10_000 });
    if (!limit.allowed) return send(ws, { type: "error", code: "rate_limited", agentId });
    const previous = ws.data.browsers.get(agentId);
    // Still starting: a second `browser.watch` meanwhile is a no-op.
    if (previous && startingBrowsers.has(previous)) return;
    // Already here: watching again is the client's retry (after reconnecting, offline, an ended
    // stream or a lost permission), so the old view goes and a fresh one starts.
    if (previous) {
      previous();
      ws.data.browsers.delete(agentId);
    }
    if (ws.data.browsers.size >= MAX_WATCHED_BROWSERS) {
      return send(ws, { type: "error", code: "too_many_browsers", agentId });
    }
    // Held while it starts, so a second `browser.watch` meanwhile is a no-op and an unwatch cancels it.
    const starting = () => {};
    startingBrowsers.add(starting);
    ws.data.browsers.set(agentId, starting);
    let stop: () => void;
    try {
      const profileId = profileIdOfKey(agentId);
      if (profileId) await requireProfileWatcher(deps.db, user.id, orgId, profileId);
      else await requireBrowserAccess(deps.db, user.id, orgId, agentId);
      stop = await live.watch(
        {
          userId: user.id,
          send: (message) => {
            if (ws.readyState === 1) send(ws, message);
          },
          // Backed up (a slow phone link): skip frames, the next one sent is the newest.
          busy: () => ws.getBufferedAmount() > 1024 * 1024,
        },
        orgId,
        agentId,
      );
    } catch (error) {
      startingBrowsers.delete(starting);
      // Whatever failed, the placeholder goes: a later `browser.watch` tries again.
      if (ws.data.browsers.get(agentId) === starting) ws.data.browsers.delete(agentId);
      const code = error instanceof NotFoundError ? "not_found" : error instanceof ForbiddenError ? "forbidden" : "";
      if (code) return send(ws, { type: "error", code, agentId });
      return send(ws, { type: "browser.unavailable", agentId, reason: "unavailable", message: "try again" });
    }
    startingBrowsers.delete(starting);
    // Closed or unwatched while it was starting: stop at once.
    if (ws.readyState !== 1 || ws.data.browsers.get(agentId) !== starting) return stop();
    ws.data.browsers.set(agentId, stop);
  }

  const realtime = {
    path: "/api/ws",

    /** Called from `Bun.serve`'s fetch for `/api/ws`. Returns a Response on refusal, undefined once upgraded. */
    /**
     * `Bun.serve`'s fetch: upgrades `/api/ws` and `/api/machines/connect`,
     * and hands everything else to `next` (the HTTP app).
     */
    fetch(
      req: Request,
      server: Bun.Server<SocketData>,
      next: (req: Request) => Response | Promise<Response>,
    ): Response | Promise<Response | undefined> | undefined {
      const path = new URL(req.url).pathname;
      if (path === realtime.path) return realtime.upgrade(req, server);
      if (deps.machines && path === deps.machines.path) {
        return deps.machines.upgrade(req, server as unknown as Bun.Server<MachineSocketData>);
      }
      if (deps.streams?.paths.has(path)) {
        return deps.streams.upgrade(req, server as unknown as Bun.Server<StreamSocketData>);
      }
      return next(req);
    },

    async upgrade(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
      const orgId = new URL(req.url).searchParams.get("orgId") ?? "";
      const user = await personUpgrade(deps, origins, req, orgId);
      if (user instanceof Response) return user;
      const { sessionToken, ...person } = user;
      const data: BrowserSocketData = {
        kind: "browser",
        connectionId: crypto.randomUUID(),
        user: person,
        sessionToken,
        sessionValidatedAt: 0,
        sessionCheckInFlight: null,
        sessionTimer: null,
        orgId,
        subscriptions: new Map(),
        system: [],
        pending: new Map(),
        browsers: new Map(),
      };
      return server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },

    websocket: {
      // Runners send files inline (up to MAX_FRAME_BYTES); browser frames are still capped at 4096 by `parseClientFrame`.
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: 120,
      async open(socket: Bun.ServerWebSocket<SocketData>) {
        if (isMachine(socket)) return deps.machines?.open(socket);
        if (isStream(socket)) return deps.streams?.open(socket);
        const ws = socket as BrowserSocket;
        if (!(await liveSession(ws, true))) return;
        browsers.add(ws);
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
        let rechecking = false;
        ws.data.sessionTimer = setInterval(() => {
          if (rechecking || ws.readyState !== 1) return;
          rechecking = true;
          void (async () => {
            try {
              if (!(await liveSession(ws, true))) return;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              const deadline = new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error("membership check timed out")),
                  MEMBERSHIP_CHECK_TIMEOUT_MS,
                );
                timeout.unref?.();
              });
              // Only these are judged: a channel subscribed while the query runs passed its own check, and isn't in
              // `allowed` only because nobody asked about it.
              const checked = [...ws.data.subscriptions.keys(), ...ws.data.pending.keys()];
              let allowed: Set<string> | null;
              try {
                allowed = await Promise.race([currentSubscriptions(deps.db, user.id, orgId, checked), deadline]);
              } finally {
                if (timeout) clearTimeout(timeout);
              }
              if (ws.readyState !== 1) return;
              if (!allowed) {
                ws.close(4403, "membership revoked");
                return;
              }
              for (const channelId of checked) if (!allowed.has(channelId)) drop(channelId, "revoked");
            } catch {
              // A failed durable check must not leave a private subscription open.
              if (ws.readyState === 1) ws.close(1011, "membership unavailable");
            } finally {
              rechecking = false;
            }
          })();
        }, deps.sessionRecheckMs ?? SESSION_RECHECK_MS);
        ws.data.system.push(
          deps.pubsub.subscribe(orgTopic(orgId), (raw) => {
            const event = raw as unknown as OrgEvent;
            if (event.type === "channel.archived") return drop(event.channelId, "archived");
            if (event.type === "org.broadcast") {
              if (ws.readyState === 1) send(ws, { type: "event", scope: "org", event: event.event });
              if (closesWorkspace(event.event) && ws.readyState === 1) ws.close(4403, "organization closed");
              return;
            }
            if (event.type !== "membership.revoked" || event.userId !== user.id) return;
            if (event.channelId) return drop(event.channelId, "revoked");
            for (const channelId of [...ws.data.subscriptions.keys(), ...ws.data.pending.keys()])
              drop(channelId, "revoked");
            if (ws.readyState === 1) {
              send(ws, { type: "error", code: event.quiet ? "membership_ended" : "membership_revoked" });
              // Closed outside the publisher's call stack (in-memory pub/sub delivers synchronously).
              ws.close(4403, "membership revoked");
            }
          }),
          deps.pubsub.subscribe(userTopic(orgId, user.id), (event) => {
            if (ws.readyState === 1) send(ws, { type: "event", scope: "user", event });
          }),
        );
        const wasConnected = await isConnected(deps.presence, orgId, user.id);
        await deps.presence.connect(ws.data.orgId, ws.data.user.id, ws.data.connectionId);
        await touchLastSeen(deps.db, orgId, user.id).catch(() => {});
        if (!wasConnected) await announcePresence(deps, orgId, user.id).catch(() => {});
        send(ws, { type: "ready", orgId: ws.data.orgId, userId: ws.data.user.id });
      },
      async message(socket: Bun.ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
        if (isMachine(socket)) return deps.machines?.message(socket, raw);
        if (isStream(socket)) return deps.streams?.message(socket, raw);
        const ws = socket as BrowserSocket;
        const browserFrame = deps.browserLive ? parseBrowserClientFrame(raw) : null;
        if (browserFrame?.type === "browser.input") return browserInput(ws, browserFrame);
        if (!(await liveSession(ws))) return;
        if (browserFrame) {
          return browserMessage(ws, browserFrame).catch(() => {
            if (ws.readyState === 1) {
              send(ws, { type: "browser.unavailable", agentId: browserFrame.agentId, reason: "unavailable" });
            }
          });
        }
        const limit = await deps.rateLimiter.consume(`ws:${ws.data.connectionId}`, { limit: 60, windowMs: 10_000 });
        if (!limit.allowed) return send(ws, { type: "error", code: "rate_limited" });
        const frame = parseClientFrame(raw);
        if (!frame) return send(ws, { type: "error", code: "bad_frame" });
        if (frame.type === "ping") return send(ws, { type: "pong" });

        const { channelId } = frame;
        if (frame.type === "typing") {
          // Only into channels this connection is subscribed to (already authorized); at most two every 2 s (the apps
          // send one every 3 s, and one more when a new message starts).
          if (!ws.data.subscriptions.has(channelId)) return;
          const t = await deps.rateLimiter.consume(`typing:${ws.data.connectionId}:${channelId}`, {
            limit: 2,
            windowMs: 2000,
          });
          if (!t.allowed) return;
          const typing = {
            type: "user.typing",
            channelId,
            threadId: frame.threadId,
            userId: ws.data.user.id,
            ttlMs: TYPING_TTL_MS,
          };
          await Promise.all(
            [channelTopic(channelId), typingTopic].map((topic) => deps.pubsub.publish(topic, typing).catch(() => {})),
          );
          return;
        }
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
        } catch (error) {
          // The check couldn't run (the database is away): the tab reconnects, which subscribes again and
          // catches up on what it missed.
          deps.log.warn("channel subscription check failed", { error: String(error) });
          send(ws, { type: "error", code: "unavailable", channelId });
          ws.close(1011, "try again");
          return;
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
      async close(socket: Bun.ServerWebSocket<SocketData>, code: number) {
        if (isMachine(socket)) return deps.machines?.close(socket);
        if (isStream(socket)) return deps.streams?.close(socket, code);
        const ws = socket as BrowserSocket;
        browsers.delete(ws);
        if (ws.data.sessionTimer) clearInterval(ws.data.sessionTimer);
        ws.data.sessionTimer = null;
        for (const off of ws.data.subscriptions.values()) off();
        ws.data.subscriptions.clear();
        for (const stop of ws.data.browsers.values()) stop();
        ws.data.browsers.clear();
        for (const off of ws.data.system) off();
        ws.data.system = [];
        await deps.presence.disconnect(ws.data.orgId, ws.data.user.id, ws.data.connectionId);
        await touchLastSeen(deps.db, ws.data.orgId, ws.data.user.id).catch(() => {});
        if (!(await isConnected(deps.presence, ws.data.orgId, ws.data.user.id))) {
          await announcePresence(deps, ws.data.orgId, ws.data.user.id).catch(() => {});
        }
      },
    },
  };

  /** A handler that fails is logged (so reported) with whose socket it was, not left to reach the process. */
  const guarded =
    <A extends unknown[]>(handler: string, run: (socket: Bun.ServerWebSocket<SocketData>, ...args: A) => unknown) =>
    async (socket: Bun.ServerWebSocket<SocketData>, ...args: A) => {
      try {
        await run(socket, ...args);
      } catch (error) {
        deps.log.error("socket handler failed", {
          socket: socket.data.kind,
          handler,
          ...socketIds(socket.data),
          error,
          stack: (error as Error | null)?.stack,
        });
      }
    };
  const { open, message, close } = realtime.websocket;
  return {
    ...realtime,
    websocket: {
      ...realtime.websocket,
      open: guarded("open", open),
      message: guarded("message", message),
      close: guarded("close", close),
    },
  };
}

/** Whose socket it is, by internal ids. */
function socketIds(data: SocketData) {
  if (data.kind === "browser") return { orgId: data.orgId, userId: data.user.id };
  if (data.kind === "machine")
    return { orgId: data.conn?.orgId ?? undefined, machineId: data.conn?.machineId ?? undefined };
  if (data.kind === "stream.viewer")
    return { orgId: data.input.orgId, userId: data.input.userId, agentId: data.input.agentId };
  return {};
}

export type Realtime = ReturnType<typeof createRealtime>;
