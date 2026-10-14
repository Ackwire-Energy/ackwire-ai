import { describe, expect, test } from "bun:test";
import { createFakeEmailSender, createLogEmailSender, createMillionSendSender, EmailError } from "../src";

const msg = { to: ["ana@example.com"], subject: "Oi", html: "<p>Oi</p>", text: "Oi", idempotencyKey: "invite:1" };

describe("MillionSend sender", () => {
  test("POST /emails with bearer key, Resend-compatible fields and an Idempotency-Key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createMillionSendSender({
      apiKey: "ms_test",
      from: "agentes <ola@agentes.chat>",
      replyTo: "suporte@agentes.chat",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ id: "0b6f…" });
      }) as unknown as typeof fetch,
    });
    expect(await sender.send({ ...msg, tags: [{ name: "kind", value: "invitation" }] })).toEqual({ id: "0b6f…" });
    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.url).toBe("https://api.millionsend.com/emails");
    expect(headers.get("authorization")).toBe("Bearer ms_test");
    expect(headers.get("idempotency-key")).toBe("invite:1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: "agentes <ola@agentes.chat>",
      to: ["ana@example.com"],
      subject: "Oi",
      html: "<p>Oi</p>",
      text: "Oi",
      reply_to: "suporte@agentes.chat",
      tags: [{ name: "kind", value: "invitation" }],
    });
  });

  test("409 (same idempotency key) counts as sent; 429/5xx retry; 4xx don't", async () => {
    const reply = (status: number) =>
      createMillionSendSender({
        apiKey: "k",
        from: "f@x.y",
        fetch: (async () =>
          Response.json({ statusCode: status, name: "x", message: "m" }, { status })) as unknown as typeof fetch,
      });
    expect((await reply(409).send(msg)).id).toBe("duplicate:invite:1");
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [422, false],
      [403, false],
    ] as const) {
      const error = await reply(status)
        .send(msg)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailError);
      expect((error as EmailError).retryable).toBe(retryable);
    }
  });

  test("dev fallback logs instead of sending; the fake records", async () => {
    const lines: unknown[] = [];
    const log = createLogEmailSender((line, data) => lines.push([line, data]));
    expect(log.delivers).toBe(false);
    await log.send(msg);
    expect(JSON.stringify(lines)).toContain("ana@example.com");
    const fake = createFakeEmailSender();
    await fake.send(msg);
    expect(fake.sent).toEqual([msg]);
  });
});
