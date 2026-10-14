import type { KeyWrapper, PlatformCredentials } from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";
import {
  costNanoUsd,
  isKnownModel,
  MODEL_CATALOG,
  type ModelMessage,
  type ModelProvider,
  type ModelResult,
} from "@agenteschat/providers";
import { getAgent } from "./agents";
import { decryptCredential } from "./credentials";
import { BudgetExceededError, MissingCredentialError, NotFoundError, ValidationError } from "./errors";
import { agentSpendThisMonth } from "./usage";

export interface ModelGatewayDeps {
  db: Database;
  /** Current wrapper first, then legacy ones (rotation). */
  keyWrappers: KeyWrapper[];
  providers: Record<string, ModelProvider>;
  platformCredentials: PlatformCredentials;
  now?: () => Date;
}

export interface GatewayCall {
  orgId: string;
  agentId: string;
  runId?: string;
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  onDelta(text: string): void;
  signal?: AbortSignal;
}

export interface GatewayResult extends ModelResult {
  usageRecordId: string;
  costNanoUsd: number;
}

/**
 * The only way to call a model (docs/adr/0007, D2). For every call:
 * 1. load the agent (org-scoped) and its model from the catalog;
 * 2. check the monthly budget BEFORE calling;
 * 3. decrypt the org's credential (or ask the platform-credential adapter);
 * 4. stream through the provider interface;
 * 5. record tokens and cost with `org_id` and `agent_id`.
 * Keys exist in memory only for the duration of the call.
 */
export function createModelGateway(deps: ModelGatewayDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async stream(call: GatewayCall): Promise<GatewayResult> {
      const agent = await getAgent(deps.db, call.orgId, call.agentId);
      if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
      const info = MODEL_CATALOG[agent.model];
      if (!info) throw new ValidationError(`Model ${agent.model} is not in the catalog`);

      if (agent.monthlyBudgetNanoUsd !== null) {
        const spent = await agentSpendThisMonth(deps.db, call.orgId, agent.id, now());
        if (spent >= agent.monthlyBudgetNanoUsd)
          throw new BudgetExceededError(agent.id, spent, agent.monthlyBudgetNanoUsd);
      }

      let apiKey: string;
      let credentialId: string | null = null;
      if (agent.credentialId) {
        const credential = await decryptCredential(deps.db, deps.keyWrappers, call.orgId, agent.credentialId);
        if (!credential) throw new MissingCredentialError("The agent's provider credential was revoked or deleted");
        if (credential.provider !== info.provider)
          throw new MissingCredentialError("Credential is for another provider");
        apiKey = credential.apiKey;
        credentialId = agent.credentialId;
      } else {
        const platform = await deps.platformCredentials.resolve(call.orgId, info.provider);
        if (!platform) throw new MissingCredentialError("Add a provider API key to this agent");
        apiKey = platform.apiKey;
      }

      const provider = deps.providers[info.provider];
      if (!provider) throw new MissingCredentialError(`No provider registered for ${info.provider}`);

      const result = await provider.stream(
        {
          model: agent.model,
          system: call.system,
          messages: call.messages,
          maxTokens: call.maxTokens,
          signal: call.signal,
        },
        { apiKey, onDelta: call.onDelta },
      );

      // Price by the model that answered (a server-side fallback may differ), if we know it.
      const pricedModel = isKnownModel(result.model) ? result.model : agent.model;
      const cost = costNanoUsd(pricedModel, result.usage);
      const [record] = await deps.db
        .insert(schema.usageRecords)
        .values({
          orgId: call.orgId,
          agentId: agent.id,
          runId: call.runId,
          credentialId,
          provider: info.provider,
          model: result.model,
          requestedModel: agent.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
          costNanoUsd: cost,
        })
        .returning({ id: schema.usageRecords.id });
      if (!record) throw new Error("usage insert returned nothing");
      return { ...result, usageRecordId: record.id, costNanoUsd: cost };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;
