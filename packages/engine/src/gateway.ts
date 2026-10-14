import type { KeyWrapper, PlatformCredentials } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, isNull, lt, schema, sql } from "@agenteschat/db";
import {
  costNanoUsd,
  estimateTokens,
  isKnownModel,
  MODEL_CATALOG,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  maxCostNanoUsd,
  outputTokensWithin,
  ProviderError,
  promptChars,
  type SystemPrompt,
  type ToolSpec,
} from "@agenteschat/providers";
import { type Agent, getAgent } from "./agents";
import { decryptCredential } from "./credentials";
import { BudgetExceededError, MissingCredentialError, NotFoundError, ValidationError } from "./errors";
import { monthStartUtc } from "./usage";

const { usageRecords, agentBudgetPeriods, budgetReservations, providerCredentials, organizationSettings } = schema;

export interface ModelGatewayDeps {
  db: Database;
  /** Current wrapper first, then legacy ones (rotation). */
  keyWrappers: KeyWrapper[];
  providers: Record<string, ModelProvider>;
  platformCredentials: PlatformCredentials;
  now?: () => Date;
}

/** A model call made by an agent: billed to the agent's credential and budget. */
export interface GatewayCall {
  orgId: string;
  agentId: string;
  runId?: string;
  system: SystemPrompt;
  messages: ModelMessage[];
  maxTokens: number;
  tools?: ToolSpec[];
  onDelta(text: string): void;
  signal?: AbortSignal;
}

/**
 * A model call made for the organization (router, summaries): billed to the
 * org's default credential, recorded with `agent_id` null (or the agent it
 * was made for) and its `kind`.
 */
export interface OrgCall {
  orgId: string;
  kind: "router" | "summary";
  model: string;
  system: SystemPrompt;
  messages: ModelMessage[];
  maxTokens: number;
  outputSchema?: Record<string, unknown>;
  effort?: ModelRequest["effort"];
  /** Agent the call is about, if any (recorded, not billed to its budget). */
  agentId?: string | null;
  runId?: string;
  signal?: AbortSignal;
}

export interface GatewayResult extends ModelResult {
  usageRecordId: string;
  costNanoUsd: number;
  /** Output cap actually sent (may be lower than asked to fit the remaining budget). */
  maxTokens: number;
}

/** Reservations older than this are considered abandoned (a worker died mid-call) and released. */
export const RESERVATION_TTL_MS = 15 * 60_000;
/** Below this many output tokens a call isn't worth making: the budget counts as exhausted. */
export const MIN_OUTPUT_TOKENS = 256;

const periodOf = (now: Date) => monthStartUtc(now).toISOString().slice(0, 10);

/**
 * The only way to call a model (docs/adr/0007, 0012, D2). For every call:
 * 1. resolve the model from the catalog (agent's model, or the fixed org-call model);
 * 2. agent calls: atomically reserve the worst-case cost against the agent's
 *    monthly counter (row lock), shrinking `maxTokens` to fit the budget;
 * 3. decrypt the org's credential (or ask the platform-credential adapter);
 * 4. stream through the provider interface;
 * 5. record tokens and cost with `org_id`, `agent_id` and `kind`, and settle
 *    the reservation to the actual cost — also when the stream fails midway
 *    (partial usage, flagged `partial`).
 * Keys exist in memory only for the duration of the call.
 */
