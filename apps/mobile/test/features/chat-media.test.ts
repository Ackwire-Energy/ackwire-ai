import { describe, expect, test } from "bun:test";
import type { DirectMessage, Message } from "@agenteschat/client";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { STICKER_MOODS } from "@agenteschat/ui/agent/stickers";
import { stickerFrame } from "../../src/agent/sticker";
import { subtitleOf } from "../../src/features/activity/logic";
import { teamLines } from "../../src/features/agents/logic";
import { buildRows } from "../../src/features/chat/logic";
import {
  continuesReply,
  gifBox,
  MESSAGE_GIF_MAX,
  MESSAGE_GIF_MAX_HEIGHT,
  mediaAfterOf,
} from "../../src/features/chat/media";
import { type ScrollRow, turnRowByRun, unseenBelow } from "../../src/features/chat/scroll";
import { buildConversations } from "../../src/features/chats/logic";
import { agent, at, message, notification, translator } from "./fixtures";

// GIFs and stickers in chat (ADR 0091), on the phone.

const gif = { kind: "gif", provider: "giphy", id: "g1", title: "a cat dancing", width: 480, height: 270 };
const sticker = { kind: "sticker", agentId: "dev", mood: "celebrate" };

const reply = (over: Partial<Message> = {}) =>
  message({
    id: "reply",
    author: { type: "agent", id: "dev" },
    agentRunId: "run1",
    threadId: "root",
    body: "Pronto, subiu.",
    createdAt: at(10),
    ...over,
  });
const after = (over: Partial<Message> = {}) =>
  message({
    id: "after",
    author: { type: "agent", id: "dev" },
    agentRunId: "run1",
    threadId: "root",
    body: "",
    meta: { media: sticker, mediaAfter: "reply" },
    createdAt: at(9.9),
    ...over,
  });

describe("a GIF's box", () => {
  test("its own proportions, up to 260 wide", () => {
    expect(gifBox(480, 270)).toEqual({ width: MESSAGE_GIF_MAX, height: Math.round((260 * 270) / 480) });
    // Smaller than the most: as it is.
    expect(gifBox(200, 100)).toEqual({ width: 200, height: 100 });
  });

  test("never wider than the row's room", () => {
    expect(gifBox(480, 240, 200)).toEqual({ width: 200, height: 100 });
  });

  test("a tall one gets narrower instead of filling the screen", () => {
    const box = gifBox(200, 600);
    expect(box.height).toBe(MESSAGE_GIF_MAX_HEIGHT);
    expect(box.width).toBe(Math.round((MESSAGE_GIF_MAX_HEIGHT * 200) / 600));
  });

  test("sizes it doesn't know draw 4:3", () => {
    expect(gifBox(0, 0)).toEqual({ width: 260, height: 195 });
  });
});

describe("the sticker or GIF an agent adds after its reply", () => {
  test("reads as the end of that reply", () => {
    expect(mediaAfterOf(after().meta)).toBe("reply");
    expect(mediaAfterOf(reply().meta)).toBeNull();
    expect(continuesReply(reply(), after())).toBe(true);
    // Another message in between, or another author: not the reply it follows.
    expect(continuesReply(message({ id: "x" }), after())).toBe(false);
    expect(continuesReply(reply({ author: { type: "agent", id: "infra" } }), after())).toBe(false);
  });

  test("groups under its reply, even one that stands alone", () => {
    const consulted = reply({ meta: { consulted: [{ agentId: "infra", status: "answered", answer: "ok" }] } });
    const rows = buildRows([consulted, after()]);
    const shown = rows.filter((r) => r.kind === "message");
    expect(shown.map((r) => r.kind === "message" && r.grouped)).toEqual([false, true]);
  });

  test("a person's GIF groups like any message", () => {
    const a = message({ id: "a", createdAt: at(10) });
    const b = message({ id: "b", body: "", meta: { media: gif }, createdAt: at(9) });
    const shown = buildRows([a, b]).filter((r) => r.kind === "message");
    expect(shown.map((r) => r.kind === "message" && r.grouped)).toEqual([false, true]);
  });

  test("never takes its run's block key: the reply keeps it", () => {
    const rows = [
      { kind: "message", key: "reply", message: reply() },
      { kind: "message", key: "after", message: after() },
    ];
    expect(turnRowByRun(rows, new Set()).get("run1")).toBe("reply");
  });

  test("never counts as new below the person", () => {
    const rows: ScrollRow[] = [
      { key: "a", kind: "message" },
      { key: "after", kind: "message", who: "agent:dev", silent: true },
      { key: "b", kind: "message", who: "person:u2" },
    ];
    expect(unseenBelow(rows, "a")).toEqual({ messages: 1, firstKey: "b", authors: ["person:u2"], working: [] });
    expect(unseenBelow(rows.slice(0, 2), "a").messages).toBe(0);
  });
});

