import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { postPersonMessage } from "../src";
import {
  absorbToolData,
  mergeToolEffects,
  storedTranscript,
  type ToolSideEffects,
  takeBridgeEffects,
} from "../src/run-tools";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("files a run's tools leave for its reply", () => {
  test("the same file twice (kept by the bridge and taken again, or saved again) is one card, newest version", () => {
    const t: ToolSideEffects = {};
    absorbToolData(t, { artifact: { id: "a", version: 1 } });
    mergeToolEffects(t, { artifacts: [{ id: "a", version: 1 }] });
    mergeToolEffects(t, { artifacts: [{ id: "b", version: 1 }] });
    absorbToolData(t, { artifact: { id: "a", version: 2 } });
    expect(t.artifacts).toEqual([
      { id: "a", version: 2 },
      { id: "b", version: 1 },
    ]);
  });

  test("the engine saving its copy keeps what the bridge left on the run, and never brings back what it took", async () => {
    f = await setup();
    const fx = f;
    const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "make the QR screenshot",
    });
    const kept = { artifacts: [{ id: "file-1", version: 1 }] };
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        startedAt: new Date(),
        // A run picked up again (a retry, a resume) with what the bridge kept still on it.
        transcript: { system: [], messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0, bridgeEffects: kept },
      })
      .returning();
    if (!run) throw new Error("no run");
    const save = (t: object) =>
      fx.db
        .update(schema.agentRuns)
        .set({ transcript: storedTranscript(t) })
        .where(eq(schema.agentRuns.id, run.id));
    const stored = async () =>
      (await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)))[0]?.transcript as Record<
        string,
        unknown
      >;
    // A save of the engine's copy (which knows nothing of it) keeps what the bridge left.
    await save({ system: [], messages: [{ role: "user", content: "x" }], postedUpTo: 1, postedCount: 0, deltaSeq: 0 });
    expect((await stored()).bridgeEffects).toEqual(kept);
    expect((await stored()).postedUpTo).toBe(1);
    // Taken once; a later save of a stale copy that still has it doesn't bring it back.
    expect(await takeBridgeEffects(fx.db, run.id)).toEqual(kept);
    await save({ system: [], messages: [], postedUpTo: 2, postedCount: 0, deltaSeq: 0, bridgeEffects: kept });
    expect((await stored()).bridgeEffects).toBeUndefined();
    expect(await takeBridgeEffects(fx.db, run.id)).toBeNull();
  });
});
