import { callJev, type JevKeySource, JevOffError } from "./jev-key";
import { RouterChainEnd, RouterSkip, type RouterStrategy, type RoutingInput, type RoutingResult } from "./router";

/**
 * TypeSafe Jev (System One) as a router strategy (docs/adr/0013-router.md):
 * one request to `POST https://api.typesafe.ai/v1/systemone` with the
 * conversation as `state` and, in parallel, one Noul per candidate ("should
 * <agent> answer?"), a Noul for "does this need any agent?", and, with two or
 * more candidates, a Noul for "is it for every agent?" and a Choice over the
 * candidates plus "none" to break ties.
 * It only scores; policy stays in `selectAgents`. Optional (needs the
 * installation's Jev key, ADR 0073), and the first step of `routeChain`:
 * on an error or a timeout the next step decides.
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

/**
 * Jev price: $0.042 per million input tokens ($42 per billion); output tokens are free
 * (docs.typesafe.ai/models, 2026-10). In nano-USD per token like the catalog (USD per million × 1000): 42.
 */
export const JEV_NANO_USD_PER_INPUT_TOKEN = 42;
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
  /** Read on every call (`jev-key.ts`): without one it throws `JevOffError`. */
  key: JevKeySource;
  /** Records the call's usage (kind `router`, provider `typesafe`). */
  recordUsage(usage: JevUsage): Promise<void>;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): RouterStrategy {
  return {
    name: "jev",
    on: () => typeof options.key === "string" || options.key.usable(),
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
            "Should any AI agent reply to `latest_message`? People in a team chat often talk among themselves; an agent should reply only when the message asks for help, asks a question the agents can answer, greets the room, speaks to the agents as a group, or continues a conversation with an agent.",
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
              'Should `agent` reply to `latest_message`? Yes when the message addresses this agent, fits its role and what it `can` do, or follows up on a conversation this agent was just part of (see `agent_just_talking`). Also yes when it speaks to all the agents or the whole room ("everyone", "all of you", "gente", "vocês", "agentes") and each one has its own answer (its name, its computer, its status): then every agent should reply. No when it can\'t actually help with this, and no when the message is about an app or tool (Sentry, GitHub, the Drive…) that is not in its `can`: it has no access to it.',
          },
          criteria: {
            true: "This agent should answer (alone, or along with the others when the message is for all of them).",
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
        questions.for_everyone = {
          type: "noul",
          instructions:
            'Does `latest_message` speak to all the agents (or the whole room: "everyone", "all of you", "gente", "vocês", "agentes") so that each one should give its own answer (its name, its computer, its status)? A question or task with one answer (a number, a report, a fix) is for one agent, even when several could do it.',
          criteria: {
            true: "Every agent should answer for itself.",
            false: "One answer is enough: one agent should take it.",
          },
        };
        const criteria: Record<string, string> = {};
        for (const c of input.candidates)
          criteria[c.handle] =
            `${c.name}${c.role ? `, ${c.role}` : ""}${c.about ? `: ${c.about.slice(0, 200)}` : ""}${c.can ? ` (can use: ${c.can})` : ""}`;
        criteria[NONE] = "No agent should reply.";
        questions.best_agent = {
          type: "choice",
          instructions: "Which agent is best placed to reply to `latest_message`?",
          criteria,
        };
      }

      const body = await callJev<{
        model?: string;
        answers?: Record<string, JevAnswer>;
        usage?: { input_tokens?: number; output_tokens?: number };
      }>(options.key, {
        fetch: options.fetch,
        baseURL: options.baseURL,
        body: { state, model: options.model ?? "jev-latest", questions },
        timeoutMs: options.timeoutMs ?? 2000,
      });
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
        ...(answers.for_everyone ? { forEveryone: clamp(answers.for_everyone.noul) } : {}),
        ...(choice
          ? {
              reason:
                choice === NONE
                  ? "no agent should reply"
                  : `best @${choice} (confidence ${(answers.best_agent?.confidence ?? 0).toFixed(2)})`,
            }
          : {}),
        strategy: "jev",
        decidedBy: { step: "jev" },
      };
    },
  };
}

const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * The router's chain (ADR 0074): each step in order until one decides. A step that can't read this message
 * (`RouterSkip`, or Jev without a key) passes without a trace. One that fails (an error, a timeout, an answer
 * that isn't JSON) is noted (`jev: TypeSafe answered 529`) and the next one runs. When none decides,
 * `RouterChainEnd` carries what failed, and the rules decide. Each step's time goes to `onTiming`
 * (`router_step_ms`, with the step and how it ended). Named after the first step that is on now, so nothing
 * names Jev while it has no key.
 */
export function routeChain(
  steps: RouterStrategy[],
  o: { onTiming?(name: string, ms: number, attrs: Record<string, unknown>): void } = {},
): RouterStrategy {
  return {
    get name() {
      return steps.find((s) => s.on?.() ?? true)?.name ?? "none";
    },
    async decide(input) {
      const failures: string[] = [];
      for (const step of steps) {
        const started = Date.now();
        const timed = (outcome: "decided" | "skipped" | "failed") =>
          o.onTiming?.("router_step_ms", Date.now() - started, { step: step.name, outcome });
        try {
          const result = await step.decide(input);
          timed("decided");
          return { ...result, strategy: result.strategy ?? step.name, ...(failures.length ? { failures } : {}) };
        } catch (error) {
          const skipped = error instanceof RouterSkip || error instanceof JevOffError;
          timed(skipped ? "skipped" : "failed");
          if (!skipped) failures.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new RouterChainEnd(failures);
    },
  };
}