describe("stickers on Skia", () => {
  test("every mood draws the agent at its still frame", () => {
    for (const mood of STICKER_MOODS) {
      const ops = stickerFrame({ color: "sky", eyes: "round" }, mood, 110);
      expect(ops.length).toBeGreaterThan(0);
      // Only what the Skia replay knows, and colors it can read.
      for (const op of ops) {
        expect(["save", "restore", "translate", "scale", "rects", "fill", "stroke", "clip"]).toContain(op.op);
        if ("color" in op) expect(typeof op.color).toBe("string");
      }
    }
  });

  test("the same look and mood draw the same frame", () => {
    const look = { color: "sky", eyes: "round", accessory: "cap" };
    expect(stickerFrame(look, "love", 110)).toEqual(stickerFrame(look, "love", 110));
  });
});

describe("a GIF or a sticker where a message's text shows", () => {
  test("the conversation list says which", async () => {
    const t = await translator("pt-BR");
    const dm: DirectMessage = {
      channelId: "d1",
      with: { type: "agent", id: "dev", name: "Dev", handle: "dev" },
      lastMessage: { id: "m", body: "", meta: null, mediaKind: "sticker", createdAt: at(1), authorType: "person" },
      unread: 0,
    };
    const rows = buildConversations({ channels: [], dms: [dm], threads: [] });
    const last = rows[0]?.kind === "dm" ? rows[0].last : null;
    expect(last?.mediaKind).toBe("sticker");
    expect(previewBody(t, last?.text ?? "", last?.meta ?? null, last?.mediaKind)).toBe("Figurinha");
    const en = await translator("en");
    expect(previewBody(en, "", null, "gif")).toBe("GIF");
  });

  test("the agents' list keeps the kind of their DM's last message", () => {
    const dev = agent({ id: "dev", name: "Dev" });
    const dm = {
      with: { type: "agent" as const, id: "dev", name: "Dev", handle: "dev" },
      lastMessage: { id: "m", body: "", meta: null, mediaKind: "gif" as const, createdAt: at(1), authorType: "agent" },
    };
    const { free } = teamLines([dev], [], [dm]);
    expect(free[0]?.preview).toBeNull();
    expect(free[0]?.previewMedia).toBe("gif");
  });

  test("the inbox names a GIF with no words", () => {
    const say = (_w: unknown, otherwise = "") => otherwise;
    const word = (kind: string) => (kind === "gif" ? "GIF" : "Figurinha");
    expect(subtitleOf(notification({ id: "n", latest: { text: "", media: "gif" } }), say, word)).toBe("GIF");
    expect(subtitleOf(notification({ id: "n", latest: { media: "sticker" } }), say, word)).toBe("Figurinha");
    // Words win; without the word function, nothing changes.
    expect(subtitleOf(notification({ id: "n", latest: { text: "olha", media: "gif" } }), say, word)).toBe("olha");
    expect(subtitleOf(notification({ id: "n", latest: { text: "", media: "gif" } }), say)).toBe("");
  });
});
