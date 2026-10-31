/**
 * Coding plans that think through Claude Code on a computer with the key their
 * owner pastes ("key accounts", ADR 0059). Pure data, read by the runner (where
 * a turn goes, which variable holds the key, what each model alias runs), the
 * engine and the apps (names, where the key is made, the model choices): it
 * imports nothing. The key travels sealed to the computer and stays there; our
 * server never holds or routes it, and the endpoint a turn uses comes from the
 * runner's own copy of this file.
 *
 * Settings as each maker documents them for Claude Code (read 2026-10-24):
 * docs.z.ai/devpack/tool/claude, kimi.com/code/docs (third-party tools, Claude
 * Code), platform.minimax.io/docs/coding-plan/claude-code and
 * opencode.ai/v2/docs/console/harnesses/claude-code. Each plan's models as its
 * maker lists them (read 2026-10-30): docs.z.ai/devpack/overview,
 * kimi.com/code/docs/en/kimi-code/models.html,
 * platform.minimax.io/docs/coding-plan/intro, and opencode.ai/v2/docs/console/go
 * with its live list (opencode.ai/inference/go/v1/models). Flagships in their
 * makers' words (read 2026-10-30): docs.z.ai/guides/llm/glm-5.3, Kimi's models
 * page, Alibaba's Qwen3.8-Max announcement and
 * ai.google.dev/gemini-api/docs/models/gemini-4-argon.
 */

/** Claude Code's model aliases: "Automático" picks one per run, and the plan names the model each one runs. */
export type PlanAlias = "opus" | "sonnet" | "haiku";
export const PLAN_ALIASES: readonly PlanAlias[] = ["opus", "sonnet", "haiku"];

/**
 * How the picker sells a model, from its plan's or maker's own words: `smart` its maker's flagship, `fast` its
 * maker's high-speed version, `cheap` one the plan's limits stretch furthest with.
 */
export type PlanModelTag = "cheap" | "fast" | "smart";

/** What the plan's account must allow before a model answers: `globalRegion`, OpenCode's Global region. */
export type PlanModelNeed = "globalRegion";

export interface PlanModel {
  /** What Claude Code sends (`--model`, or `ANTHROPIC_DEFAULT_SONNET_MODEL` for its alias); `[1m]`: a 1M-token window. */
  id: string;
  label: string;
  /**
   * The alias it runs for ("Automático"'s tiers, and an agent that chose the alias): `sonnet` on exactly one
   * model, the others at most once; an alias the plan leaves out runs `sonnet`'s model. Without one, it runs only
   * when chosen.
   */
  alias?: PlanAlias;
  tag?: PlanModelTag;
  needs?: PlanModelNeed;
  /**
   * Who makes it, on a plan that sells several makers' models (the picker groups them): an API provider's id
   * (`@agenteschat/providers`: its name and logo), else the maker's name.
   */
  maker?: string;
}

export interface CodingPlan {
  /** The account's first name ("GLM Coding"), numbered per owner. */
  label: string;
  /** The plan as its maker sells it ("GLM Coding Plan"), for titles. */
  name: string;
  /** Who sells it, for the logo's neighbors and the terms notice ("{{maker}} says…"). */
  maker: string;
  /** Where its owner makes the key. */
  site: string;
  /** What its keys look like (a `RegExp` source): loose, only to catch a paste that isn't a key. */
  keyPattern: string;
  /** How its keys start, as the key field's example; none where the maker publishes no prefix. */
  placeholder?: string;
  claudeCode: {
    /** Its Anthropic Messages endpoint (Claude Code adds `/v1/messages`). */
    baseUrl: string;
    /** The variable Claude Code reads the key from. */
    tokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
    /** Every model of the plan that answers through Claude Code, each maker's together, the aliases' makers first. */
    models: readonly PlanModel[];
    /** The maker's other documented settings. */
    env?: Readonly<Record<string, string>>;
  };
  /** The maker's usage endpoint for the key (`apps/server/runner/plan-usage.ts` reads its answer). */
  usage?: { url: string; auth: "bearer" | "raw" };
}

