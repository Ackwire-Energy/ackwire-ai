import { describe, expect, test } from "bun:test";
import { cleanTerms, createSpeechEngine, SpeechError, type SpeechFetch, silentWav } from "../src/speech";

type Call = { url: string; init?: RequestInit };

/** A fake provider: each call takes the next answer, and is recorded. */
function fake(...answers: Response[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answers.shift() ?? Response.json({});
  }) as unknown as SpeechFetch;
  return { fetch, calls };
}

const options = (f: { fetch: SpeechFetch }) => ({ fetch: f.fetch, sleep: async () => {} });
const input = { audio: silentWav(), contentType: "audio/mp4", language: "pt", terms: ["Ada", "Theo"] };
const form = (call: Call | undefined) => call?.init?.body as FormData;
const json = (call: Call | undefined) => JSON.parse(String(call?.init?.body));

describe("providers", () => {
  test("AssemblyAI uploads, asks and polls until it is done", async () => {
    const f = fake(
      Response.json({ upload_url: "https://cdn.example/a" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "processing" }),
      Response.json({ status: "completed", text: "Ada, oi" }),
    );
    const engine = createSpeechEngine("assemblyai", { apiKey: "key" }, options(f));
    expect(await engine?.file(input)).toEqual({ text: "Ada, oi" });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.assemblyai.com/v2/upload",
      "https://api.assemblyai.com/v2/transcript",
      "https://api.assemblyai.com/v2/transcript/t1",
      "https://api.assemblyai.com/v2/transcript/t1",
    ]);
    expect(json(f.calls[1])).toMatchObject({ language_code: "pt", keyterms_prompt: ["Ada", "Theo"] });
  });

  test("AssemblyAI reads no speech as an empty answer", async () => {
    const f = fake(
      Response.json({ upload_url: "u" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "error", error: "language_detection cannot be performed: no spoken audio" }),
    );
    expect(await createSpeechEngine("assemblyai", { apiKey: "key" }, options(f))?.file(input)).toEqual({ text: "" });
  });

  test("ElevenLabs sends the terms one by one", async () => {
    const f = fake(Response.json({ text: "oi" }));
    expect(await createSpeechEngine("elevenlabs", { apiKey: "key" }, options(f))?.file(input)).toEqual({ text: "oi" });
    expect(f.calls[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(form(f.calls[0]).getAll("keyterms")).toEqual(["Ada", "Theo"]);
    expect(form(f.calls[0]).get("model_id")).toBe("scribe_v2");
  });

  test("Soniox leaves nothing behind at the provider", async () => {
    const f = fake(
      Response.json({ id: "f1" }),
      Response.json({ id: "t1" }),
      Response.json({ status: "completed" }),
      Response.json({ text: "oi" }),
    );
    expect(await createSpeechEngine("soniox", { apiKey: "key" }, options(f))?.file(input)).toEqual({ text: "oi" });
    const deleted = f.calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url);
    expect(deleted).toEqual(["https://api.soniox.com/v1/transcriptions/t1", "https://api.soniox.com/v1/files/f1"]);
  });

  test("Groq, OpenAI and a local server speak the same format", async () => {
    for (const [provider, credentials, url] of [
      ["groq", { apiKey: "key" }, "https://api.groq.com/openai/v1/audio/transcriptions"],
      ["openai", { apiKey: "key" }, "https://api.openai.com/v1/audio/transcriptions"],
      ["local", { baseUrl: "http://whisper:8000/v1/" }, "http://whisper:8000/v1/audio/transcriptions"],
    ] as const) {
      const f = fake(Response.json({ text: "oi" }));
      expect(await createSpeechEngine(provider, credentials, options(f))?.file(input)).toEqual({ text: "oi" });
      expect(f.calls[0]?.url).toBe(url);
      expect(form(f.calls[0]).get("prompt")).toBe("Ada, Theo");
    }
  });

  test("what a provider needs is required", () => {
    expect(createSpeechEngine("groq", {})).toBeNull();
    expect(createSpeechEngine("local", {})).toBeNull();
  });
});

describe("errors", () => {
  test("say whether another try can work, and never carry the key", async () => {
    for (const [status, reason] of [
      [401, "auth"],
      [429, "busy"],
      [500, "busy"],
      [400, "refused"],
    ] as const) {
      const f = fake(new Response("nope", { status }));
      const error = await createSpeechEngine("elevenlabs", { apiKey: "secret-key" }, options(f))
        ?.file(input)
        .catch((e) => e);
      expect(error).toBeInstanceOf(SpeechError);
      expect((error as SpeechError).reason).toBe(reason);
      expect((error as SpeechError).message).not.toContain("secret-key");
    }
  });
});

test("cleanTerms drops repeats, long phrases and refused characters", () => {
  expect(cleanTerms(["Ada", "ada", "x", "a b c d e f g", "<Theo>"], 10, 6)).toEqual(["Ada", "Theo"]);
  expect(cleanTerms(["Ada", "Theo", "Lia"], 2, 6)).toEqual(["Ada", "Theo"]);
});