export function createModelGateway(deps: ModelGatewayDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps;

  const providerFor = (provider: string) => {
    const p = deps.providers[provider];
    if (!p) throw new MissingCredentialError(`No provider registered for ${provider}`);
    return p;
  };

  async function agentKey(agent: Agent, provider: string) {
    if (agent.credentialId) {
      const credential = await decryptCredential(db, deps.keyWrappers, agent.orgId, agent.credentialId);
      if (!credential) throw new MissingCredentialError("The agent's provider credential was revoked or deleted");
      if (credential.provider !== provider) throw new MissingCredentialError("Credential is for another provider");
      return { apiKey: credential.apiKey, credentialId: agent.credentialId as string | null };
    }
    const platform = await deps.platformCredentials.resolve(agent.orgId, provider);
    if (!platform) throw new MissingCredentialError("Add a provider API key to this agent");
    return { apiKey: platform.apiKey, credentialId: null };
  }

  /** Org calls: the org's default credential, else its newest active one for the provider, else the platform key. */
  async function orgKey(orgId: string, provider: string) {
    const [settings] = await db.select().from(organizationSettings).where(eq(organizationSettings.orgId, orgId));
    const candidates: string[] = [];
    if (settings?.defaultCredentialId) candidates.push(settings.defaultCredentialId);
    const newest = await db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.orgId, orgId),
          eq(providerCredentials.provider, provider),
          isNull(providerCredentials.revokedAt),
        ),
      )
      .orderBy(desc(providerCredentials.createdAt))
      .limit(1);
    if (newest[0]) candidates.push(newest[0].id);
    for (const id of candidates) {
      const credential = await decryptCredential(db, deps.keyWrappers, orgId, id);
      if (credential && credential.provider === provider) return { apiKey: credential.apiKey, credentialId: id };
    }
    const platform = await deps.platformCredentials.resolve(orgId, provider);
    if (!platform) throw new MissingCredentialError("Add a provider API key to this organization");
    return { apiKey: platform.apiKey, credentialId: null as string | null };
  }

  /** Usage of a stream that failed midway: what the provider reported, else counted or estimated. */
  async function partialUsage(
    error: ProviderError,
    provider: ModelProvider,
    request: ModelRequest,
    apiKey: string,
  ): Promise<ModelUsage | null> {
    const p = error.partial;
    if (!p) return null;
    let inputTokens = p.inputTokens;
    if (inputTokens === null) {
      try {
        inputTokens = provider.countTokens ? await provider.countTokens(request, { apiKey }) : null;
      } catch {
        inputTokens = null;
      }
      inputTokens ??= estimateTokens(promptChars(request));
    }
    return {
      inputTokens,
      outputTokens: p.outputTokens ?? estimateTokens(p.outputChars),
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
    };
  }

  async function recordUsage(
    tx: Executor,
    input: {
      orgId: string;
      agentId: string | null;
      kind: "agent" | "router" | "summary";
      runId?: string;
      credentialId: string | null;
      provider: string;
      model: string;
      requestedModel: string;
      usage: ModelUsage;
      partial: boolean;
    },
  ) {
    // Price by the model that answered (a server-side fallback may differ), if we know it.
    const pricedModel = isKnownModel(input.model) ? input.model : input.requestedModel;
    const cost = costNanoUsd(pricedModel, input.usage);
    const [record] = await tx
      .insert(usageRecords)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        kind: input.kind,
        runId: input.runId,
        credentialId: input.credentialId,
        provider: input.provider,
        model: input.model,
        requestedModel: input.requestedModel,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        costNanoUsd: cost,
        partial: input.partial,
        createdAt: now(),
      })
      .returning({ id: usageRecords.id });
    if (!record) throw new Error("usage insert returned nothing");
    return { id: record.id, cost };
  }

  /**
   * Reserves the worst-case cost of a call against the agent's counter for
   * this month, under a row lock. Returns the reservation and the output cap
   * that fits. Throws BudgetExceededError when nothing useful fits.
   */
  async function reserve(agent: Agent, model: string, promptTokens: number, maxTokens: number) {
    const at = now();
    const period = periodOf(at);
    return db.transaction(async (tx) => {
      await tx
        .insert(agentBudgetPeriods)
        .values({
          orgId: agent.orgId,
          agentId: agent.id,
          periodStart: period,
          // First call of the month (or first since budgets existed): start from recorded usage.
          spentNanoUsd: sql`(select coalesce(sum(${usageRecords.costNanoUsd}), 0) from ${usageRecords}
            where ${usageRecords.orgId} = ${agent.orgId} and ${usageRecords.agentId} = ${agent.id}
            and ${usageRecords.createdAt} >= ${monthStartUtc(at).toISOString()}::timestamptz)`,
        })
        .onConflictDoNothing();
      // Abandoned reservations (crashed workers) stop counting.
      const expired = await tx
        .delete(budgetReservations)
        .where(
          and(
            eq(budgetReservations.agentId, agent.id),
            eq(budgetReservations.periodStart, period),
            lt(budgetReservations.expiresAt, at),
          ),
        )
        .returning({ amount: budgetReservations.amountNanoUsd });
      const [row] = await tx
        .select()
        .from(agentBudgetPeriods)
        .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period)))
        .for("update");
      if (!row) throw new Error("budget period row missing");
      const reserved = row.reservedNanoUsd - expired.reduce((n, e) => n + e.amount, 0);

      let cap = maxTokens;
      if (agent.monthlyBudgetNanoUsd !== null) {
        const left = agent.monthlyBudgetNanoUsd - row.spentNanoUsd - reserved;
        cap = Math.min(maxTokens, outputTokensWithin(model, promptTokens, left));
        if (left <= 0 || cap < Math.min(MIN_OUTPUT_TOKENS, maxTokens)) {
          if (expired.length > 0)
            await tx
              .update(agentBudgetPeriods)
              .set({ reservedNanoUsd: Math.max(0, reserved) })
              .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period)));
          throw new BudgetExceededError(agent.id, row.spentNanoUsd, agent.monthlyBudgetNanoUsd);
        }
      }
      const amount = maxCostNanoUsd(model, promptTokens, cap);
      const [reservation] = await tx
        .insert(budgetReservations)
        .values({
          orgId: agent.orgId,
          agentId: agent.id,
          periodStart: period,
          amountNanoUsd: amount,
          expiresAt: new Date(at.getTime() + RESERVATION_TTL_MS),
        })
        .returning();
      await tx
        .update(agentBudgetPeriods)
        .set({ reservedNanoUsd: Math.max(0, reserved) + amount, updatedAt: at })
        .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period)));
      if (!reservation) throw new Error("reservation insert returned nothing");
      return { reservation, maxTokens: cap };
    });
  }

  /** Releases a reservation and adds `actual` to the spent counter, in the caller's transaction. */
  async function settle(tx: Executor, reservation: typeof budgetReservations.$inferSelect, actual: number) {
    const [released] = await tx
      .delete(budgetReservations)
      .where(eq(budgetReservations.id, reservation.id))
      .returning({ amount: budgetReservations.amountNanoUsd });
    await tx
      .update(agentBudgetPeriods)
      .set({
        spentNanoUsd: sql`${agentBudgetPeriods.spentNanoUsd} + ${actual}`,
        reservedNanoUsd: sql`greatest(0, ${agentBudgetPeriods.reservedNanoUsd} - ${released?.amount ?? 0})`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(agentBudgetPeriods.agentId, reservation.agentId),
          eq(agentBudgetPeriods.periodStart, reservation.periodStart),
        ),
      );
  }

  return {
    /** An agent's model call (runs). Streams deltas through `onDelta`. */
    async stream(call: GatewayCall): Promise<GatewayResult> {
      const agent = await getAgent(db, call.orgId, call.agentId);
      if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
      const info = MODEL_CATALOG[agent.model];
      if (!info) throw new ValidationError(`Model ${agent.model} is not in the catalog`);
      const provider = providerFor(info.provider);

      const request: ModelRequest = {
        model: agent.model,
        system: call.system,
        messages: call.messages,
        maxTokens: call.maxTokens,
        tools: call.tools,
        signal: call.signal,
      };
      // Conservative prompt estimate (3 chars/token) so the reservation is an upper bound in practice.
      const promptTokens = Math.ceil(promptChars(request) / 3);
      const key = await agentKey(agent, info.provider);
      const { reservation, maxTokens } = await reserve(agent, agent.model, promptTokens, call.maxTokens);
      request.maxTokens = maxTokens;

      let result: ModelResult;
      try {
        result = await provider.stream(request, { apiKey: key.apiKey, onDelta: call.onDelta });
      } catch (error) {
        const usage = error instanceof ProviderError ? await partialUsage(error, provider, request, key.apiKey) : null;
        await db.transaction(async (tx) => {
          let actual = 0;
          if (usage) {
            const record = await recordUsage(tx, {
              orgId: call.orgId,
              agentId: agent.id,
              kind: "agent",
              runId: call.runId,
              credentialId: key.credentialId,
              provider: info.provider,
              model: agent.model,
              requestedModel: agent.model,
              usage,
              partial: true,
            });
            actual = record.cost;
          }
          await settle(tx, reservation, actual);
        });
        throw error;
      }

      const record = await db.transaction(async (tx) => {
        const r = await recordUsage(tx, {
          orgId: call.orgId,
          agentId: agent.id,
          kind: "agent",
          runId: call.runId,
          credentialId: key.credentialId,
          provider: info.provider,
          model: result.model,
          requestedModel: agent.model,
          usage: result.usage,
          partial: false,
        });
        await settle(tx, reservation, r.cost);
        return r;
      });
      return { ...result, usageRecordId: record.id, costNanoUsd: record.cost, maxTokens };
    },

    /** A call for the organization (router, summaries). Not streamed to anyone; no agent budget. */
    async complete(call: OrgCall): Promise<GatewayResult> {
      const info = MODEL_CATALOG[call.model];
      if (!info) throw new ValidationError(`Model ${call.model} is not in the catalog`);
      const provider = providerFor(info.provider);
      const key = await orgKey(call.orgId, info.provider);
      const request: ModelRequest = {
        model: call.model,
        system: call.system,
        messages: call.messages,
        maxTokens: call.maxTokens,
        outputSchema: call.outputSchema,
        effort: call.effort,
        signal: call.signal,
      };
      const base = {
        orgId: call.orgId,
        agentId: call.agentId ?? null,
        kind: call.kind,
        runId: call.runId,
        credentialId: key.credentialId,
        provider: info.provider,
        requestedModel: call.model,
      };
      let result: ModelResult;
      try {
        result = await provider.stream(request, { apiKey: key.apiKey, onDelta: () => {} });
      } catch (error) {
        const usage = error instanceof ProviderError ? await partialUsage(error, provider, request, key.apiKey) : null;
        if (usage) await recordUsage(db, { ...base, model: call.model, usage, partial: true });
        throw error;
      }
      const record = await recordUsage(db, { ...base, model: result.model, usage: result.usage, partial: false });
      return { ...result, usageRecordId: record.id, costNanoUsd: record.cost, maxTokens: call.maxTokens };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;

/** Reserved and spent amounts of an agent this month (from the gateway's counter). */
export async function agentBudgetState(db: Database, orgId: string, agentId: string, at = new Date()) {
  const [row] = await db
    .select()
    .from(agentBudgetPeriods)
    .where(
      and(
        eq(agentBudgetPeriods.orgId, orgId),
        eq(agentBudgetPeriods.agentId, agentId),
        gte(agentBudgetPeriods.periodStart, periodOf(at)),
      ),
    );
  return { spentNanoUsd: row?.spentNanoUsd ?? 0, reservedNanoUsd: row?.reservedNanoUsd ?? 0 };
}