export const CODING_PLANS = {
  zai: {
    label: "GLM Coding",
    name: "GLM Coding Plan",
    maker: "Z.ai",
    site: "https://z.ai/manage-apikey/apikey-list",
    keyPattern: "^[A-Za-z0-9._-]{16,256}$",
    claudeCode: {
      baseUrl: "https://api.z.ai/api/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      // Every tier has both; Flash spends about a third of GLM-5.3's credits per token.
      models: [
        { id: "glm-5.3[1m]", label: "GLM-5.3", alias: "sonnet", tag: "smart" },
        { id: "glm-5.3-flash[1m]", label: "GLM-5.3 Flash", alias: "haiku", tag: "cheap" },
      ],
      env: { API_TIMEOUT_MS: "3000000" },
    },
    usage: { url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "raw" },
  },
  kimi: {
    label: "Kimi Code",
    name: "Kimi Code",
    maker: "Kimi",
    site: "https://www.kimi.com/code/console",
    keyPattern: "^[A-Za-z0-9._-]{16,256}$",
    claudeCode: {
      baseUrl: "https://api.kimi.ai/coding/",
      tokenEnv: "ANTHROPIC_API_KEY",
      // `kimi-for-coding` (K2.8 Preview), K3.1 Pro and both K3 need Plus or above, the high-speed models Pro or
      // above. K3.1 Pro Highspeed spends about 2× K3.1 Pro's quota; K2.7 Code Highspeed is another model, at about
      // 3× the quota of K2.7 Code (not in the plan). K3 256K spends about half of K3's.
      models: [
        { id: "kimi-for-coding", label: "Kimi for Coding", alias: "sonnet" },
        { id: "k3.1-pro", label: "K3.1 Pro", alias: "opus", tag: "smart" },
        { id: "k3.1-pro-highspeed", label: "K3.1 Pro Highspeed", tag: "fast" },
        { id: "kimi-for-coding-highspeed", label: "K2.7 Code Highspeed", tag: "fast" },
        { id: "k3", label: "K3" },
        { id: "k3-256k", label: "K3 256K" },
      ],
    },
    usage: { url: "https://api.kimi.com/coding/v1/usages", auth: "bearer" },
  },
  minimax: {
    label: "MiniMax",
    name: "MiniMax M Plan",
    maker: "MiniMax",
    site: "https://platform.minimax.io/console/plan",
    keyPattern: "^[A-Za-z0-9._-]{16,2048}$",
    claudeCode: {
      baseUrl: "https://api.minimax.io/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      models: [{ id: "MiniMax-M3.1-Flash[1m]", label: "MiniMax M3.1 Flash", alias: "sonnet" }],
    },
  },
  opencode: {
    label: "OpenCode Go",
    name: "OpenCode Go",
    maker: "OpenCode",
    site: "https://opencode.ai/console",
    keyPattern: "^oc_sk_[A-Za-z0-9._-]{8,256}$",
    placeholder: "oc_sk_…",
    claudeCode: {
      baseUrl: "https://opencode.ai/inference/go/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      // Go answers in Anthropic's format for every model, translating the others. Each model has its own
      // monthly cap; `cheap`: 20,000 or more requests a month on Go by OpenCode's own estimates. Left out: the
      // free models (for a limited time) and the ones that train on what they're sent. DeepSeek's models answer
      // only once the OpenCode workspace allows the Global region (Settings › Privacy), off by default.
      models: [
        { id: "minimax-m3", label: "MiniMax M3", alias: "sonnet", maker: "minimax" },
        { id: "minimax-m3.1-flash", label: "MiniMax M3.1 Flash", maker: "minimax" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", alias: "haiku", maker: "anthropic" },
        { id: "glm-5.3", label: "GLM-5.3", tag: "smart", maker: "zai" },
        { id: "glm-5.3-flash", label: "GLM-5.3 Flash", tag: "cheap", maker: "zai" },
        { id: "glm-5.2", label: "GLM-5.2", maker: "zai" },
        { id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro", tag: "smart", maker: "moonshot" },
        { id: "kimi-k3", label: "Kimi K3", maker: "moonshot" },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", maker: "moonshot" },
        { id: "qwen3.8-max", label: "Qwen3.8 Max", tag: "smart", maker: "Alibaba" },
        { id: "qwen3.8-flash", label: "Qwen3.8 Flash", tag: "cheap", maker: "Alibaba" },
        { id: "qwen3.7-plus", label: "Qwen3.7 Plus", tag: "cheap", maker: "Alibaba" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", needs: "globalRegion", maker: "deepseek" },
        {
          id: "deepseek-v4.1-flash",
          label: "DeepSeek V4.1 Flash",
          tag: "cheap",
          needs: "globalRegion",
          maker: "deepseek",
        },
        { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", maker: "Xiaomi" },
        { id: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", tag: "cheap", maker: "Xiaomi" },
        { id: "gpt-6-luna", label: "GPT-6 Luna", tag: "cheap", maker: "openai" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", maker: "openai" },
        { id: "gemini-4-argon", label: "Gemini 4 Argon", tag: "smart", maker: "gemini" },
        { id: "grok-4.7", label: "Grok 4.7", maker: "xAI" },
        { id: "longcat-2.0", label: "LongCat 2.0", tag: "cheap", maker: "Meituan" },
        { id: "hy3", label: "Hy3", tag: "cheap", maker: "Tencent" },
        { id: "hy4-preview", label: "Hy4 Preview", maker: "Tencent" },
        { id: "step-5-preview", label: "Step 5 Preview", maker: "StepFun" },
      ],
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

const isAlias = (v: unknown): v is PlanAlias => PLAN_ALIASES.some((a) => a === v);

/**
 * The model a stored value runs on a plan: one of its models by id, the model of an alias, else (`auto`, an alias
 * the plan leaves out, another plan's model, none) `sonnet`'s.
 */
export function planModel(plan: CodingPlan, value: string | null | undefined): PlanModel {
  const { models } = plan.claudeCode;
  const byAlias = isAlias(value) ? models.find((m) => m.alias === value) : undefined;
  return (
    models.find((m) => m.id === value) ??
    byAlias ??
    models.find((m) => m.alias === "sonnet") ??
    (models[0] as PlanModel)
  );
}

/** What a plan's model is stored and chosen as: its alias where it has one (portable to Claude), else its id. */
export const planModelValue = (m: PlanModel): string => m.alias ?? m.id;

/** A coding plan's model by its id, whichever plan has it. */
export const planModelById = (id: string): PlanModel | undefined =>
  Object.values<CodingPlan>(CODING_PLANS)
    .flatMap((p) => p.claudeCode.models)
    .find((m) => m.id === id);

/** Every coding plan's model ids: what an agent on Claude Code may store besides Claude's own. */
export const isPlanModelId = (v: string) => planModelById(v) !== undefined;

/**
 * The `--model` of a Claude Code turn for a stored value: an alias as is (on a plan, the plan names its model);
 * with a plan, one of its models by id; without one, a Claude id. Anything else (another plan's model, none) runs
 * `sonnet`.
 */
export function claudeCodeModel(plan: CodingPlan | undefined, value: unknown): string {
  if (isAlias(value)) return value;
  if (typeof value !== "string") return "sonnet";
  if (plan) return plan.claudeCode.models.some((m) => m.id === value) ? value : "sonnet";
  return /^claude-/.test(value) ? value : "sonnet";
}

/** A pasted key that fits the plan: one line, the plan's shape. */
export const planKeyFits = (plan: CodingPlan, key: string) => new RegExp(plan.keyPattern).test(key);

/**
 * The accounts that may have one login per agent, the same account signed in again for each, where a login thinks
 * for one agent: on a runner before protocol 29, and on a computer where every agent is its own OS user for a
 * login made before it or with `SHARED_SIGN_INS` off. A coding plan's key has no refresh token, so its copies never
 * sign each other out. Claude's sign-ins may too (ADR 0059 §2, amended 2026-10-30), though a new sign-in or a token
 * refresh can sign the account's other logins out: such a login reads as signed out from its next turn on, for its
 * owner to sign in again. ChatGPT's stay one agent per account (OpenAI documents one `auth.json` per runner). Set
 * back to false, a kind refuses a new login of an account already there again; logins made meanwhile keep
 * thinking, each for its agent.
 */
export const LOGIN_PER_AGENT: Readonly<Record<"claude_code" | "codex" | "key", boolean>> = {
  claude_code: true,
  codex: false,
  key: true,
};

/** Whether an account (its CLI's kind, and a coding plan's `provider` for a key) may have one login per agent. */
export const loginPerAgent = (kind: string, provider?: string | null) =>
  isPlanId(provider) ? LOGIN_PER_AGENT.key : kind === "codex" ? LOGIN_PER_AGENT.codex : LOGIN_PER_AGENT.claude_code;

/**
 * Where each agent is its own OS user (system mode), whether a new sign-in is made once for every agent of its
 * owner on that computer (ADR 0059 §2, amended 2026-10-30, protocol 29): root keeps it and hands each turn what
 * its CLI needs. For Claude that is the token `claude setup-token` makes, which the runner then keeps: set
 * `claude_code` to false to go back to one login per agent there. ChatGPT's sign-in still thinks for one agent
 * there. Where every agent is the runner's own user, any sign-in thinks for all of them, as the computer's own
 * always has. Accounts made for all agents keep thinking when a kind is switched off, until signed in again or
 * removed.
 */
export const SHARED_SIGN_INS: Readonly<Record<"claude_code" | "key", boolean>> = {
  claude_code: true,
  key: true,
};

/** Whether a new sign-in of an account (its CLI's kind, and a coding plan's `provider`) is made for all agents. */
export const sharedSignIn = (kind: string, provider?: string | null) =>
  isPlanId(provider) ? SHARED_SIGN_INS.key : kind === "claude_code" && SHARED_SIGN_INS.claude_code;
