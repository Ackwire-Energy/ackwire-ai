import type { ApiClient, HttpApi } from "@/api/client";
import { ApiError } from "@/api/http";
import { createMockApi } from "@/api/mock";
import type { Agent, Channel, ChannelMember, Credential, Invitation, Me, Member, Message, Role } from "@/api/types";

export const NOW = new Date("2026-10-14T13:44:00.000Z");
export const ORG_ID = "00000000-0000-4000-8000-000000000001";
export const GENERAL_ID = "00000000-0000-4000-8000-0000000000c1";
export const ENG_ID = "00000000-0000-4000-8000-0000000000c2";
export const ADA_ID = "00000000-0000-4000-8000-0000000000a1";
export const ATLAS_ID = "00000000-0000-4000-8000-0000000000a2";

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

export interface FakeState {
  me: Me | null;
  members: Member[];
  agents: Agent[];
  channels: Channel[];
  channelMembers: Record<string, ChannelMember[]>;
  messages: Message[];
  invitations: Invitation[];
  credentials: Credential[];
  calls: { method: string; args: unknown[] }[];
}

/** A small in-memory backend with the data of the approved screens ("Acme"). */
export function seedState(overrides: Partial<FakeState> = {}): FakeState {
  const walter: Member = {
    userId: "u-walter",
    name: "Walter",
    email: "walter@acme.com.br",
    image: null,
    role: "owner",
    joinedAt: minutesAgo(60 * 24 * 30),
  };
  const joao: Member = {
    userId: "u-joao",
    name: "João",
    email: "joao@acme.com.br",
    image: null,
    role: "admin",
    joinedAt: minutesAgo(60 * 24 * 20),
  };
  const agent = (id: string, name: string, role: string, owner: string, budget: number | null): Agent => ({
    id,
    name,
    handle: name.toLowerCase(),
    role,
    instructions: `Instruções de ${name}.`,
    model: "claude-sonnet-5-5",
    ownerUserId: owner,
    hasCredential: true,
    monthlyBudgetUsd: budget,
    createdAt: minutesAgo(60 * 24 * 10),
  });
  return {
    me: {
      user: { id: walter.userId, name: walter.name, email: walter.email, image: null },
      organizations: [{ id: ORG_ID, name: "Acme", role: "owner" }],
    },
    members: [walter, joao],
    agents: [agent(ADA_ID, "Ada", "Dev", "u-joao", 40), agent(ATLAS_ID, "Atlas", "Ops", "u-joao", 20)],
    channels: [
      {
        id: ENG_ID,
        name: "eng",
        topic: "Código, erros e deploys",
        visibility: "public",
        isMember: true,
        createdAt: minutesAgo(9999),
      },
      { id: GENERAL_ID, name: "general", topic: "", visibility: "public", isMember: true, createdAt: minutesAgo(9999) },
    ],
    channelMembers: {
      [ENG_ID]: [
        { type: "person", id: "u-walter" },
        { type: "person", id: "u-joao" },
        { type: "agent", id: ADA_ID },
        { type: "agent", id: ATLAS_ID },
      ],
      [GENERAL_ID]: [{ type: "person", id: "u-walter" }],
    },
    messages: [
      {
        id: "m-1",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "@ada o login está devolvendo 401 desde o deploy das 9h. Consegue olhar?",
        mentionedAgentIds: [ADA_ID],
        agentRunId: null,
        createdAt: minutesAgo(62),
      },
      {
        id: "m-2",
        channelId: ENG_ID,
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
        body: "Achei a causa: o refresh compara `expires_at` em segundos com milissegundos.",
        mentionedAgentIds: [],
        agentRunId: "r-1",
        createdAt: minutesAgo(61),
      },
    ],
    invitations: [],
    credentials: [
      {
        id: "cred-1",
        provider: "anthropic",
        label: "Anthropic da Acme",
        keyHint: "7f2a",
        createdAt: minutesAgo(9999),
        revokedAt: null,
      },
    ],
    calls: [],
    ...overrides,
  };
}

let n = 0;
const id = (prefix: string) => `${prefix}-${++n}`;

