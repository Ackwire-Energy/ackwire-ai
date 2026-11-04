import { describe, expect, test } from "bun:test";
import { waitingCardOf } from "@agenteschat/client/lib/notifications";
import { usageLimitLine } from "@agenteschat/client/lib/person-usage";
import { notificationHref } from "../../src/features/links/logic";
import { notification } from "./fixtures";

// The words as keys with their values, so the line's pieces show without the strings loaded.
const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;

describe("a person's limit in Atividade (ADR 0141)", () => {
  const request = notification({
    id: "n",
    kind: "usage_limit",
    waiting: true,
    actors: [{ type: "user", id: "u-mateus" }],
    source: { userId: "u-mateus", label: "Vendas" },
    latest: {
      statusTo: "request",
      limitUsd: 30,
      raiseToUsd: 45,
      limitFrom: "role",
      runs: 64,
      title: "Zara",
      share: 80,
    },
  });

  test("a request for more waits as a limit card, answered there, and opens Uso", () => {
    expect(waitingCardOf(request)).toMatchObject({ kind: "limit", action: "review" });
    expect(notificationHref(request)).toBe("/usage");
  });

  test("who decides reads the requests, the agent most used and where the limit comes from; the person, nothing more", () => {
    const line = usageLimitLine(t, request);
    expect(line).toContain("notifications.usageLimit.line");
    expect(line).toContain('notifications.usageLimit.fromRole{\\"role\\":\\"Vendas\\"}');
    expect(line).toContain("Zara");
    const mine = notification({
      id: "m",
      kind: "usage_limit",
      source: { userId: "u-mateus" },
      latest: { statusTo: "raised", percent: 40 },
    });
    expect(usageLimitLine(t, mine)).toBe("");
  });
});
