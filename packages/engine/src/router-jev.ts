import type { RouterStrategy, RoutingInput, RoutingResult } from "./router";

/**
 * TypeSafe Jev (System One) as a router strategy (docs/adr/0013-router.md):
 * one request to `POST https://api.typesafe.ai/v1/systemone` with the
 * conversation as `state` and, in parallel, one Noul per candidate ("should
 * <agent> answer?"), a Noul for "does this need any agent?", and, with two or
 * more candidates, a Choice over the candidates plus "none" to break ties.
 * It only scores; policy stays in `selectAgents`. Optional (needs
 * `TYPESAFE_API_KEY`); errors and timeouts fall back to another strategy.
 *
 * Questions are in English (Jev's primary training language); the
 * conversation goes in as written.
 */
export interface JevUsage {
  orgId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Jev price: $0.042 per million input tokens; output tokens are free (docs.typesafe.ai/models, 2026-10). */
export const JEV_NANO_USD_PER_INPUT_TOKEN = 0.042;
export const jevCostNanoUsd = (inputTokens: number) => Math.round(inputTokens * JEV_NANO_USD_PER_INPUT_TOKEN);

const NONE = "none";

interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export function createJevRouterStrategy(options: {
  apiKey: string;
  /** Records the call's usage (kind `router`, provider `typesafe`). */
  recordUsage(usage: JevUsage): Promise<void>;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): RouterStrategy {
  const http = options.fetch ?? fetch;
  const base = (options.baseURL ?? "https://api.typesafe.ai").replace(/\/$/, "");
  return {
    name: "jev",
    async decide(input: RoutingInput): Promise<RoutingResult> {
      const handles = input.candidates.map((c) => c.handle);
      const state = {
        channel: { name: input.channel.name, topic: input.channel.topic || null, direct_message: false },
        recent_messages: input.thread.map((m) => ({ from: m.author, text: m.body.slice(0, 800) })),
        latest_message: { from: input.message.author, text: input.message.body.slice(0, 4000) },
        agent_just_talking: input.continuityHandle ? `@${input.continuityHandle}` : null,
        agents_in_channel: input.candidates.map((c) => ({
          handle: `@${c.handle}`,
          name: c.name,
          role: c.role || null,
          about: c.about || null,
          can: c.can ?? null,
        })),
      };
      const questions: Record<string, unknown> = {
        needs_agent: {
          type: "noul",
          instructions:
            "Should any AI agent reply to `latest_message`? People in a team chat often talk among themselves; an agent should reply only when the message asks for help, asks a question the agents can answer, greets the room, or continues a conversation with an agent.",
          criteria: {
            true: "The message is for an agent or needs an agent's answer.",
            false: "People talking to each other; no agent should interrupt.",
          },
        },
      };
      input.candidates.forEach((c, i) => {
        questions[`agent_${i}`] = {
          type: "noul",
          instructions: {
            agent: {
              handle: `@${c.handle}`,
              name: c.name,
              role: c.role || null,
              about: c.about || null,
              can: c.can ?? null,
            },
            question:
              "Should `agent` reply to `latest_message`? Yes when the message addresses this agent, fits its role and what it `can` do, or follows up on a conversation this agent was just part of (see `agent_just_talking`). No when it can't actually help with this.",
          },
          criteria: {
            true: "This agent is the one who should answer.",
            false: "This agent should stay quiet.",
          },
        };
      });
      if (input.thread.length > 0) {
        questions.already_answered = {
          type: "noul",
          instructions:
            "Has an AI agent in `recent_messages` already answered what `latest_message` asks, so another agent's answer would just repeat it?",
          criteria: {
            true: "An agent already answered this; a second answer would be a duplicate.",
            false: "It is a new question or request that nobody answered yet.",
          },
        };
      }
      if (input.candidates.length >= 2) {
        const criteria: Record<string, string> = {};
        for (const c of input.candidates)
          criteria[c.handle] = `${c.name}${c.role ? `, ${c.role}` : ""}${c.about ? `: ${c.about.slice(0, 200)}` : ""}`;
        criteria[NONE] = "No agent should reply.";
        questions.best_agent = {
          type: "choice",
          instructions: "Which agent is best placed to reply to `latest_message`?",
          criteria,
        };
      }

      const res = await http(`${base}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ state, model: options.model ?? "jev-latest", questions }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
      });
      if (!res.ok) throw new Error(`TypeSafe answered ${res.status}`);
      const body = (await res.json()) as {
        model?: string;
        answers?: Record<string, JevAnswer>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      await options
        .recordUsage({
          orgId: input.orgId,
          model: body.model ?? options.model ?? "jev-latest",
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
        })
        .catch(() => {});
      const answers = body.answers ?? {};
      const best = answers.best_agent?.probabilities ?? {};
      const scores = input.candidates.map((c, i) => {
        const noul = clamp(answers[`agent_${i}`]?.noul);
        // The Choice only breaks near-ties: a small nudge toward the agent it prefers.
        const nudge = input.candidates.length >= 2 ? 0.1 * ((best[c.handle] ?? 0) - 1 / (handles.length + 1)) : 0;
        return { agentId: c.agentId, score: clamp(noul + nudge) };
      });
      const choice = answers.best_agent?.choice;
      return {
        agents: scores,
        needsAgent: clamp(answers.needs_agent?.noul),
        ...(answers.already_answered ? { alreadyAnswered: clamp(answers.already_answered.noul) } : {}),
        reason:
          choice && choice !== NONE
            ? `jev: best @${choice} (confidence ${(answers.best_agent?.confidence ?? 0).toFixed(2)})`
            : choice === NONE
              ? "jev: no agent should reply"
              : "jev",
      };
    },
  };
}

const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Uses `primary`; on any error or timeout uses `fallback`, recording which one decided. */
export function withFallback(primary: RouterStrategy, fallback: RouterStrategy): RouterStrategy {
  return {
    name: primary.name,
    async decide(input) {
      try {
        return { ...(await primary.decide(input)), strategy: primary.name };
      } catch (error) {
        const result = await fallback.decide(input);
        return {
          ...result,
          strategy: `${fallback.name} (fallback: ${error instanceof Error ? error.message.slice(0, 80) : "error"})`,
        };
      }
    },
  };
}

/**
 * Jev as the judge of an agent's @mentions: for each mentioned agent, is the
 * message asking it to do or answer something now (not just naming it)? One
 * request, one Noul per agent. Returns the probability per agent id.
 */
export function createJevMentionClassifier(options: {
  apiKey: string;
  recordUsage(usage: JevUsage): Promise<void>;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}) {
  const http = options.fetch ?? fetch;
  const base = (options.baseURL ?? "https://api.typesafe.ai").replace(/\/$/, "");
  return async (input: {
    orgId: string;
    body: string;
    author: string;
    recent?: { from: string; text: string }[];
    targets: { agentId: string; handle: string; name: string; role: string | null; can?: string }[];
  }): Promise<Map<string, number>> => {
    const questions: Record<string, unknown> = {};
    input.targets.forEach((t, i) => {
      questions[`asks_${i}`] = {
        type: "noul",
        instructions: {
          agent: { handle: `@${t.handle}`, name: t.name, role: t.role, can: t.can ?? null },
          question:
            "Is `message` asking `agent` to do something or to answer something now (a hand-off or a direct question), rather than naming it, quoting it, or telling a person to talk to it?",
        },
        criteria: {
          true: "It hands work or a question to that agent, to act on now.",
          false: "It only names the agent (what it said, did or can do, or 'talk to @agent').",
        },
      };
    });
    const res = await http(`${base}/v1/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: {
          message: { from: input.author, from_an_agent: true, text: input.body.slice(0, 4000) },
          recent_messages: (input.recent ?? []).map((m) => ({ from: m.from, text: m.text.slice(0, 600) })),
        },
        model: options.model ?? "jev-latest",
        questions,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    if (!res.ok) throw new Error(`TypeSafe answered ${res.status}`);
    const body = (await res.json()) as {
      model?: string;
      answers?: Record<string, JevAnswer>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    await options
      .recordUsage({
        orgId: input.orgId,
        model: body.model ?? options.model ?? "jev-latest",
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      })
      .catch(() => {});
    return new Map(input.targets.map((t, i) => [t.agentId, clamp(body.answers?.[`asks_${i}`]?.noul)]));
  };
}
