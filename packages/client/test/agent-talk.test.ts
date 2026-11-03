import { expect, test } from "bun:test";
import { openableConsultation, talkState, talkStateOf, talkStatus } from "../src/lib/consult-group";
import { forPeople, previewOf, withoutRelayLine } from "../src/lib/consultations";

test("the pill's state: out (working, waiting, offline, handed on), answered, or no answer", () => {
  for (const s of ["working", "waiting", "offline", "handedOn"] as const) expect(talkState(s)).toBe("waiting");
  expect(talkState("answered")).toBe("answered");
  expect(talkState("failed")).toBe("failed");
  expect(talkState("expired")).toBe("failed");
  expect(talkStateOf("answered", "ok")).toBe("answered");
  expect(talkStateOf("answered", "  ")).toBe("failed");
  expect(talkStateOf("open", null)).toBe("waiting");
  expect(talkStateOf("expired", null)).toBe("failed");
});

test("the pill's words after the names, with the time when known", () => {
  expect(talkStatus("answered", "8 s")).toEqual({ key: "chat.agentTalk.answeredIn", values: { time: "8 s" } });
  expect(talkStatus("answered", null)).toEqual({ key: "chat.agentTalk.answered", values: {} });
  expect(talkStatus("waiting", "12 s")).toEqual({ key: "chat.agentTalk.waitingFor", values: { time: "12 s" } });
  expect(talkStatus("waiting", null)).toEqual({ key: "chat.agentTalk.waiting", values: {} });
  expect(talkStatus("failed", "3 s")).toEqual({ key: "chat.agentTalk.failed", values: {} });
});

test("only a real consultation id opens the conversation, not the stand-in for none", () => {
  expect(openableConsultation("8f0c1c0e-0000-4000-8000-000000000001")).toBe("8f0c1c0e-0000-4000-8000-000000000001");
  expect(openableConsultation("agent-1:failed")).toBeNull();
  expect(openableConsultation("")).toBeNull();
  expect(openableConsultation(undefined)).toBeNull();
});

const RELAYED =
  "[@caio mentioned you in a conversation, where you aren't a member, so it reaches you here]\n\nTheo, revisa o PR?";
const RELAYED_MEMBER =
  "[@caio mentioned you in #general for someone you answer only through other agents, so it reaches you here: answer it, not them]\n\nOi";

test("people never read the relay line the server writes for the agent", () => {
  expect(withoutRelayLine(RELAYED)).toBe("Theo, revisa o PR?");
  expect(withoutRelayLine(RELAYED_MEMBER)).toBe("Oi");
  expect(previewOf(RELAYED)).toBe("Theo, revisa o PR?");
  // Anything else stays as written, a bracket of its own too.
  expect(withoutRelayLine("[nota] fica")).toBe("[nota] fica");
  expect(withoutRelayLine("Veja: [@caio mentioned you in #x, so it reaches you here]")).toContain("mentioned you");
  const talk = forPeople({
    consultation: { id: "c1", question: RELAYED },
    messages: [
      { id: "m1", body: RELAYED },
      { id: "m2", body: "Feito." },
    ],
  });
  expect(talk.consultation).toEqual({ id: "c1", question: "Theo, revisa o PR?" });
  expect(talk.messages.map((m) => m.body)).toEqual(["Theo, revisa o PR?", "Feito."]);
});
