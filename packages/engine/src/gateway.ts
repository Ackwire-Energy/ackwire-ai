import type { KeyWrapper, PlatformCredentials, PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, isNull, lt, rowsOf, schema, sql } from "@agenteschat/db";
import {
  costNanoUsd,
  type EmbeddingProvider,
  embeddingCostNanoUsd,
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
  PROVIDERS,
  ProviderError,
  promptChars,
  type SystemPrompt,
  type ToolSpec,
} from "@agenteschat/providers";
import { type Agent, getAgent } from "./agents";
import { caches } from "./cache";
import { decryptCredential } from "./credentials";
import { BudgetExceededError, MissingCredentialError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { monthStartUtc } from "./usage";

const { usageRecords, agentBudgetPeriods, budgetReservations, providerCredentials, organizationSettings } = schema;

export interface ModelGatewayDeps {
  db: Database;
  /** Current wrapper first, then legacy ones (rotation). */
  keyWrappers: KeyWrapper[];
  providers: Record<string, ModelProvider>;
  platformCredentials: PlatformCredentials;
  now?: () => Date;
  /** Embeddings for search (optional: without it search is full-text only). */
  embeddings?: { provider: EmbeddingProvider; apiKey: string };
  /** Called when an agent's monthly spend crosses 80% (`warning`) or 100% (`exhausted`) of its budget. */
  onBudgetThreshold?(event: {
    agent: Agent;
    level: "warning" | "exhausted";
    spentNanoUsd: number;
    budgetNanoUsd: number;
  }): Promise<void> | void;
}

export const BUDGET_WARNING_RATIO = 0.8;

/** A model call made by an agent: billed to the agent's credential and budget. */
export interface GatewayCall {
  orgId: string;
  agentId: string;
  /** The agent row, when the caller already has it (saves a lookup). */
  agent?: Agent;
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

  type Key = {
    apiKey: string;
    workspaceId?: string;
    organization?: string;
    project?: string;
    credentialId: string | null;
  };
  const label = (provider: string) => (PROVIDERS as Record<string, { label: string }>)[provider]?.label ?? provider;
  const noKey = (provider: string) =>
    new MissingCredentialError(`Configure uma chave da API da ${label(provider)} nas configurações do workspace`);
  const keyOf = (c: Awaited<ReturnType<typeof decryptCredential>>, credentialId: string | null): Key | null =>
    c
      ? {
          apiKey: c.apiKey,
          workspaceId: c.workspaceId,
          organization: c.options?.organization,
          project: c.options?.project,
          credentialId,
        }
      : null;

  /**
   * One resolution order for every call: the agent's own credential → the
   * org's default for that provider (the default credential when it is of
   * that provider, else the org's newest key of that provider) → the platform
   * key for that provider, only if configured. Never a silent failure.
   */
  async function resolveKey(orgId: string, provider: string, agentCredentialId?: string | null): Promise<Key> {
    if (agentCredentialId) {
      const credential = await decryptCredential(db, deps.keyWrappers, orgId, agentCredentialId);
      if (!credential) {
        throw new MissingCredentialError(
          "A chave da API deste agente foi revogada; escolha outra nas configurações do agente",
        );
      }
      if (credential.provider !== provider) {
        throw new MissingCredentialError(
          `O modelo deste agente é da ${label(provider)}, mas a chave escolhida é da ${label(credential.provider)}`,
        );
      }
      return keyOf(credential, agentCredentialId) as Key;
    }
    const defaultId = await orgDefaultCredentialId(orgId, provider);
    if (defaultId) {
      const credential = await decryptCredential(db, deps.keyWrappers, orgId, defaultId);
      if (credential && credential.provider === provider) return keyOf(credential, defaultId) as Key;
    }
    const platform = await deps.platformCredentials.resolve(orgId, provider);
    if (!platform) throw noKey(provider);
    return { apiKey: platform.apiKey, workspaceId: platform.workspaceId, credentialId: null };
  }

  /** The org's default credential for a provider (cached; invalidated when keys or settings change). */
  async function orgDefaultCredentialId(orgId: string, provider: string): Promise<string | null> {
    return (await caches.credentials.getOrLoad(`${orgId}:default:${provider}`, async () => {
      const [settings] = await db
        .select({
          perProvider: organizationSettings.defaultCredentialIds,
          id: organizationSettings.defaultCredentialId,
          provider: providerCredentials.provider,
        })
        .from(organizationSettings)
        .leftJoin(
          providerCredentials,
          and(
            eq(providerCredentials.id, organizationSettings.defaultCredentialId),
            isNull(providerCredentials.revokedAt),
          ),
        )
        .where(eq(organizationSettings.orgId, orgId));
      const perProvider = (settings?.perProvider ?? {}) as Partial<Record<string, string>>;
      if (perProvider[provider]) return perProvider[provider] as string;
      if (settings?.id && settings.provider === provider) return settings.id;
      const [newest] = await db
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
      return newest?.id ?? null;
    })) as string | null;
  }

  const agentKey = (agent: Agent, provider: string) => resolveKey(agent.orgId, provider, agent.credentialId);
  const orgKey = (orgId: string, provider: string) => resolveKey(orgId, provider, null);

  /** Usage of a stream that failed midway: what the provider reported, else counted or estimated. */
  async function partialUsage(
    error: ProviderError,
    provider: ModelProvider,
    request: ModelRequest,
    key: { apiKey: string; workspaceId?: string; organization?: string; project?: string },
  ): Promise<ModelUsage | null> {
    const p = error.partial;
    if (!p) return null;
    let inputTokens = p.inputTokens;
    if (inputTokens === null) {
      try {
        inputTokens = provider.countTokens ? await provider.countTokens(request, key) : null;
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
  async function reserve(
    agent: Agent,
    model: string,
    promptTokens: number,
    maxTokens: number,
  ): Promise<{
    reservation: Pick<typeof budgetReservations.$inferSelect, "id" | "agentId" | "periodStart"> | null;
    maxTokens: number;
  }> {
    // No budget: nothing to reserve; the counter is updated when the call settles.
    if (agent.monthlyBudgetNanoUsd === null) return { reservation: null, maxTokens };
    const at = now();
    const period = periodOf(at);
    // Fast path, one statement: the worst case fits under the budget → reserve it atomically.
    const amount = maxCostNanoUsd(model, promptTokens, maxTokens);
    const id = Bun.randomUUIDv7();
    const fast = rowsOf<{ ok: number }>(
      await db.execute(sql`with upd as (
          update ${agentBudgetPeriods}
          set reserved_nano_usd = reserved_nano_usd + ${amount}, updated_at = now()
          where agent_id = ${agent.id} and period_start = ${period}::date
            and spent_nano_usd + reserved_nano_usd + ${amount} <= ${agent.monthlyBudgetNanoUsd}
          returning agent_id
        ), res as (
          insert into ${budgetReservations} (id, org_id, agent_id, period_start, amount_nano_usd, expires_at, created_at)
          select ${id}::uuid, ${agent.orgId}::uuid, ${agent.id}::uuid, ${period}::date, ${amount},
                 ${new Date(at.getTime() + RESERVATION_TTL_MS).toISOString()}::timestamptz, now()
          from upd
          returning id
        )
        select count(*)::int as ok from res`),
    );
    if (Number(fast[0]?.ok ?? 0) > 0) return { reservation: { id, agentId: agent.id, periodStart: period }, maxTokens };
    // Slow path (first call of the month, expired reservations, or the cap must shrink): locked transaction.
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
  async function settle(
    tx: Executor,
    reservation: Pick<typeof budgetReservations.$inferSelect, "id" | "agentId" | "periodStart"> | null,
    actual: number,
    agent?: Agent,
  ) {
    if (!reservation) {
      if (!agent) return actual;
      const [row] = await tx
        .insert(agentBudgetPeriods)
        .values({ orgId: agent.orgId, agentId: agent.id, periodStart: periodOf(now()), spentNanoUsd: actual })
        .onConflictDoUpdate({
          target: [agentBudgetPeriods.agentId, agentBudgetPeriods.periodStart],
          set: { spentNanoUsd: sql`${agentBudgetPeriods.spentNanoUsd} + ${actual}`, updatedAt: now() },
        })
        .returning({ spent: agentBudgetPeriods.spentNanoUsd });
      return row?.spent ?? actual;
    }
    const [released] = await tx
      .delete(budgetReservations)
      .where(eq(budgetReservations.id, reservation.id))
      .returning({ amount: budgetReservations.amountNanoUsd });
    const updated = await tx
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
      )
      .returning({ spent: agentBudgetPeriods.spentNanoUsd });
    return updated[0]?.spent ?? actual;
  }

  /**
   * After a successful agent call, one statement: the usage record, the
   * reservation released and the spend counter updated (no transaction
   * round trips; a remote database costs one round trip here).
   */
  async function settleCall(input: {
    agent: Agent;
    reservation: Pick<typeof budgetReservations.$inferSelect, "id" | "agentId" | "periodStart"> | null;
    runId?: string;
    credentialId: string | null;
    provider: string;
    model: string;
    usage: ModelUsage;
  }) {
    const { agent, usage } = input;
    const pricedModel = isKnownModel(input.model) ? input.model : agent.model;
    const cost = costNanoUsd(pricedModel, usage);
    const id = Bun.randomUUIDv7();
    const period = input.reservation?.periodStart ?? periodOf(now());
    const at = now().toISOString();
    const rows = rowsOf<{ spent: string | number }>(
      await db.execute(sql`with d as (
          delete from ${budgetReservations} where id = ${input.reservation?.id ?? null}::uuid returning amount_nano_usd
        ), u as (
          insert into ${usageRecords} (id, org_id, agent_id, kind, run_id, credential_id, provider, model, requested_model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nano_usd, partial, created_at)
          values (${id}::uuid, ${agent.orgId}::uuid, ${agent.id}::uuid, 'agent', ${input.runId ?? null}::uuid,
            ${input.credentialId}::uuid, ${input.provider}, ${input.model}, ${agent.model}, ${usage.inputTokens},
            ${usage.outputTokens}, ${usage.cacheReadTokens}, ${usage.cacheWriteTokens}, ${cost}, false, ${at}::timestamptz)
          returning id
        ), p as (
          insert into ${agentBudgetPeriods} (org_id, agent_id, period_start, spent_nano_usd, reserved_nano_usd, updated_at)
          values (${agent.orgId}::uuid, ${agent.id}::uuid, ${period}::date, ${cost}, 0, now())
          on conflict (agent_id, period_start) do update set
            spent_nano_usd = ${agentBudgetPeriods}.spent_nano_usd + excluded.spent_nano_usd,
            reserved_nano_usd = greatest(0, ${agentBudgetPeriods}.reserved_nano_usd - coalesce((select amount_nano_usd from d), 0)),
            updated_at = now()
          returning spent_nano_usd
        )
        select (select spent_nano_usd from p) as spent, (select count(*) from u) as inserted`),
    );
    return { record: { id, cost }, spent: Number(rows[0]?.spent ?? cost) };
  }

  /** Tells the agent's owner when spend crosses 80% and 100% of the budget (once each per month). */
  async function checkThresholds(agent: Agent, spent: number, actual: number) {
    const budget = agent.monthlyBudgetNanoUsd;
    if (budget === null || budget <= 0 || !deps.onBudgetThreshold) return;
    const before = spent - actual;
    for (const [level, ratio] of [
      ["exhausted", 1],
      ["warning", BUDGET_WARNING_RATIO],
    ] as const) {
      if (before < budget * ratio && spent >= budget * ratio) {
        await deps.onBudgetThreshold({ agent, level, spentNanoUsd: spent, budgetNanoUsd: budget });
        return;
      }
    }
  }

  return {
    /** An agent's model call (runs). Streams deltas through `onDelta`. */
    async stream(call: GatewayCall): Promise<GatewayResult> {
      const agent =
        call.agent && call.agent.id === call.agentId && call.agent.orgId === call.orgId
          ? call.agent
          : await getAgent(db, call.orgId, call.agentId);
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
        result = await provider.stream(request, {
          apiKey: key.apiKey,
          workspaceId: key.workspaceId,
          organization: key.organization,
          project: key.project,
          onDelta: call.onDelta,
        });
      } catch (error) {
        const usage = error instanceof ProviderError ? await partialUsage(error, provider, request, key) : null;
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
          await settle(tx, reservation, actual, agent);
        });
        throw error;
      }

      const { record, spent } = await settleCall({
        agent,
        reservation,
        runId: call.runId,
        credentialId: key.credentialId,
        provider: info.provider,
        model: result.model,
        usage: result.usage,
      });
      await checkThresholds(agent, spent, record.cost);
      return { ...result, usageRecordId: record.id, costNanoUsd: record.cost, maxTokens };
    },

    /**
     * Usage of a non-model service called for an org (e.g. the Jev router):
     * recorded like every call, with its kind and provider, billed to the platform.
     */
    async recordExternalUsage(input: {
      orgId: string;
      kind: "router";
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costNanoUsd: number;
    }) {
      const [row] = await db
        .insert(usageRecords)
        .values({
          orgId: input.orgId,
          agentId: null,
          kind: input.kind,
          credentialId: null,
          provider: input.provider,
          model: input.model,
          requestedModel: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costNanoUsd: input.costNanoUsd,
          billedTo: "platform",
          createdAt: now(),
        })
        .returning({ id: usageRecords.id });
      return row?.id ?? null;
    },

    /** Whether embeddings are available (else search falls back to full-text only). */
    hasEmbeddings: () => deps.embeddings !== undefined,

    /**
     * Embeds texts for the organization's search index (kind `embedding`,
     * no agent). Returns null when no embedding provider is configured.
     */
    async embed(call: { orgId: string; texts: string[]; inputType: "document" | "query" }) {
      if (!deps.embeddings || call.texts.length === 0) return null;
      const { provider, apiKey } = deps.embeddings;
      const result = await provider.embed(call.texts, { apiKey, inputType: call.inputType });
      const cost = embeddingCostNanoUsd(result.model, result.tokens);
      await db.insert(usageRecords).values({
        orgId: call.orgId,
        agentId: null,
        kind: "embedding",
        credentialId: null,
        provider: provider.id,
        model: result.model,
        requestedModel: provider.model,
        inputTokens: result.tokens,
        outputTokens: 0,
        costNanoUsd: cost,
        createdAt: now(),
      });
      return result;
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
        result = await provider.stream(request, {
          apiKey: key.apiKey,
          workspaceId: key.workspaceId,
          onDelta: () => {},
        });
      } catch (error) {
        const usage = error instanceof ProviderError ? await partialUsage(error, provider, request, key) : null;
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

/**
 * Budget hook that tells the agent's owner over the WebSocket
 * (`budget.warning` / `budget.exhausted`); an agent without an owner tells
 * the organization's admins.
 */
export function notifyOwnerOnBudget(pubsub: PubSub, db?: Database): NonNullable<ModelGatewayDeps["onBudgetThreshold"]> {
  return async ({ agent, level, spentNanoUsd, budgetNanoUsd }) => {
    const recipients = agent.ownerUserId ? [agent.ownerUserId] : db ? await adminIds(db, agent.orgId) : [];
    for (const userId of recipients) {
      await publishUserEvent(pubsub, agent.orgId, userId, {
        type: `budget.${level}`,
        agentId: agent.id,
        spentNanoUsd,
        budgetNanoUsd,
      });
    }
  };
}

/** Owners and admins of an organization (who decides when an agent has no owner). */
export async function adminIds(db: Database, orgId: string) {
  const rows = await db
    .select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(
      and(eq(schema.organizationMembers.orgId, orgId), sql`${schema.organizationMembers.role} in ('owner', 'admin')`),
    );
  return rows.map((r) => r.userId);
}