/** The HTTP half of the client, over `FakeState`. Records every call in `state.calls`. */
export function createFakeHttpApi(state: FakeState): HttpApi {
  const log = (method: string, ...args: unknown[]): void => {
    state.calls.push({ method, args });
  };
  const requireMe = () => {
    if (!state.me) throw new ApiError(401, "unauthorized", "Sign in to continue");
    return state.me;
  };
  return {
    system: { health: async () => ({ status: "ok", version: "test", edition: "cloud" }) },
    account: {
      authConfig: async () => ({ socialProviders: { google: false, github: true }, signupOpen: true, firstRun: false }),
      me: async () => state.me,
    },
    orgs: {
      create: async (input) => {
        log("orgs.create", input);
        const me = requireMe();
        const orgId = id("org");
        const general = id("chan");
        me.organizations.push({ id: orgId, name: input.name, role: "owner" });
        state.channels.push({
          id: general,
          name: "general",
          topic: "",
          visibility: "public",
          isMember: true,
          createdAt: NOW.toISOString(),
        });
        return {
          organization: { id: orgId, name: input.name, role: "owner", context: input.context },
          generalChannelId: general,
        };
      },
      get: async (orgId) => ({ id: orgId, name: "Acme", role: "owner", context: "" }),
      update: async (orgId, input) => log("orgs.update", orgId, input),
      members: async () => state.members,
      changeRole: async (orgId, userId, role: Role) => {
        log("orgs.changeRole", orgId, userId, role);
        const m = state.members.find((x) => x.userId === userId);
        if (m) m.role = role;
      },
      removeMember: async (orgId, userId) => log("orgs.removeMember", orgId, userId),
      invitations: async () => state.invitations,
      invite: async (orgId, input) => {
        log("orgs.invite", orgId, input);
        if (state.members.some((m) => m.email === input.email))
          throw new ApiError(409, "conflict", `${input.email} is already a member`);
        const invitation = {
          id: id("inv"),
          email: input.email,
          role: input.role,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
        state.invitations.push(invitation);
        return { invitation, url: `http://localhost:3000/invite/tok-${invitation.id}` };
      },
      revokeInvitation: async (orgId, invitationId) => {
        log("orgs.revokeInvitation", orgId, invitationId);
        state.invitations = state.invitations.filter((i) => i.id !== invitationId);
      },
      previewInvitation: async (token) =>
        token === "valid" ? { orgName: "Acme", email: "marina@acme.com.br", role: "member" } : null,
      acceptInvitation: async (token) => {
        log("orgs.acceptInvitation", token);
        return { orgId: ORG_ID };
      },
    },
    agents: {
      list: async () => state.agents,
      create: async (orgId, input) => {
        log("agents.create", orgId, input);
        const agent: Agent = {
          id: id("agent"),
          name: input.name,
          handle: input.handle,
          role: input.role ?? "",
          instructions: input.instructions ?? "",
          model: input.model ?? "claude-sonnet-5-5",
          ownerUserId: input.ownerUserId ?? null,
          hasCredential: Boolean(input.credentialId),
          monthlyBudgetUsd: input.monthlyBudgetUsd ?? null,
          createdAt: NOW.toISOString(),
        };
        state.agents.push(agent);
        return agent;
      },
      update: async (orgId, agentId, input) => {
        log("agents.update", orgId, agentId, input);
        const agent = state.agents.find((a) => a.id === agentId);
        if (!agent) throw new ApiError(404, "not_found", "Agent not found");
        Object.assign(agent, input);
        return { ...agent };
      },
      archive: async (orgId, agentId) => log("agents.archive", orgId, agentId),
      models: async () => ({
        defaultModel: "claude-sonnet-5-5",
        models: [
          {
            id: "claude-sonnet-5-5",
            label: "Claude Sonnet 5.5",
            provider: "anthropic",
            inputUsdPerMTok: 2,
            outputUsdPerMTok: 10,
          },
          {
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            provider: "anthropic",
            inputUsdPerMTok: 4,
            outputUsdPerMTok: 20,
          },
          {
            id: "claude-haiku-5-5",
            label: "Claude Haiku 5.5",
            provider: "anthropic",
            inputUsdPerMTok: 0.1,
            outputUsdPerMTok: 0.5,
          },
        ],
      }),
      credentials: async () => state.credentials,
      addCredential: async (orgId, input) => {
        log("agents.addCredential", orgId, { ...input, apiKey: "[redacted]" });
        const cred: Credential = {
          id: id("cred"),
          provider: "anthropic",
          label: input.label,
          keyHint: input.apiKey.slice(-4),
          createdAt: NOW.toISOString(),
          revokedAt: null,
        };
        state.credentials.push(cred);
        return cred;
      },
      usage: async () =>
        state.me?.organizations[0]?.role === "member"
          ? null
          : [
              {
                agentId: ADA_ID,
                handle: "ada",
                calls: 142,
                inputTokens: 3_000_000,
                outputTokens: 100_000,
                costUsd: 12.3,
              },
              {
                agentId: ATLAS_ID,
                handle: "atlas",
                calls: 12,
                inputTokens: 200_000,
                outputTokens: 10_000,
                costUsd: 3.1,
              },
            ],
    },
    chat: {
      channels: async () => state.channels,
      createChannel: async () => {
        throw new Error("not used");
      },
      join: async (orgId, channelId) => {
        log("chat.join", orgId, channelId);
        const c = state.channels.find((x) => x.id === channelId);
        if (c) c.isMember = true;
      },
      members: async (_orgId, channelId) => state.channelMembers[channelId] ?? [],
      addMember: async (orgId, channelId, member) => {
        log("chat.addMember", orgId, channelId, member);
        const list = state.channelMembers[channelId] ?? [];
        state.channelMembers[channelId] = list;
        list.push("agentId" in member ? { type: "agent", id: member.agentId } : { type: "person", id: member.userId });
      },
      messages: async (_orgId, channelId, options = {}) => {
        const inChannel = state.messages.filter((m) => m.channelId === channelId);
        if (options.threadId) {
          const root = inChannel.find((m) => m.id === options.threadId);
          return [...(root ? [root] : []), ...inChannel.filter((m) => m.threadId === options.threadId)];
        }
        return inChannel.filter((m) => m.threadId === null);
      },
      post: async (orgId, channelId, input) => {
        log("chat.post", orgId, channelId, input);
        const message: Message = {
          id: id("msg"),
          channelId,
          threadId: input.threadId ?? null,
          author: { type: "person", id: state.me?.user.id ?? null },
          body: input.body,
          mentionedAgentIds: [],
          agentRunId: null,
          createdAt: new Date().toISOString(),
        };
        state.messages.push(message);
        return message;
      },
    },
  };
}

/** Full client: fake HTTP + the real in-memory mocks (seeded like development). */
export function createFakeApi(state: FakeState = seedState(), options: { seed?: boolean } = {}): ApiClient {
  const http = createFakeHttpApi(state);
  const mocks = createMockApi(
    {
      seed: options.seed ?? true,
      now: () => new Date(),
      lookup: {
        me: () => http.account.me(),
        agents: (orgId) => http.agents.list(orgId),
        channels: (orgId) => http.chat.channels(orgId),
        members: (orgId) => http.orgs.members(orgId),
      },
    },
    () => "http://localhost:3000",
  );
  return { ...http, ...mocks };
}
