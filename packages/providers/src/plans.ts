/**
 * Coding plans that think through Claude Code on a computer with the key their
 * owner pastes ("key accounts", ADR 0056). Pure data, read by the runner (where
 * a turn goes, which variable holds the key, what each model alias runs), the
 * engine and the apps (names, where the key is made, the model choices): it
 * imports nothing. The key travels sealed to the computer and stays there; our
 * server never holds or routes it, and the endpoint a turn uses comes from the
 * runner's own copy of this file.
 *
 * Settings as each maker documents them for Claude Code (read 2026-10-24):
 * docs.z.ai/devpack/tool/claude, kimi.com/code/docs (third-party tools, Claude
 * Code), platform.minimax.io/docs/coding-plan/claude-code and
 * opencode.ai/v2/docs/console/harnesses/claude-code.
 */

/** Claude Code's model aliases: an agent on a plan keeps its alias (`--model sonnet`), the plan names the model. */
export type PlanAlias = "opus" | "sonnet" | "haiku";
export const PLAN_ALIASES: readonly PlanAlias[] = ["opus", "sonnet", "haiku"];

export interface PlanModel {
  /** What Claude Code sends for the alias (`ANTHROPIC_DEFAULT_SONNET_MODEL`); `[1m]`: a 1M-token window. */
  id: string;
  label: string;
}

export interface CodingPlan {
  /** The account's first name ("GLM Coding"), numbered per owner. */
  label: string;
  /** Who sells it, for the logo's neighbors and the terms notice ("{{maker}} says…"). */
  maker: string;
  /** Where its owner makes the key. */
  site: string;
  /** What its keys look like (a `RegExp` source): loose, only to catch a paste that isn't a key. */
  keyPattern: string;
  claudeCode: {
    /** Its Anthropic Messages endpoint (Claude Code adds `/v1/messages`). */
    baseUrl: string;
    /** The variable Claude Code reads the key from. */
    tokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
    /** The aliases offered, with what each runs; one left out runs `sonnet`'s model. */
    models: { sonnet: PlanModel } & Partial<Record<Exclude<PlanAlias, "sonnet">, PlanModel>>;
    /** The maker's other documented settings. */
    env?: Readonly<Record<string, string>>;
  };
  /** The maker's usage endpoint for the key (`apps/server/runner/plan-usage.ts` reads its answer). */
  usage?: { url: string; auth: "bearer" | "raw" };
}

export const CODING_PLANS = {
  zai: {
    label: "GLM Coding",
    maker: "Z.ai",
    site: "https://z.ai/manage-apikey/apikey-list",
    keyPattern: "^[A-Za-z0-9._-]{16,256}$",
    claudeCode: {
      baseUrl: "https://api.z.ai/api/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      models: {
        sonnet: { id: "glm-5.3[1m]", label: "GLM-5.3" },
        haiku: { id: "glm-5.3-flash[1m]", label: "GLM-5.3 Flash" },
      },
      env: { API_TIMEOUT_MS: "3000000" },
    },
    usage: { url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "raw" },
  },
  kimi: {
    label: "Kimi Code",
    maker: "Kimi",
    site: "https://www.kimi.com/code/console",
    keyPattern: "^[A-Za-z0-9._-]{16,256}$",
    claudeCode: {
      baseUrl: "https://api.kimi.ai/coding/",
      tokenEnv: "ANTHROPIC_API_KEY",
      // Every membership with coding quota has `kimi-for-coding`; K3.1 Pro needs Plus or above.
      models: {
        opus: { id: "k3.1-pro", label: "K3.1 Pro" },
        sonnet: { id: "kimi-for-coding", label: "Kimi for Coding" },
      },
    },
    usage: { url: "https://api.kimi.com/coding/v1/usages", auth: "bearer" },
  },
  minimax: {
    label: "MiniMax",
    maker: "MiniMax",
    site: "https://platform.minimax.io/console/plan",
    keyPattern: "^[A-Za-z0-9._-]{16,2048}$",
    claudeCode: {
      baseUrl: "https://api.minimax.io/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      models: { sonnet: { id: "MiniMax-M3.1-Flash[1m]", label: "MiniMax M3.1 Flash" } },
    },
  },
  opencode: {
    label: "OpenCode Go",
    maker: "OpenCode",
    site: "https://opencode.ai/console",
    keyPattern: "^oc_sk_[A-Za-z0-9._-]{8,256}$",
    claudeCode: {
      baseUrl: "https://opencode.ai/inference/go/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      models: {
        sonnet: { id: "minimax-m3", label: "MiniMax M3" },
        haiku: { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      },
      // Its models that aren't Claude refuse some of Claude Code's betas; the OpenCode CLI, if the agent runs
      // it, reads no project config that could point it elsewhere.
      env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    },
    usage: { url: "https://opencode.ai/zen/go/v1/usage", auth: "bearer" },
  },
} as const satisfies Record<string, CodingPlan>;

export type PlanId = keyof typeof CODING_PLANS;
export const PLAN_IDS = Object.keys(CODING_PLANS) as PlanId[];
export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && Object.hasOwn(CODING_PLANS, v);
export const planOf = (id: unknown): CodingPlan | undefined => (isPlanId(id) ? CODING_PLANS[id] : undefined);

/** The model an alias runs on a plan; `auto`, an alias the plan leaves out or none: `sonnet`'s. */
export function planModel(plan: CodingPlan, alias: string | null | undefined): PlanModel {
  const models: Partial<Record<string, PlanModel>> = plan.claudeCode.models;
  return (alias ? models[alias] : undefined) ?? plan.claudeCode.models.sonnet;
}

/** The aliases a plan offers, in Claude Code's order. */
export const planAliases = (plan: CodingPlan): PlanAlias[] =>
  PLAN_ALIASES.filter((a) => plan.claudeCode.models[a] !== undefined);

/** A pasted key that fits the plan: one line, the plan's shape. */
export const planKeyFits = (plan: CodingPlan, key: string) => new RegExp(plan.keyPattern).test(key);
