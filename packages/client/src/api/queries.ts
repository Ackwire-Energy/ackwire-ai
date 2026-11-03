import {
  type InfiniteData,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { moveInGroups } from "../lib/agent-groups";
import { artifactRefs } from "../lib/artifacts";
import { newerSetup } from "../lib/computer";
import { CONSULT_CONVERSATION_POLL_MS, CONSULT_GROUP_POLL_MS } from "../lib/consult-group";
import { noAnswer, sendWaits } from "../lib/errors";
import { LoginReadError, loginReadPasses } from "../lib/machines";
import { GIF_PAGE, messageMediaOf, postedMedia } from "../lib/media";
import {
  allItems,
  matchesFilter,
  type NotificationPages,
  type ReplyTarget,
  removeFromPages,
  upsertInPages,
  withServerCounts,
} from "../lib/notifications";
import { recentConversations } from "../lib/recent";
import { replyOf } from "../lib/reply";
import { usagePauseRefetchMs } from "../lib/routine-view";
import { withRead } from "../lib/seen";
import { SIDEBAR_DEFAULTS, SIDEBAR_SECTIONS, withSidebarPlace } from "../lib/sidebar-items";
import { playSound } from "../lib/sounds";
import { upsertMessage, withLocalCopies } from "../lib/timeline";
import type { WikiAccess } from "../lib/wiki";
import type { RealtimeConnection } from "../realtime/connection";
import { setOrgDeletion } from "../realtime/machines";
import type { ApiClient } from "./client";
import { type AgentReactionEffect, useAgentReaction, useApi } from "./context";
import { keys } from "./keys";
import { keepSending, outbox } from "./outbox";
import type {
  AgentAction,
  AgentComputer,
  AgentDatabase,
  AgentDatabaseInput,
  AgentGroup,
  AgentInput,
  AgentMailbox,
  AgentMailboxInput,
  AgentProposalDecision,
  AgentSetup,
  AiStatus,
  ApiRule,
  AppConsentDecision,
  AppNotification,
  Approval,
  ArtifactContent,
  ArtifactDetail,
  ArtifactFilters,
  AuditPage,
  AuditQuery,
  AuditRow,
  CalendarEventInput,
  CalendarEventPatch,
  Channel,
  ChannelInput,
  ComputerSetup,
  DatabaseActionName,
  DatabaseConnectionInput,
  DeletionProofInput,
  DirectMessage,
  DmRead,
  ForumParticipantsInput,
  ForumPostInput,
  ForumSuggestedIssue,
  ForumSuggestion,
  ForumSuggestionOverrides,
  ForumTopicDetail,
  ForumTopicInput,
  GifCategory,
  GifKey,
  InviteBatch,
  IssueActivity,
  IssueActivityEvent,
  IssueColumn,
  IssueInput,
  IssuePatch,
  IssueStatus,
  JevKey,
  Machine,
  MachineAccessReduce,
  MailAccountUpdate,
  MailImapInput,
  Me,
  Message,
  MessageMemory,
  MoveAgentsInput,
  NoticeCategory,
  NoticePrefs,
  NotificationCount,
  NotificationEvent,
  NotificationFilter,
  OrgRoles,
  Person,
  PersonalTokenInput,
  Proposal,
  ReactionCount,
  ReminderInput,
  Role,
  RoleInput,
  Routine,
  RoutineHook,
  RoutineInput,
  RoutinePatch,
  S3Input,
  SandboxSettingsInput,
  SearchFilterInput,
  SearchKind,
  SeriesScope,
  SidebarItem,
  SidebarItems,
  SidebarPlace,
  SidebarSection,
  SkillInput,
  SkillPatch,
  SpeechKey,
  SpeechKeyInput,
  StartChoice,
  StatusInput,
  StorageMigration,
  ThreadAction,
  ThreadCreateInput,
  ThreadFilters,
  ThreadInfo,
  ThreadPatch,
  ToolDecision,
  WikiPage,
  WikiPageInput,
  WikiUpdateInput,
  WorkView,
} from "./types";

/**
 * React Query hooks over the `ApiClient`. Reads are cached per organization;
 * writes invalidate what they change. Mutation errors become toasts in
 * `createQueryClient` (src/app/query-client.ts).
 */

// ── Shared query options (also used by route guards) ─────────────────────────

export const meQuery = (api: ApiClient) =>
  // Kept for good: the device snapshot (`snapshot.ts`) is dropped when `me` leaves the cache.
  queryOptions({
    queryKey: keys.me,
    queryFn: () => api.account.me(),
    staleTime: 30_000,
    gcTime: Number.POSITIVE_INFINITY,
  });
export const authConfigQuery = (api: ApiClient) =>
  queryOptions({ queryKey: keys.authConfig, queryFn: () => api.account.authConfig(), staleTime: 60_000 });
export const instanceQuery = (api: ApiClient) =>
  queryOptions({ queryKey: keys.instance, queryFn: () => api.system.instance(), staleTime: 60_000 });
export const channelsQuery = (api: ApiClient, orgId: string) =>
  queryOptions({ queryKey: keys.channels(orgId), queryFn: () => api.chat.channels(orgId), staleTime: 30_000 });
/**
 * An invitation's preview (its page, and the sign-in that leads to it). One that got no answer is asked twice more:
 * the server may be restarting, and it's no expired link.
 */
export const invitationQuery = (api: ApiClient, token: string) =>
  queryOptions({
    queryKey: keys.invitation(token),
    queryFn: () => api.orgs.previewInvitation(token),
    retry: (count, error) => count < 2 && noAnswer(error),
  });
/** An email invitation that no longer opens: accepted or expired (ADR 0090). */
export const invitationStateQuery = (api: ApiClient, token: string) =>
  queryOptions({
    queryKey: keys.invitationState(token),
    queryFn: () => api.orgs.invitationState(token),
    retry: false,
  });

// ── Account ─────────────────────────────────────────────────────────────────

export const useMe = () => useQuery(meQuery(useApi()));
export const useAuthConfig = () => useQuery(authConfigQuery(useApi()));
export const useHealth = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.health, queryFn: () => api.system.health(), staleTime: 5 * 60_000 });
};

/** The usage report's switch: `null` for everyone but the installation's owner. */
export const useServerTelemetry = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.telemetry, queryFn: () => api.system.telemetry() });
};

export function useSetServerTelemetry() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.system.setTelemetry(enabled),
    onSuccess: (telemetry) => qc.setQueryData(keys.telemetry, telemetry),
  });
}

/** The installation's Jev key: `null` for everyone but its owner on a self-hosted server. */
export const useJevKey = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.jev, queryFn: () => api.system.jev() });
};

function useJevChange<T>(change: (api: ApiClient, input: T) => Promise<JevKey>, silent = false) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => change(api, input),
    onSuccess: (jev) => {
      qc.setQueryData(keys.jev, jev);
      // The key is the server's: who picks the agents may change in every workspace.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[3] === "ai-status" });
    },
    // A refused key is said under its field.
    ...(silent ? { meta: { silent: true } } : {}),
  });
}
export const useSaveJevKey = () => useJevChange((api, apiKey: string) => api.system.saveJev(apiKey), true);
export const useCheckJevKey = () => useJevChange<void>((api) => api.system.checkJev());
export const useRemoveJevKey = () => useJevChange<void>((api) => api.system.removeJev());

/** The installation's GIPHY key (ADR 0091): `null` for everyone but its owner on a self-hosted server. */
export const useGifKey = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.gifKey, queryFn: () => api.system.gifKey() });
};

function useGifKeyChange<T>(change: (api: ApiClient, input: T) => Promise<GifKey>, silent = false) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => change(api, input),
    onSuccess: (gifKey) => {
      qc.setQueryData(keys.gifKey, gifKey);
      // The key is the server's: every workspace's GIFs come and go with it (`gifsAvailable`, the picker's tab).
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "org" && (q.queryKey[2] === "settings" || q.queryKey[2] === "gifs"),
      });
    },
    // A refused key is said under its field.
    ...(silent ? { meta: { silent: true } } : {}),
  });
}
export const useSaveGifKey = () => useGifKeyChange((api, apiKey: string) => api.system.saveGifKey(apiKey), true);
export const useRemoveGifKey = () => useGifKeyChange<void>((api) => api.system.removeGifKey());

/** The installation's speech engine (ADR 0100): `null` for everyone but its owner on a self-hosted server. */
export const useSpeechKey = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.speechKey, queryFn: () => api.system.speechKey() });
};

function useSpeechKeyChange<T>(change: (api: ApiClient, input: T) => Promise<SpeechKey>, silent = false) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => change(api, input),
    onSuccess: (speechKey) => {
      qc.setQueryData(keys.speechKey, speechKey);
      // The engine is the server's: every workspace's microphone comes and goes with it (`voiceAvailable`).
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[2] === "settings" });
    },
    // A refused key is said under its field.
    ...(silent ? { meta: { silent: true } } : {}),
  });
}
export const useSaveSpeechKey = () =>
  useSpeechKeyChange((api, input: SpeechKeyInput) => api.system.saveSpeechKey(input), true);
export const useRemoveSpeechKey = () => useSpeechKeyChange<void>((api) => api.system.removeSpeechKey());

/**
 * The server's Web Push key (ADR 0071): `null` when this server has Web Push off. Asked only where this
 * browser could take pushes (`enabled`); the key changes only when the server's does.
 */
export const useWebPushKey = (enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.webPushKey, queryFn: () => api.push.webKey(), enabled, staleTime: 60 * 60_000 });
};

export function useCreateOrganization() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; context?: string }) => api.orgs.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

/** How often a workspace's closing screen asks `GET /me` again: its socket is closed, so no event reaches it. */
export const CLOSING_POLL_MS = 30_000;

/**
 * `GET /me` while a workspace's closing screen shows: every 30 s and whenever the app comes back to the front, so a
 * restore opens the workspace again and a deletion done drops it from the list.
 */
export const useClosingMe = () =>
  useQuery({ ...meQuery(useApi()), refetchInterval: CLOSING_POLL_MS, refetchOnWindowFocus: "always" });

/** What deleting my account would do (`GET /account/deletion`): asked anew each time. */
export const useAccountDeletionPlan = (enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.accountDeletion,
    queryFn: () => api.account.deletionPlan(),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
};

/**
 * Deletes the workspace (owners), with the proof that it's them (the emailed code, or the password). Its closing
 * screen shows here at once, and through `org.deleting` everywhere else. The dialog says its refusals.
 */
export function useDeleteWorkspace(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proof: DeletionProofInput) => api.orgs.deleteWorkspace(orgId, proof),
    meta: { silent: true },
    onSuccess: ({ dueAt }) => {
      const me = qc.getQueryData<Me | null>(keys.me);
      setOrgDeletion(qc, orgId, {
        dueAt,
        requestedAt: new Date().toISOString(),
        requestedBy: me ? { id: me.user.id, name: me.user.name } : null,
      });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

/** Restores a workspace being deleted (owners): it opens again for everyone. */
export function useRestoreWorkspace(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.orgs.restore(orgId),
    onSuccess: () => {
      setOrgDeletion(qc, orgId, null);
      // An unfinished one resumes its onboarding: `GET /me` says so again.
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useUpdateOrganization(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; context?: string }) => api.orgs.update(orgId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.org(orgId) });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

// ── Organization ────────────────────────────────────────────────────────────

export const useOrganization = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: [...keys.org(orgId), "detail"], queryFn: () => api.orgs.get(orgId) });
};

export const useMembers = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.members(orgId), queryFn: () => api.orgs.members(orgId), staleTime: 30_000 });
};

export function useChangeRole(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.orgs.changeRole(orgId, userId, role),
    onSettled: () => refreshRoles(qc, orgId),
  });
}

/** Roles changed: the roles, the people (their roles) and `me` (what you may do now) are read again. */
export const refreshRoles = (qc: QueryClient, orgId: string) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: keys.roles(orgId) }),
    qc.invalidateQueries({ queryKey: keys.people(orgId) }),
    qc.invalidateQueries({ queryKey: keys.members(orgId) }),
    qc.invalidateQueries({ queryKey: keys.me }),
  ]);

/** The workspace's roles, top first, and the permission areas (ADR 0085). */
export const useRoles = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.roles(orgId), queryFn: () => api.roles.list(orgId), staleTime: 30_000 });
};

export function useCreateRole(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RoleInput) => api.roles.create(orgId, input),
    onSettled: () => refreshRoles(qc, orgId),
  });
}

/** Changes a role at once on screen (the toggles save by themselves), then reads the truth back. */
export function useUpdateRole(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ roleId, patch }: { roleId: string; patch: Partial<RoleInput> }) =>
      api.roles.update(orgId, roleId, patch),
    onMutate: async ({ roleId, patch }) => {
      await qc.cancelQueries({ queryKey: keys.roles(orgId) });
      const before = qc.getQueryData<OrgRoles>(keys.roles(orgId));
      if (before)
        qc.setQueryData<OrgRoles>(keys.roles(orgId), {
          ...before,
          roles: before.roles.map((r) => (r.id === roleId ? { ...r, ...patch } : r)),
        });
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.roles(orgId), ctx.before);
    },
    onSettled: () => refreshRoles(qc, orgId),
  });
}

export function useDeleteRole(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) => api.roles.remove(orgId, roleId),
    onSettled: () => refreshRoles(qc, orgId),
  });
}

export function useReorderRoles(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.roles.reorder(orgId, ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: keys.roles(orgId) });
      const before = qc.getQueryData<OrgRoles>(keys.roles(orgId));
      if (before) {
        const at = new Map(ids.map((id, i) => [id, i]));
        qc.setQueryData<OrgRoles>(keys.roles(orgId), {
          ...before,
          roles: [...before.roles]
            .map((r) => (at.has(r.id) ? { ...r, position: at.get(r.id) ?? r.position } : r))
            .sort(
              (a, b) => (a.kind === "everyone" ? 1 : 0) - (b.kind === "everyone" ? 1 : 0) || a.position - b.position,
            ),
        });
      }
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.roles(orgId), ctx.before);
    },
    onSettled: () => refreshRoles(qc, orgId),
  });
}

/** Sets a person's roles (exactly these). */
export function useSetMemberRoles(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, roleIds }: { userId: string; roleIds: string[] }) =>
      api.roles.setFor(orgId, userId, roleIds),
    onMutate: async ({ userId, roleIds }) => {
      await qc.cancelQueries({ queryKey: keys.people(orgId) });
      const before = qc.getQueryData<Person[]>(keys.people(orgId));
      if (before)
        qc.setQueryData<Person[]>(
          keys.people(orgId),
          before.map((p) => (p.userId === userId ? { ...p, roleIds } : p)),
        );
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.people(orgId), ctx.before);
    },
    onSettled: () => refreshRoles(qc, orgId),
  });
}

/** What removing this person (or leaving) does, while the confirmation is open. */
export const useRemovalPreview = (orgId: string, userId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: ["org", orgId, "removal", userId],
    queryFn: () => api.orgs.removal(orgId, userId ?? ""),
    enabled: userId !== null,
    staleTime: 0,
  });
};

/** Removes a member, or leaves: the row goes at once; their agents' new owner and the counts follow. */
export function useRemoveMember(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.orgs.removeMember(orgId, userId),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: keys.people(orgId) });
      const before = qc.getQueryData<Person[]>(keys.people(orgId));
      if (before)
        qc.setQueryData<Person[]>(
          keys.people(orgId),
          before.filter((p) => p.userId !== userId),
        );
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.people(orgId), ctx.before);
    },
    onSettled: () => {
      for (const key of [keys.people(orgId), keys.members(orgId), keys.overview(orgId), keys.agents(orgId), keys.me])
        void qc.invalidateQueries({ queryKey: key });
    },
  });
}

export const useInvitations = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.invitations(orgId), queryFn: () => api.orgs.invitations(orgId), enabled });
};

export function useInvite(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role?: Role; roleIds?: string[] }) => api.orgs.invite(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

export function useRevokeInvitation(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.orgs.revokeInvitation(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

// ── Agents ──────────────────────────────────────────────────────────────────

export const useAgents = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.agents(orgId), queryFn: () => api.agents.list(orgId), staleTime: 30_000 });
};

/** Agents no longer in the team: the directories name their old messages with these (fresh with `useAgents`). */
export const useFormerAgents = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.formerAgents(orgId), queryFn: () => api.agents.former(orgId), staleTime: 30_000 });
};

/** The team screen: refetched every 30 s and on focus, so new consultations show up. */
export const useTeam = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.team(orgId),
    queryFn: () => api.agents.team(orgId),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
};

export const useModels = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.models, queryFn: () => api.agents.models(), staleTime: 10 * 60_000 });
};

/** A catalog model's name ("Claude Haiku 5.5") once the list is in: its id for one the list doesn't have, null before. */
export function useModelLabel() {
  const models = useModels();
  return (id: string) => (models.data ? (models.data.models.find((m) => m.id === id)?.label ?? id) : null);
}

export const useCredentials = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.credentials(orgId), queryFn: () => api.agents.credentials(orgId), enabled });
};

/** `data` is null when the person can't see usage (members). */
export const useUsage = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.usage(orgId), queryFn: () => api.agents.usage(orgId), staleTime: 30_000 });
};

export function useCreateAgent(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AgentInput) => api.agents.create(orgId, input),
    onSuccess: (_agent, input) => {
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      // Made from a card: the card says so (its conversation gets the change live too).
      if (input.proposal) void qc.invalidateQueries({ queryKey: keys.agentProposal(orgId, input.proposal) });
    },
  });
}

/** An agent's proposal of a new agent (ADR 0081), by its card's message; `null` id: none. */
export function useAgentProposal(orgId: string, messageId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentProposal(orgId, messageId ?? ""),
    queryFn: () => api.agents.proposal(orgId, messageId ?? ""),
    enabled: Boolean(messageId),
  });
}

/**
 * "Criar" on an agent's proposal: the agent as proposed, in one click. The card shows it at once, with what it got;
 * the agents, channels and routines lists take it in.
 */
export function useCreateProposedAgent(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.agents.createProposed(orgId, messageId),
    onSuccess: ({ proposal }) => {
      cacheAgentProposal(qc, orgId, proposal, proposal);
      for (const key of [keys.agents(orgId), keys.channels(orgId), keys.routines(orgId)])
        void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** The routine a proposal came with, once its agent is where it reports (the card's "Criar a rotina"). */
export function useCreateProposedRoutine(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.agents.proposalRoutine(orgId, messageId),
    onSuccess: (proposal) => {
      cacheAgentProposal(qc, orgId, proposal, proposal);
      void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
    },
  });
}

/** "Recusar" on an agent's proposal: the card shows it at once. */
export function useDenyAgentProposal(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.agents.denyProposal(orgId, messageId),
    onSuccess: (proposal) => cacheAgentProposal(qc, orgId, proposal, proposal),
  });
}

export function useUpdateAgent(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<AgentInput>) => api.agents.update(orgId, agentId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, agentId) });
      void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      void qc.invalidateQueries({ queryKey: keys.usageReport(orgId) });
    },
  });
}

export function useAddCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<ApiClient["agents"]["addCredential"]>[1]) => api.agents.addCredential(orgId, input),
    onSuccess: () => {
      // An OpenRouter key brings its models into the pickers.
      void qc.invalidateQueries({ queryKey: keys.models });
      return qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
    },
  });
}

// ── Agent groups (ADR 0083) ─────────────────────────────────────────────────

export const useAgentGroups = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.agentGroups(orgId), queryFn: () => api.agentGroups.list(orgId), staleTime: 30_000 });
};

export type AgentGroupAction =
  | { type: "create"; name: string; agentIds?: string[] }
  | { type: "update"; groupId: string; name?: string; index?: number }
  | { type: "remove"; groupId: string }
  | { type: "move"; agentId: string; groupId: string | null; index?: number };

/** Every change answers with all the groups. A move shows at once, and goes back if the server refuses it. */
export function useAgentGroupAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const key = keys.agentGroups(orgId);
  return useMutation({
    mutationFn: (action: AgentGroupAction): Promise<AgentGroup[]> => {
      switch (action.type) {
        case "create":
          return api.agentGroups.create(orgId, { name: action.name, agentIds: action.agentIds });
        case "update":
          return api.agentGroups.update(orgId, action.groupId, { name: action.name, index: action.index });
        case "remove":
          return api.agentGroups.remove(orgId, action.groupId);
        case "move":
          return api.agentGroups.move(orgId, action.agentId, { groupId: action.groupId, index: action.index });
      }
    },
    onMutate: async (action) => {
      if (action.type !== "move") return undefined;
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<AgentGroup[]>(key);
      if (before) qc.setQueryData(key, moveInGroups(before, action.agentId, action.groupId, action.index));
      return { before };
    },
    onError: (_error, _action, context) => {
      if (context?.before) qc.setQueryData(key, context.before);
    },
    onSuccess: (groups) => qc.setQueryData(key, groups),
  });
}

// ── Chat ────────────────────────────────────────────────────────────────────

export const useChannels = (orgId: string) => useQuery(channelsQuery(useApi(), orgId));

/** The sidebar's channel categories, in order (ADR 0080). */
export const channelCategoriesQuery = (api: ApiClient, orgId: string) =>
  queryOptions({
    queryKey: keys.channelCategories(orgId),
    queryFn: () => api.chat.categories(orgId),
    staleTime: 30_000,
  });
export const useChannelCategories = (orgId: string) => useQuery(channelCategoriesQuery(useApi(), orgId));

/** After any layout change: the channels (their category and order) and the categories refetch. */
function refreshLayout(qc: QueryClient, orgId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.channels(orgId) }),
    qc.invalidateQueries({ queryKey: keys.channelCategories(orgId) }),
  ]);
}

/** Admins: a new category at the end, optionally taking channels along. */
export function useCreateChannelCategory(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; channelIds?: string[] }) => api.chat.createCategory(orgId, input),
    onSuccess: () => refreshLayout(qc, orgId),
  });
}

export function useRenameChannelCategory(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { categoryId: string; name: string }) =>
      api.chat.renameCategory(orgId, input.categoryId, input.name),
    onSuccess: () => refreshLayout(qc, orgId),
  });
}

export function useDeleteChannelCategory(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => api.chat.deleteCategory(orgId, categoryId),
    onSuccess: () => refreshLayout(qc, orgId),
  });
}

export function usePlaceChannelCategory(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { categoryId: string; beforeCategoryId: string | null }) =>
      api.chat.placeCategory(orgId, input.categoryId, input.beforeCategoryId),
    onSuccess: () => refreshLayout(qc, orgId),
  });
}

/**
 * Puts a channel in a category (null: none), before another channel or at its end. The list moves at once
 * (the channel takes its new category) and refetches for the exact order.
 */
export function usePlaceChannel(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { channelId: string; categoryId: string | null; beforeChannelId?: string | null }) =>
      api.chat.place(orgId, input.channelId, { categoryId: input.categoryId, beforeChannelId: input.beforeChannelId }),
    onMutate: (input) => {
      qc.setQueryData<Channel[]>(keys.channels(orgId), (list) =>
        list?.map((c) => (c.id === input.channelId ? { ...c, categoryId: input.categoryId } : c)),
      );
    },
    onSettled: () => refreshLayout(qc, orgId),
  });
}

export const channelMembersQuery = (api: ApiClient, orgId: string, channelId: string) =>
  queryOptions({
    queryKey: keys.channelMembers(orgId, channelId),
    queryFn: () => api.chat.members(orgId, channelId),
    staleTime: 30_000,
  });

export const useChannelMembers = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ ...channelMembersQuery(api, orgId, channelId), enabled });
};

/** Messages per page: the latest page, then older pages on scroll-up. */
export const MESSAGES_PAGE = 100;
/** A thread's root and replies, in one read. */
export const THREAD_PAGE = 200;

/**
 * The latest page of a conversation. Cached per channel and fresh for 30 s
 * (real-time events keep it current, and what they missed before the
 * channel's subscription was confirmed is added then), so switching back is
 * instant; then it revalidates in the background. Kept 30 min after leaving
 * it, so going back later still shows it at once. A read (a reconnect's
 * included) keeps my messages still sending or waiting for the connection.
 */
export const messagesQuery = (api: ApiClient, orgId: string, channelId: string) =>
  queryOptions({
    queryKey: keys.messages(orgId, channelId),
    queryFn: async ({ client, queryKey }) =>
      withLocalCopies(
        await api.chat.messages(orgId, channelId, { limit: MESSAGES_PAGE }),
        client.getQueryData<Message[]>(queryKey),
        outbox.has,
      ),
    staleTime: 30_000,
    gcTime: 30 * 60_000,
  });

export const useMessages = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ ...messagesQuery(api, orgId, channelId), enabled });
};

/** Sidebar hover/focus: load a conversation before the click. */
export function usePrefetchMessages(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useCallback(
    (channelId: string) => {
      void qc.prefetchQuery(messagesQuery(api, orgId, channelId));
    },
    [api, qc, orgId],
  );
}

/** Conversations loaded when the workspace opens (no hover on a phone, nor before the first click). */
export const RECENT_PREFETCH = 5;

/**
 * Once the lists arrive, loads the unread and most recent conversations while
 * the app is idle, once per organization: opening them is then instant.
 */
export function usePrefetchRecent(orgId: string, count = RECENT_PREFETCH) {
  const api = useApi();
  const qc = useQueryClient();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const ready = Boolean(channels.data && dms.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the lists are in; later updates don't run it again
  useEffect(() => {
    if (!ready) return;
    const ids = recentConversations(channels.data ?? [], dms.data ?? [], count);
    const run = () => {
      for (const id of ids) void qc.prefetchQuery(messagesQuery(api, orgId, id));
    };
    const idle = globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idle.requestIdleCallback) {
      const handle = idle.requestIdleCallback(run, { timeout: 2_000 });
      return () => idle.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(run, 300);
    return () => clearTimeout(timer);
  }, [ready, orgId, count, api, qc]);
}

/** A `#channel` link's card, when it opens (or when the link names a channel the list doesn't have). */
export const useChannelCard = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.channelCard(orgId, channelId),
    queryFn: () => api.chat.card(orgId, channelId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
};

export function useJoinChannel(orgId: string, channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.chat.join(orgId, channelId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
    },
  });
}

export function useAddChannelMember(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, member }: { channelId: string; member: { userId: string } | { agentId: string } }) =>
      api.chat.addMember(orgId, channelId, member),
    onSuccess: (_v, { channelId }) => qc.invalidateQueries({ queryKey: keys.channelMembers(orgId, channelId) }),
  });
}

/**
 * Puts a message in the right cache: the channel list, or its thread.
 * Replaces the optimistic copy (same `clientId`), which always waits in the
 * channel list (a thread may not be loaded yet): a reply's copy is removed
 * from there too, or it would stay "sending…" next to the real one.
 */
export function cacheMessage(qc: ReturnType<typeof useQueryClient>, orgId: string, message: Message) {
  const channelKey = keys.messages(orgId, message.channelId);
  const key = message.threadId ? keys.thread(orgId, message.channelId, message.threadId) : channelKey;
  const withoutLocal = (list: Message[] | undefined) =>
    message.clientId ? list?.filter((m) => !(m.local && m.clientId === message.clientId)) : list;
  if (message.threadId && message.clientId) qc.setQueryData<Message[]>(channelKey, withoutLocal);
  qc.setQueryData<Message[]>(key, (list) => upsertMessage(withoutLocal(list), message));
}

/**
 * Início's "Peça a um agente" (ADR 0108): the DM with the agent (made if new), the message sent there and kept in its
 * cache, so the conversation opens with it and the agent at work.
 */
export function useAskAgent(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, body }: { agentId: string; body: string }) => {
      const { channelId } = await api.dms.open(orgId, { agentId });
      return api.chat.post(orgId, channelId, { body, clientId: newClientId() });
    },
    onSuccess: (message) => {
      cacheMessage(qc, orgId, message);
      void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
    },
  });
}

const isMessageList = (key: readonly unknown[]) => key[4] === "messages" || key[4] === "thread";

/**
 * Reads a channel's open lists again once its events reach us (`subscribed`: what happened there before was
 * never sent to us) and adds what they lack, taking nothing away: a message heard live while this read was on
 * its way stays. A read already on its way lands first, so it can't put an older list back over what this one
 * adds. Returns what it read.
 */
export async function catchUpChannel(
  api: ApiClient,
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
): Promise<Message[]> {
  const prefix = ["org", orgId, "channel", channelId];
  await qc.refetchQueries({ queryKey: prefix, fetchStatus: "fetching" }, { cancelRefetch: false });
  const reads = qc
    .getQueryCache()
    .findAll({ queryKey: prefix, type: "active" })
    .flatMap(({ queryKey: [, , , , list, rootId] }) =>
      list === "messages"
        ? [api.chat.messages(orgId, channelId, { limit: MESSAGES_PAGE })]
        : list === "thread" && typeof rootId === "string"
          ? [api.chat.messages(orgId, channelId, { threadId: rootId, limit: THREAD_PAGE })]
          : [],
    );
  const read = (await Promise.all(reads).catch(() => [])).flat();
  const known = new Set(
    qc
      .getQueriesData<Message[]>({ queryKey: prefix, predicate: (q) => isMessageList(q.queryKey) })
      .flatMap(([, data]) => (Array.isArray(data) ? data.map((m) => m.id) : [])),
  );
  for (const m of read) if (!known.has(m.id)) cacheMessage(qc, orgId, m);
  return read;
}

/** A read's receipts on the copies of its messages the channel's lists hold (nothing else of them changes). */
export function cacheReceipts(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  read: Message[],
) {
  const receipts = new Map(read.flatMap((m) => (m.receipts ? [[m.id, m.receipts] as const] : [])));
  qc.setQueriesData<Message[]>(
    { queryKey: ["org", orgId, "channel", channelId], predicate: (q) => isMessageList(q.queryKey) },
    (list) =>
      list?.some((m) => receipts.has(m.id) && m.receipts !== receipts.get(m.id))
        ? list.map((m) => {
            const r = receipts.get(m.id);
            return r && m.receipts !== r ? { ...m, receipts: r } : m;
          })
        : list,
  );
}

/**
 * A card's meta changed (`patch` gives the keys that change, from the meta it has): that message in every loaded
 * list of its channel.
 */
export function cacheMessageMeta(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  messageId: string,
  patch: (meta: Record<string, unknown>) => Record<string, unknown>,
) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, meta: { ...(m.meta ?? {}), ...patch(m.meta ?? {}) } } : m));
  });
}

/**
 * A forum suggestion card changed (accepted, dismissed, or my own "Agora não"):
 * the message's `meta.forumSuggestion` in every loaded list of that channel.
 */
export function cacheForumSuggestion(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  messageId: string,
  suggestion: ForumSuggestion,
) {
  cacheMessageMeta(qc, orgId, channelId, messageId, () => ({ forumSuggestion: suggestion }));
}

/**
 * An agent's proposal of a new agent was decided (ADR 0081): the decision on its card in the chat, which already
 * holds the draft, and its own query again.
 */
export function cacheAgentProposal(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  where: { channelId: string; messageId: string },
  { state, agentId, decidedByUserId, decidedAt, applied, routineId }: AgentProposalDecision,
) {
  cacheMessageMeta(qc, orgId, where.channelId, where.messageId, (meta) => ({
    actionCard: {
      ...(meta.actionCard as Record<string, unknown> | undefined),
      state,
      agentId,
      decidedByUserId,
      decidedAt,
      ...(applied ? { applied } : {}),
      ...(routineId ? { routineId } : {}),
    },
  }));
  void qc.invalidateQueries({ queryKey: keys.agentProposal(orgId, where.messageId) });
}

/** A new message's `clientId`: sent again with the same one (its answer was lost), it's written only once. */
export const newClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * What `chat.post` gets for a message of mine: the quoted message, the files by id and a GIF or a sticker by what
 * names it (ADR 0091), from which the server builds the real meta (it checks them).
 */
function postBody({ body, clientId, threadId, meta, steer }: PostInput) {
  const replyTo = replyOf(meta)?.messageId;
  const attachments = artifactRefs(meta).map((r) => r.id);
  const media = messageMediaOf(meta);
  return {
    body,
    clientId,
    ...(threadId ? { threadId } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(threadId && meta?.[OPEN_THREAD] === true ? { openThread: true } : {}),
    ...(steer ? { steer } : {}),
    ...(media ? { media: postedMedia(media) } : {}),
  };
}

/** The server's copy of a message I sent, in place of its local one. */
function cacheSent(qc: QueryClient, orgId: string, message: Message, { clientId, threadId, meta }: PostInput) {
  // Written in the thread panel: it stays out of the channel while the thread list catches up
  // (the realtime event may come later, or not at all).
  const opened = Boolean(threadId) && meta?.[OPEN_THREAD] === true;
  const echoed = {
    ...message,
    clientId: message.clientId ?? clientId,
    ...(opened ? { meta: { ...message.meta, [OPEN_THREAD]: true } } : {}),
  };
  cacheMessage(qc, orgId, echoed);
  if (opened) {
    void qc.invalidateQueries({ queryKey: keys.threads(orgId), predicate: (q) => q.queryKey[3] !== "one" });
  }
  return echoed;
}

/**
 * Sends a message optimistically: it appears at once (`local: "pending"`),
 * is replaced by the server's copy (matched by `clientId`, from the response
 * or the WebSocket, whichever comes first), or turns `failed` with a retry.
 * One with no answer from the server waits in the `outbox` instead.
 */
export function usePostMessage(
  orgId: string,
  channelId: string,
  options: {
    me: { id: string };
    /** Agents the text mentions (client-side guess, for the instant "pensando…" row). */
    mentioned?: (body: string) => string[];
    onSent?: (message: Message, local: Message) => void;
    onOptimistic?: (local: Message) => void;
    /**
     * The server refused it, or no answer came (the message turns "failed" either way: with a retry, or waiting in
     * the `outbox` when `waits`). `clientId` is the failed message's (its optimistic copy's).
     */
    onFailed?: (error: unknown, failed: { clientId: string; waits: boolean }) => void;
  },
) {
  const api = useApi();
  const qc = useQueryClient();
  const key = keys.messages(orgId, channelId);
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: PostInput) => api.chat.post(orgId, channelId, postBody(input)),
    onMutate: ({ body, clientId, threadId, meta }) => {
      const local: Message = {
        id: `local-${clientId}`,
        channelId,
        threadId: threadId ?? null,
        author: { type: "person", id: options.me.id },
        body,
        mentionedAgentIds: options.mentioned?.(body) ?? [],
        agentRunId: null,
        meta: meta ?? {},
        clientId,
        local: "pending",
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<Message[]>(key, (list) =>
        upsertMessage(
          list?.filter((m) => m.id !== local.id),
          local,
        ),
      );
      options.onOptimistic?.(local);
      playSound("send");
      return { local };
    },
    onSuccess: (message, input, ctx) => {
      outbox.remove(input.clientId);
      const echoed = cacheSent(qc, orgId, message, input);
      if (ctx?.local) options.onSent?.(echoed, ctx.local);
    },
    onError: (error, { clientId }, ctx) => {
      // No answer from the server (no internet, or it is restarting): it waits, and goes out again from whatever
      // screen is open once the connection is back (`useSendWaiting`).
      const waits = sendWaits(error);
      if (waits && ctx?.local) outbox.add(orgId, ctx.local);
      options.onFailed?.(error, { clientId, waits });
      qc.setQueryData<Message[]>(key, (list) =>
        list?.map((m) => (m.local && m.clientId === clientId ? { ...m, local: "failed" as const } : m)),
      );
    },
  });
}

/** Local copies of recordings on their way, to play before the server has them: `clientId` → object URL. */
const voiceLocal = new Map<string, string>();
export const voiceLocalUrl = (clientId: string | null | undefined) => (clientId ? voiceLocal.get(clientId) : undefined);

/** Client-only key on a recording's optimistic meta: it waits for a connection. */
export const VOICE_WAITING = "voiceWaiting";

const VOICE_RETRY_MS = [3_000, 10_000, 30_000];

/** Until the connection seems back, or a little while. */
function voiceRetryWait(attempt: number) {
  const ms = VOICE_RETRY_MS[Math.min(attempt, VOICE_RETRY_MS.length - 1)] ?? 30_000;
  return new Promise<void>((done) => {
    const finish = () => {
      clearTimeout(timer);
      globalThis.removeEventListener?.("online", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    globalThis.addEventListener?.("online", finish);
  });
}

/** A recording that won't become a message: its bubble goes, and its local copy with it. */
export function dropLocalVoice(qc: QueryClient, orgId: string, channelId: string, clientId: string) {
  const url = voiceLocal.get(clientId);
  if (url) URL.revokeObjectURL(url);
  voiceLocal.delete(clientId);
  const without = (list: Message[] | undefined) => list?.filter((m) => !(m.local && m.clientId === clientId));
  qc.setQueryData<Message[]>(keys.messages(orgId, channelId), without);
}

/**
 * Sends a recording (ADR 0100): its bubble appears at once and stays until the server's message replaces it (same
 * `clientId`). Without a connection the recording waits in memory and goes when it comes back, with the same
 * `clientId`, so a send whose answer was lost is stored once. `onRefused`: the server said no, and the bubble went.
 */
export function useSendVoice(
  orgId: string,
  channelId: string,
  options: { me: { id: string }; onRefused?: (error: unknown) => void },
) {
  const api = useApi();
  const qc = useQueryClient();
  const key = keys.messages(orgId, channelId);
  const latest = useRef(options);
  latest.current = options;
  return useCallback(
    async (input: {
      blob: Blob;
      durationMs: number;
      peaks: number[];
      threadId: string | null;
      replyTo: string | null;
      language: string | null;
      meta?: Record<string, unknown>;
    }) => {
      const { blob, durationMs, peaks, threadId, replyTo, language, meta } = input;
      const clientId = newClientId();
      voiceLocal.set(clientId, URL.createObjectURL(blob));
      const local: Message = {
        id: `local-${clientId}`,
        channelId,
        threadId,
        author: { type: "person", id: latest.current.me.id },
        body: "",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: { ...meta, voice: { clipId: "", durationMs, peaks } },
        clientId,
        local: "pending",
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<Message[]>(key, (list) => upsertMessage(list, local));
      playSound("send");
      const waiting = (on: boolean) =>
        qc.setQueryData<Message[]>(key, (list) =>
          list?.map((m) =>
            m.local && m.clientId === clientId ? { ...m, meta: { ...m.meta, [VOICE_WAITING]: on } } : m,
          ),
        );
      for (let attempt = 0; ; attempt++) {
        try {
          await api.voice.send(orgId, channelId, { blob, durationMs, peaks, clientId, threadId, replyTo, language });
          waiting(false);
          return;
        } catch (error) {
          if (!sendWaits(error)) {
            dropLocalVoice(qc, orgId, channelId, clientId);
            latest.current.onRefused?.(error);
            return;
          }
          waiting(true);
          await voiceRetryWait(attempt);
        }
      }
    },
    [api, qc, key, orgId, channelId],
  );
}

/**
 * Client-only key on a reply's optimistic meta: written in the thread panel ("Responder"), so the
 * server marks the thread `openedByReplyAt` (a retry sends it again).
 */
export const OPEN_THREAD = "openThread";

/**
 * A message to post. `meta` is the optimistic copy's (`replyTo`, `artifacts`, `media`): only the quoted
 * message id, the file ids and what names a GIF or a sticker go to the server, which writes the real meta.
 */
interface PostInput {
  body: string;
  clientId: string;
  threadId?: string | null;
  meta?: Record<string, unknown>;
  /** "Parar e mandar": an agent working here stops its current step and reads it now. */
  steer?: "now";
}

/** How a message goes out while an agent works: joins its task (default) or stops it to read now. */
export interface SendOptions {
  steer?: "now";
}

/**
 * `send(body)` for a new message; `retry(local)` for one that failed (same quote and files).
 * `send(body, threadId, { steer: "now" })` ("Parar e mandar"): `steer` may come in the third
 * argument (it never reaches the optimistic copy's meta) or in `options`. A retry joins the task.
 */
export function sendHelpers(mutation: ReturnType<typeof usePostMessage>) {
  return {
    send: (body: string, threadId?: string | null, meta?: Record<string, unknown>, options: SendOptions = {}) => {
      const given: Record<string, unknown> = meta ?? {};
      const { steer: inMeta, ...rest } = given;
      const steer = options.steer ?? (inMeta === "now" ? "now" : undefined);
      mutation.mutate({
        body,
        clientId: newClientId(),
        threadId,
        meta: meta ? rest : undefined,
        ...(steer ? { steer } : {}),
      });
    },
    retry: (local: Message) =>
      mutation.mutate({
        body: local.body,
        clientId: local.clientId ?? newClientId(),
        threadId: local.threadId,
        meta: local.meta,
      }),
  };
}

const flushing = new Map<string, Promise<boolean>>();

/**
 * Sends my messages that wait in the organization (`outbox`), whatever screen is open: in the order they were
 * written, and one run at a time, so none goes out twice at once. The server's copy takes the waiting one's place.
 * While the server still doesn't answer, the rest keeps waiting. One it refuses leaves the outbox and turns
 * "Não enviada" (`onRefused`). True while something still waits.
 */
export function flushOutbox(
  api: ApiClient,
  qc: QueryClient,
  orgId: string,
  onRefused?: (error: unknown) => void,
): Promise<boolean> {
  const running = flushing.get(orgId);
  if (running) return running;
  const run = (async () => {
    const me = qc.getQueryData<Me | null>(keys.me)?.user.id;
    for (const local of outbox.of(orgId)) {
      if (!me) return true;
      const clientId = local.clientId ?? "";
      // Someone else's, from before a sign-in on this device: never sent as me.
      if (local.author.id !== me) {
        outbox.remove(clientId);
        continue;
      }
      const input: PostInput = { body: local.body, clientId, threadId: local.threadId, meta: local.meta };
      try {
        const message = await api.chat.post(orgId, local.channelId, postBody(input));
        outbox.remove(clientId);
        // A conversation the cache let go meanwhile reads it from the server when it opens.
        if (qc.getQueryData(keys.messages(orgId, local.channelId))) cacheSent(qc, orgId, message, input);
      } catch (error) {
        if (sendWaits(error)) return true;
        outbox.remove(clientId);
        onRefused?.(error);
      }
    }
    return false;
  })().finally(() => flushing.delete(orgId));
  flushing.set(orgId, run);
  return run;
}

/**
 * What I sent while the connection was down goes out when it's back, whatever screen is open (`flushOutbox`), and
 * again every `OUTBOX_RETRY_MS` while the socket stays open and it still waits. `onRefused`: the server refused one.
 */
export function useSendWaiting(
  orgId: string,
  connection: RealtimeConnection | null,
  onRefused: (error: unknown) => void,
) {
  const api = useApi();
  const qc = useQueryClient();
  const refused = useRef(onRefused);
  refused.current = onRefused;
  useEffect(() => {
    if (!connection) return;
    return keepSending(connection, () => flushOutbox(api, qc, orgId, (error) => refused.current(error)));
  }, [api, qc, orgId, connection]);
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** Every approval you can see (pending and decided); `canDecide` says if you may act. */
export const useApprovals = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals(orgId), queryFn: () => api.approvals.list(orgId), staleTime: 15_000 });
};

/** One approval (inline card when it isn't in the list yet). */
export const useApproval = (orgId: string, approvalId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.approval(orgId, approvalId),
    queryFn: () => api.approvals.get(orgId, approvalId),
    enabled,
  });
};

/**
 * The requests on one approval card, by its message: for a card older than the org's list reaches. Under the
 * list's key, so whatever refreshes the list refreshes it.
 */
export const useCardApprovals = (orgId: string, messageId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.approvals(orgId), "card", messageId],
    queryFn: () => api.approvals.list(orgId, { messageId }),
    enabled,
  });
};

/** Puts a fresh approval in the caches (decision responses, WebSocket events). */
export function cacheApproval(qc: ReturnType<typeof useQueryClient>, orgId: string, approval: Approval) {
  qc.setQueryData<Approval[]>(keys.approvals(orgId), (list) => {
    if (!list) return list;
    const previous = list.find((a) => a.id === approval.id);
    const merged = keepOwnRights(previous, approval);
    return previous ? list.map((a) => (a.id === approval.id ? merged : a)) : [merged, ...list];
  });
  qc.setQueryData<Approval>(keys.approval(orgId, approval.id), (prev) => keepOwnRights(prev, approval));
  // One prepared ahead is also on its routine's page (approved, ran, withdrawn).
  if (approval.routineId) void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
}

/**
 * Channel events don't know who is asking: our own `canDecide` stays until it's decided, and our own `canCancel`
 * while an action approved ahead may still run.
 */
function keepOwnRights(previous: Approval | undefined, approval: Approval): Approval {
  if (!previous) return approval;
  if (approval.status === "pending") return { ...approval, canDecide: previous.canDecide };
  if (approval.status === "approved" && approval.runAt && !approval.executedAt) {
    return { ...approval, canCancel: approval.canCancel || previous.canCancel };
  }
  return approval;
}

/** `always` ("Aprovar sempre"): approves this one and the agent's next calls of its kind. */
export function useDecideApproval(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      reason,
      always,
    }: {
      id: string;
      decision: "approve" | "refuse";
      reason?: string;
      always?: boolean;
    }) =>
      decision === "approve"
        ? api.approvals.approve(orgId, id, reason, always)
        : api.approvals.refuse(orgId, id, reason),
    onSuccess: (approval, { decision, always }) => {
      playSound(decision === "approve" ? "approved" : "error");
      cacheApproval(qc, orgId, approval);
      void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
      if (always) void qc.invalidateQueries({ queryKey: keys.approvalRules(orgId, approval.agentId) });
    },
  });
}

/** Withdraws an action approved ahead before its time (its routine's page, its card). */
export function useCancelApproval(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approvals.cancel(orgId, id),
    onSuccess: (approval) => {
      cacheApproval(qc, orgId, approval);
      void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
    },
  });
}

/** A card's "Aprovar tudo" / "Agora não para todos": exactly the ids it listed at the click. */
export function useDecideApprovals(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: string[]; decision: "approve" | "refuse"; reason?: string }) =>
      api.approvals.decideMany(orgId, input),
    onSuccess: (result, { decision }) => {
      playSound(decision === "approve" ? "approved" : "error");
      for (const approval of result.approvals) cacheApproval(qc, orgId, approval);
      void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
    },
  });
}

/** What the agent runs without asking ("Aprovar sempre"), on its page. */
export const useApprovalRules = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.approvalRules(orgId, agentId),
    queryFn: () => api.approvals.rules(orgId, agentId),
    staleTime: 30_000,
  });
};

export function useRemoveApprovalRule(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) => api.approvals.removeRule(orgId, agentId, ruleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.approvalRules(orgId, agentId) }),
  });
}

// ── Connectors and agent scopes ─────────────────────────────────────────────

export const useCatalog = () => {
  const api = useApi();
  return useQuery({ queryKey: keys.catalog, queryFn: () => api.connectors.catalog(), staleTime: 10 * 60_000 });
};

export const useConnections = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.connections(orgId),
    queryFn: () => api.connectors.list(orgId),
    staleTime: 30_000,
    enabled,
  });
};

export function useConnectWithKey(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { connector: string; apiKey: string; label?: string }) =>
      api.connectors.connectWithKey(orgId, input),
    // A new connection is every agent's: their access trees change too, and so do the repositories GitHub reaches.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.connections(orgId) }),
        qc.invalidateQueries({ queryKey: keys.access(orgId) }),
        qc.invalidateQueries({ queryKey: keys.githubRepos(orgId) }),
      ]),
  });
}

export function useStartOAuth(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ connector, returnTo }: { connector: string; returnTo: string }) =>
      api.connectors.startOAuth(orgId, connector, { returnTo }),
  });
}

/**
 * Renames a connection (any kind). Its lists and every agent's access tree show the name. A 409 (`connector.label_taken`)
 * is the form's to say, not a toast.
 */
export function useRenameConnection(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => api.connectors.rename(orgId, id, label),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.connections(orgId) }),
        qc.invalidateQueries({ queryKey: keys.customServers(orgId) }),
        qc.invalidateQueries({ queryKey: keys.access(orgId) }),
      ]),
    meta: { silent: true },
  });
}

/** Where the phone app's OAuth lands: the callback hands `state` and `code` back to the app. */
export const APP_OAUTH_RETURN = "app:connectors";

/** The phone app (see `APP_OAUTH_RETURN`) or the desktop app's window finishes an authorization it started. */
export function useCompleteOAuth(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { state: string; code: string }) => api.connectors.completeOAuth(orgId, input),
    // Its callers say why it failed in words of their own (oauthReturnText on the web), once.
    meta: { silent: true },
    // It may finish a catalog connection or a server connected by address (their own list), every agent's.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.connections(orgId) }),
        qc.invalidateQueries({ queryKey: keys.customServers(orgId) }),
        qc.invalidateQueries({ queryKey: keys.access(orgId) }),
        qc.invalidateQueries({ queryKey: keys.githubRepos(orgId) }),
      ]),
  });
}

export const useGitHubApp = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.githubApp(orgId), queryFn: () => api.githubApp.info(orgId), staleTime: 30_000 });
};

export function useInstallGitHubApp(orgId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (returnTo: string) => api.githubApp.install(orgId, returnTo) });
}

/** The repositories the organization's GitHub reaches (the picker of an agent's repositories). */
export const useGitHubRepos = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.githubRepos(orgId),
    queryFn: () => api.githubApp.repositories(orgId),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
};

/** The GitHub repositories an agent may use, in order (empty = every repository). */
export const useAgentRepos = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentRepos(orgId, agentId),
    queryFn: () => api.repositories.get(orgId, agentId),
    enabled,
    retry: false,
  });
};

export function useRemoveGitHubApp(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.githubApp.remove(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.githubApp(orgId) }),
  });
}

export function useDisconnect(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => api.connectors.disconnect(orgId, connectionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.connections(orgId) });
      void qc.invalidateQueries({ queryKey: keys.githubRepos(orgId) });
      // Agents lose the scopes of that connection.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[4] === "scopes" });
    },
  });
}

export const useAgentScopes = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.scopes(orgId, agentId), queryFn: () => api.scopes.get(orgId, agentId) });
};

// ── Mailboxes (ADR 0038) ────────────────────────────────────────────────────

/** Which ways in this server offers (Gmail/Outlook, IMAP) and the IMAP presets. */
export const useMailProviders = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.mailProviders(orgId),
    queryFn: () => api.mail.providers(orgId),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });
};

/** The organization's mailboxes (no passwords), with the agents that use each. */
export const useMailAccounts = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.mailAccounts(orgId),
    queryFn: () => api.mail.accounts(orgId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
};

/** A mailbox's folders (the rules' and routines' folder pickers). */
export const useMailFolders = (orgId: string, accountId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.mailFolders(orgId, accountId ?? ""),
    queryFn: () => api.mail.folders(orgId, accountId ?? ""),
    enabled: Boolean(accountId),
    staleTime: 5 * 60_000,
    retry: false,
  });
};

/** Addresses a mailbox has sent from: what the addresses screen offers. */
export const useMailSuggestedAddresses = (orgId: string, accountId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.mailSuggested(orgId, accountId ?? ""),
    queryFn: () => api.mail.suggestedAddresses(orgId, accountId ?? ""),
    enabled: Boolean(accountId),
    staleTime: 5 * 60_000,
    retry: false,
  });
};

/** An agent's access and rules per mailbox. */
export const useAgentMail = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentMail(orgId, agentId),
    queryFn: () => api.mail.agent(orgId, agentId),
    enabled,
    retry: false,
  });
};

/** Connect, rename or reconnect, and disconnect a mailbox; each refreshes every mailbox read. */
export function useMailAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: keys.mail(orgId) });
  return {
    connectImap: useMutation({
      mutationFn: (input: MailImapInput) => api.mail.connectImap(orgId, input),
      onSuccess: done,
      // The form says why (wrong password, server not found…).
      meta: { silent: true },
    }),
    connectComposio: useMutation({
      mutationFn: (input: { provider: "gmail" | "outlook"; label?: string; accountId?: string; desktop?: boolean }) =>
        api.mail.connectComposio(orgId, input),
    }),
    update: useMutation({
      mutationFn: ({ accountId, ...input }: MailAccountUpdate & { accountId: string }) =>
        api.mail.update(orgId, accountId, input),
      onSuccess: done,
      meta: { silent: true },
    }),
    disconnect: useMutation({
      mutationFn: (accountId: string) => api.mail.disconnect(orgId, accountId),
      onSuccess: () => {
        void done();
        // Routines watching it and agents' rules change with it.
        void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
      },
    }),
  };
}

/** Saves an agent's level and rules for one mailbox. */
export function useSetAgentMail(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, accountId, input }: { agentId: string; accountId: string; input: AgentMailboxInput }) =>
      api.mail.setAgent(orgId, agentId, accountId, input),
    // The rules panel shows the error next to the rules.
    meta: { silent: true },
    onSuccess: (saved, { agentId }) => {
      qc.setQueryData<AgentMailbox[]>(keys.agentMail(orgId, agentId), (list) =>
        list ? list.map((m) => (m.accountId === saved.accountId ? saved : m)) : list,
      );
      void qc.invalidateQueries({ queryKey: keys.mailAccounts(orgId) });
      void qc.invalidateQueries({ queryKey: keys.scopes(orgId, agentId) });
    },
  });
}

// ── Management (phase 4) ────────────────────────────────────────────────────

export const useOverview = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.overview(orgId), queryFn: () => api.orgs.overview(orgId), staleTime: 30_000 });
};

export const useSettings = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.settings(orgId), queryFn: () => api.orgs.settings(orgId) });
};

export function useUpdateSettings(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<ApiClient["orgs"]["updateSettings"]>[1]) => api.orgs.updateSettings(orgId, input),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings(orgId), settings);
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      // The default agent budget moves every percentage that follows it.
      void qc.invalidateQueries({ queryKey: keys.usageReport(orgId) });
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      // A new GIF rating (or GIFs back on) changes what every search finds (ADR 0091).
      void qc.invalidateQueries({ queryKey: keys.gifs(orgId) });
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "org" && q.queryKey[1] === orgId && q.queryKey[4] === "detail",
      });
    },
  });
}

export const usePeople = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.people(orgId), queryFn: () => api.orgs.people(orgId), staleTime: 30_000 });
};

/**
 * Your availability and line (ADR 0084), shown at once in the people (yours is the only row that changes);
 * the server's answer replaces it, and everyone else's list follows on `member.status`.
 */
export function useSetMyStatus(orgId: string, userId: string | undefined) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StatusInput) => api.orgs.setStatus(orgId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.people(orgId) });
      const before = qc.getQueryData<Person[]>(keys.people(orgId));
      qc.setQueryData<Person[]>(keys.people(orgId), (people) =>
        people?.map((p) => (p.userId === userId ? withStatus(p, input) : p)),
      );
      return { before };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.people(orgId), ctx.before);
    },
    onSuccess: (me) => {
      qc.setQueryData<Person[]>(keys.people(orgId), (people) => people?.map((p) => (p.userId === me.userId ? me : p)));
    },
  });
}

/** What opens when the app starts here (ADR 0108): in `me` at once, back as it was if the server refuses. */
export function useSetStart(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const put = (start: StartChoice) =>
    qc.setQueryData<Me | null>(keys.me, (me) =>
      me ? { ...me, organizations: me.organizations.map((o) => (o.id === orgId ? { ...o, start } : o)) } : me,
    );
  return useMutation({
    mutationFn: (input: StartChoice) => api.orgs.setStart(orgId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.me });
      const before = qc.getQueryData<Me | null>(keys.me);
      put(input);
      return { before };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.before !== undefined) qc.setQueryData(keys.me, ctx.before);
    },
    onSuccess: put,
  });
}

/** Shows or hides what agents did under each reply, for me in this workspace: the switch moves at once. */
export function useSetShowActivity(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const put = (showActivity: boolean) =>
    qc.setQueryData<Me | null>(keys.me, (me) =>
      me ? { ...me, organizations: me.organizations.map((o) => (o.id === orgId ? { ...o, showActivity } : o)) } : me,
    );
  return useMutation({
    mutationFn: (show: boolean) => api.orgs.setShowActivity(orgId, show),
    onMutate: async (show) => {
      await qc.cancelQueries({ queryKey: keys.me });
      const before = qc.getQueryData<Me | null>(keys.me);
      put(show);
      return { before };
    },
    onError: (_e, _show, ctx) => {
      if (ctx?.before !== undefined) qc.setQueryData(keys.me, ctx.before);
    },
    onSuccess: put,
  });
}

/** Your own row with a status change applied, as the server will answer it. */
function withStatus(p: Person, input: StatusInput): Person {
  const presence = input.availability === undefined ? p.presence : AVAILABILITY_PRESENCE[input.availability];
  const status =
    input.status === undefined
      ? p.status
      : input.status?.text.trim()
        ? { text: input.status.text.trim(), emoji: input.status.emoji ?? null, until: input.status.until ?? null }
        : null;
  const availability = input.availability ?? p.availability;
  return {
    ...p,
    presence,
    online: presence !== "offline" && presence !== "hidden",
    status,
    ...(availability ? { availability } : {}),
  };
}

/** How you appear for what you picked (to yourself: hidden stays hidden). */
const AVAILABILITY_PRESENCE = { auto: "online", away: "away", busy: "busy", hidden: "hidden" } as const;

/**
 * Each agent's presence and line (ADR 0084). Refetched on `agent.status`, and every 30 s: presence also follows
 * time (busy after 2 minutes on one run, away after 30 idle) and runs elsewhere in the workspace.
 */
export const useAgentStatuses = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentStatus(orgId),
    queryFn: () => api.agents.statuses(orgId),
    staleTime: 15_000,
    refetchInterval: 30_000,
    enabled: enabled && orgId.length > 0,
  });
};

export const useAllInvitations = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.allInvitations(orgId), queryFn: () => api.orgs.allInvitations(orgId), enabled });
};

export function useInviteMany(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteBatch) => api.orgs.inviteMany(orgId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

/** The roles a pending invitation gives (ADR 0090): the same link, nothing is sent. */
export function useSetInvitationRoles(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; roleIds: string[] }) =>
      api.orgs.setInvitationRoles(orgId, input.id, input.roleIds),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

/** 30 more days for the same link (ADR 0090). */
export function useRenewInviteLink(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.invites.renewLink(orgId, linkId),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.inviteLinks(orgId) }),
  });
}

/** A member's suggestions that still wait (ADR 0090). */
export const useMySuggestions = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.mySuggestions(orgId), queryFn: () => api.joinRequests.mine(orgId), enabled });
};

/**
 * A member suggests someone to the people who may invite (ADR 0090). Its refusals are about the person suggested
 * (`join.member`: they're in already), so the screen says them in its own words, never the generic toast's.
 */
export function useSuggestPerson(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; note?: string }) => api.joinRequests.suggest(orgId, input),
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

export function useCancelSuggestion(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.joinRequests.cancel(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

export function useResendInvitation(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => api.orgs.resendInvitation(orgId, invitationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

/** The workspace's invitation links (admins, ADR 0068). */
export const useInviteLinks = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.inviteLinks(orgId), queryFn: () => api.invites.links(orgId), enabled });
};

/** "Make a link": the active one, or a new one. */
export function useMakeInviteLink(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.invites.createLink(orgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.inviteLinks(orgId) }),
  });
}

/** Turning a link off closes its requests too: the links, the requests and the pending list refresh. */
export function useTurnOffInviteLink(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.invites.turnOff(orgId, linkId),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
  });
}

/**
 * Requests to join waiting for an answer (admins, ADR 0068). Refreshed on focus, after each answer and when a
 * `join_request` notice arrives (`applyNotificationEvent`).
 */
export const useJoinRequests = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.joinRequests(orgId),
    queryFn: () => api.joinRequests.list(orgId),
    enabled,
    refetchOnWindowFocus: true,
  });
};

/**
 * Whoever got in shows in the people and in the workspace's counts (the sidebar's "2 members"); an invitation, in
 * the pending list. Refetched after a refusal too.
 */
function refreshAnswered(qc: QC, orgId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.invitations(orgId) }),
    qc.invalidateQueries({ queryKey: keys.people(orgId) }),
    qc.invalidateQueries({ queryKey: keys.members(orgId) }),
    qc.invalidateQueries({ queryKey: keys.overview(orgId) }),
  ]);
}

export function useApproveJoinRequest(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; roleIds?: string[] }) => api.joinRequests.approve(orgId, input.id, input.roleIds),
    onSettled: () => refreshAnswered(qc, orgId),
  });
}

export function useDenyJoinRequest(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) => api.joinRequests.deny(orgId, input.id, input.reason),
    onSettled: () => refreshAnswered(qc, orgId),
  });
}

export const useUsageReport = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.usageReport(orgId), queryFn: () => api.orgs.usageReport(orgId), enabled });
};

/** The workspace's Composio calls this month (Uso, and Conectores past 80%). */
export const useComposioUsage = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.composioUsage(orgId),
    queryFn: () => api.connectors.composioUsage(orgId),
    enabled,
    staleTime: 60_000,
  });
};

/** Configurações › Auditoria: pages of 50, newest first (admins). */
export function useAudit(orgId: string, query: AuditQuery, enabled = true) {
  const api = useApi();
  return useInfiniteQuery({
    enabled,
    queryKey: keys.audit(orgId, query),
    queryFn: ({ pageParam }) => api.orgs.audit(orgId, { ...query, ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.next ?? undefined,
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
}

/**
 * One row of the audit log already on screen (the phone's detail screen, pushed over the list): read from the
 * pages loaded for any filter; null when none holds it.
 */
export function useAuditRow(orgId: string, id: string): AuditRow | null {
  const qc = useQueryClient();
  const pages = qc.getQueriesData<InfiniteData<AuditPage>>({ queryKey: ["org", orgId, "audit"] });
  for (const [, data] of pages) {
    const row = data?.pages.flatMap((p) => p.rows).find((r) => r.id === id);
    if (row) return row;
  }
  return null;
}

/** Configurações › Uso: every plan account by computer and the API per agent (ADR 0063). */
export const usePlanUsage = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.planUsage(orgId), queryFn: () => api.orgs.planUsage(orgId) });
};

/** The agent's "Uso" tab: its month by account and day, and the account it thinks with now. */
export const useAgentPlanUsage = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentPlanUsage(orgId, agentId),
    queryFn: () => api.agents.planUsage(orgId, agentId),
  });
};

export const usePlatformKey = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.platformKey(orgId),
    queryFn: () => api.agents.platformKeyAvailable(orgId),
    staleTime: 10 * 60_000,
  });
};

/**
 * Whether each agent has an AI to think with (the no-AI banner, card and chip). `pollMs` where no socket is open
 * (the onboarding), a time or one picked from the last answer.
 */
export const useAiStatus = (
  orgId: string,
  enabled = true,
  pollMs: number | false | ((status: AiStatus | undefined) => number | false) = false,
) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.aiStatus(orgId),
    queryFn: () => api.agents.aiStatus(orgId),
    staleTime: 30_000,
    enabled: enabled && orgId.length > 0,
    refetchInterval: typeof pollMs === "function" ? (query) => pollMs(query.state.data) : pollMs,
  });
};

export function useRotateCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, apiKey }: { id: string; apiKey: string }) => api.agents.rotateCredential(orgId, id, { apiKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.credentials(orgId) }),
  });
}

export function useRemoveCredential(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, purge }: { id: string; purge?: boolean }) => api.agents.removeCredential(orgId, id, purge),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.credentials(orgId) }),
  });
}

export const useAgentDetail = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDetail(orgId, agentId),
    queryFn: () => api.agents.detail(orgId, agentId),
    staleTime: 15_000,
  });
};

/** An agent's runs this month (newest first). */
export const useRuns = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.runs(orgId, agentId),
    queryFn: () => api.agents.runs(orgId, { agentId, limit: 200 }),
    enabled,
  });
};

export const useRun = (orgId: string, runId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.run(orgId, runId ?? ""),
    queryFn: () => api.agents.run(orgId, runId ?? ""),
    enabled: runId !== null,
  });
};

/**
 * The questions agents asked other agents from a conversation (`GET …/consultations`), for the block inside the
 * reply that asked. The page reloads it on `agent.consulting`, `agent.consulted` and `agent.consultation`; while a
 * question is out it also reloads every `CONSULT_GROUP_POLL_MS`.
 */
export const useConsultations = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.consultations(orgId, channelId),
    queryFn: () => api.agents.consultations(orgId, channelId),
    enabled,
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === "open") ? CONSULT_GROUP_POLL_MS : false),
  });
};

/**
 * One of those questions opened beside the conversation (`GET …/consultations/{id}`). The agents' DM sends this
 * page no events: while the question is out it reloads every `CONSULT_CONVERSATION_POLL_MS`, and with the list
 * (its key sits under the list's) on every consult event.
 */
export const useConsultationConversation = (orgId: string, channelId: string, consultationId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.consultation(orgId, channelId, consultationId ?? ""),
    queryFn: () => api.agents.consultation(orgId, channelId, consultationId ?? ""),
    enabled: consultationId !== null,
    refetchInterval: (q) => (q.state.data?.consultation.status === "open" ? CONSULT_CONVERSATION_POLL_MS : false),
  });
};

export const useRoster = (orgId: string, channelId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.roster(orgId, channelId),
    queryFn: () => api.chat.roster(orgId, channelId),
    enabled,
    staleTime: 30_000,
  });
};

export function useUpdateChannel(orgId: string, channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChannelInput & { name?: string }) => api.chat.update(orgId, channelId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(orgId) }),
  });
}

/** Archives a channel (creator or admin): it leaves the list. */
export function useArchiveChannel(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.chat.archive(orgId, channelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.channels(orgId) }),
  });
}

// ── Direct messages ─────────────────────────────────────────────────────────

export const useDms = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.dms(orgId), queryFn: () => api.dms.list(orgId), staleTime: 30_000 });
};

/** "Visto" in a DM between people: where the others stopped reading (live: `channel.read`). */
export function useDmReads(orgId: string, channelId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dmReads(orgId, channelId),
    queryFn: () => api.dms.reads(orgId, channelId),
    enabled,
    staleTime: 60_000,
  });
}

/** `channel.read`: someone in a DM read up to a moment ("Visto" moves). */
export function cacheDmRead(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  event: { channelId: string; userId: string; lastReadAt: string },
) {
  qc.setQueryData<DmRead[]>(keys.dmReads(orgId, event.channelId), (reads) =>
    withRead(reads, { userId: event.userId, lastReadAt: event.lastReadAt }),
  );
}

// ── Knowledge (phase 5) ─────────────────────────────────────────────────────

/** A search; with `filters` (ADR 0123) it runs with no words too, as long as one filter is set. */
export const useSearch = (orgId: string, q: string, kinds: SearchKind[], filters?: SearchFilterInput) => {
  const api = useApi();
  const text = q.trim();
  const filtered = Object.keys(filters ?? {}).some((k) => k !== "sort");
  return useQuery({
    queryKey: [...keys.search(orgId, text, kinds.join(",")), filters ?? null],
    queryFn: () => api.search.query(orgId, { q: text, kinds, limit: filters ? 100 : 50, filters }),
    enabled: text.length > 0 || filtered,
    placeholderData: (previous) => previous,
  });
};

/** Reactions on one message, loaded when its actions are shown or used. */
export const useReactions = (orgId: string, messageId: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.reactions(orgId, messageId),
    queryFn: () => api.chat.reactions(orgId, messageId),
    enabled,
    staleTime: 30_000,
  });
};

export function useToggleReaction(orgId: string, messageId: string) {
  const api = useApi();
  const onAgentReaction = useAgentReaction();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reaction, on }: { reaction: string; on: boolean }) =>
      on ? api.chat.react(orgId, messageId, reaction) : api.chat.unreact(orgId, messageId, reaction),
    onSuccess: (reactions) => applyReactions(qc, orgId, messageId, reactions, onAgentReaction),
  });
}

/** A message's reactions as this client knows them: the reactions cache, else the message in a cached list. */
function knownReactions(qc: ReturnType<typeof useQueryClient>, orgId: string, messageId: string) {
  const cached = qc.getQueryData<ReactionCount[]>(keys.reactions(orgId, messageId));
  if (cached) return cached;
  for (const [, data] of qc.getQueriesData({ queryKey: ["org", orgId, "channel"] })) {
    if (!Array.isArray(data)) continue;
    const m = (data as Message[]).find((x) => x && x.id === messageId);
    if (m) return m.reactions ?? [];
  }
  return [];
}

/**
 * New reactions for a message (the reactor's response or `message.reactions`,
 * whichever comes first): the pills, and when a person just gave 👍/👎 the
 * agent who wrote it makes a face for everyone watching (`onAgentReaction`, the
 * web's `playAgentReaction`: only agent messages' avatars carry the message id
 * as their reaction key).
 */
export function applyReactions(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  messageId: string,
  next: ReactionCount[],
  onAgentReaction?: AgentReactionEffect,
) {
  const before = knownReactions(qc, orgId, messageId);
  for (const [reaction, kind] of [
    ["+1", "up"],
    ["-1", "down"],
  ] as const) {
    const had = new Set(before.find((r) => r.reaction === reaction)?.userIds ?? []);
    if (onAgentReaction && next.find((r) => r.reaction === reaction)?.userIds.some((u) => !had.has(u)))
      onAgentReaction(messageId, kind);
  }
  qc.setQueryData(keys.reactions(orgId, messageId), next);
}

/** `message.memories`: the memory marks of one message, in every cached list of that channel. */
export function cacheMessageMemories(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  messageId: string,
  memories: MessageMemory[],
) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, memories } : m));
  });
}

/**
 * `message.pinned` / `message.unpinned` (and "Fixar" / "Desafixar" optimistically): the message's pin mark in every
 * cached list of that channel (timeline and threads).
 */
export function cachePinned(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  messageId: string,
  pinned: boolean,
) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, pinned } : m));
  });
}

/**
 * `message.actions` (and undo/redo results): an agent message's receipts, in
 * every cached list of that channel (timeline and threads). Replaces the list.
 */
export function cacheMessageActions(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  messageId: string,
  actions: AgentAction[],
) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, actions } : m));
  });
}

/** A long work changed (`agent.work`, ADR 0121): its anchor's cached message carries the new view. */
export function cacheMessageWork(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  channelId: string,
  work: WorkView,
) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === work.anchorMessageId)) return data;
    return list.map((m) => (m.id === work.anchorMessageId ? { ...m, longWork: work } : m));
  });
}

/** One receipt changed: put it in its message's cached list (keeps the others). */
function cacheOneAction(qc: ReturnType<typeof useQueryClient>, orgId: string, channelId: string, action: AgentAction) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === action.messageId)) return data;
    return list.map((m) =>
      m.id === action.messageId
        ? { ...m, actions: (m.actions ?? []).map((a) => (a.id === action.id ? action : a)) }
        : m,
    );
  });
}

/**
 * Desfazer / Refazer / Desfazer tudo on an agent's receipts. The cached
 * message updates from the answer (the `message.actions` event follows for
 * everyone). Errors are `ApiError` with `code` (`action.changed_since`…):
 * silent for the global handler, the screen says them (`actionErrorKey`).
 */
export function useAgentActions(orgId: string, channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const one = (result: AgentAction) => cacheOneAction(qc, orgId, channelId, result);
  return {
    undo: useMutation({
      mutationFn: (actionId: string) => part(api, "actions").undo(orgId, actionId),
      onSuccess: one,
      meta: { silent: true },
    }),
    redo: useMutation({
      mutationFn: (actionId: string) => part(api, "actions").redo(orgId, actionId),
      onSuccess: one,
      meta: { silent: true },
    }),
    undoAll: useMutation({
      mutationFn: (messageId: string) => part(api, "actions").undoMessage(orgId, messageId),
      onSuccess: (result, messageId) => cacheMessageActions(qc, orgId, channelId, messageId, result.actions),
      meta: { silent: true },
    }),
  };
}

export function useCorrectMessage(orgId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: string }) => api.chat.correct(orgId, messageId, body),
  });
}

// ── Invites, custom MCP ─────────────────────────────────────────────────────

export const useCustomServers = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.customServers(orgId), queryFn: () => api.customConnectors.list(orgId), enabled });
};

/** Approved MCP tools whose server changed them (ADR 0117): connector admins only (`enabled`). */
export const useToolChanges = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.toolChanges(orgId),
    queryFn: () => api.customConnectors.toolChanges(orgId),
    enabled,
  });
};

export function useAcceptToolChange(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: { connectionId: string; toolName: string }) =>
      api.customConnectors.acceptToolChange(orgId, c.connectionId, c.toolName),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.toolChanges(orgId) }),
        qc.invalidateQueries({ queryKey: keys.customServers(orgId) }),
      ]),
  });
}

/** "Aceitar todas" on one connection's changed tools (ADR 0117). */
export function useAcceptConnectionToolChanges(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => api.customConnectors.acceptConnectionToolChanges(orgId, connectionId),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.toolChanges(orgId) }),
        qc.invalidateQueries({ queryKey: keys.customServers(orgId) }),
      ]),
  });
}

export function useCustomServerAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: keys.customServers(orgId) });
  return {
    connect: useMutation({
      mutationFn: (input: {
        serverUrl: string;
        apiKey?: string;
        label?: string;
        returnTo: string;
        connectionId?: string;
      }) => api.customConnectors.connect(orgId, input),
      // A new server is every agent's: their access trees change too.
      onSuccess: () => Promise.all([done(), qc.invalidateQueries({ queryKey: keys.access(orgId) })]),
    }),
    refresh: useMutation({ mutationFn: (id: string) => api.customConnectors.refresh(orgId, id), onSuccess: done }),
    save: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        label: string;
        tools: { name: string; access: ToolDecision; label: string }[];
      }) => api.customConnectors.saveTools(orgId, id, input),
      onSuccess: done,
    }),
    disconnect: useMutation({
      mutationFn: (id: string) => api.customConnectors.disconnect(orgId, id),
      onSuccess: done,
    }),
  };
}

// ── Memory and proposals (phase 5) ──────────────────────────────────────────

export const useMemory = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.memory(orgId, agentId), queryFn: () => api.memory.list(orgId, agentId) });
};

/** What all the agents know (the viewer's share of it), for the map of the workspace's memory. */
export const useOrgMemories = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.orgMemories(orgId), queryFn: () => api.memory.listAll(orgId) });
};

/** "O que sabe sobre você": the agent's memories that came from the viewer, each with the message. */
export const useMemoryAboutMe = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.memoryAboutMe(orgId, agentId),
    queryFn: () => api.memory.list(orgId, agentId, { about: "me" }),
    enabled,
  });
};

/** "O que fez por você": the agent's receipts, files and approvals that involve the viewer. */
export function useAgentForYou(orgId: string, agentId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentForYou(orgId, agentId),
    queryFn: () => part(api, "agentForYou").get(orgId, agentId),
    enabled: enabled && Boolean(api.agentForYou),
    staleTime: 15_000,
  });
}

export function useMemoryAction(orgId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "edit"; id: string; text: string }
        | { type: "pin"; id: string; pinned: boolean }
        | { type: "archive"; id: string; archived: boolean },
    ) => {
      if (action.type === "edit") return api.memory.edit(orgId, action.id, action.text);
      if (action.type === "pin") return api.memory.setPinned(orgId, action.id, action.pinned);
      return api.memory.setArchived(orgId, action.id, action.archived);
    },
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.memory(orgId, agentId) }),
        qc.invalidateQueries({ queryKey: keys.orgMemories(orgId) }),
      ]),
  });
}

export const useProposals = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.proposals(orgId), queryFn: () => api.proposals.list(orgId) });
};

/**
 * A proposal card's rows, in the card's order, read by id: the list only holds the newest, and a card stays whole
 * however many came after it. (A server without `ids` sends the list: the card's rows are picked from it.)
 */
export function useCardProposals(orgId: string, ids: string[]) {
  const api = useApi();
  const query = useQuery({
    queryKey: keys.cardProposals(orgId, ids),
    queryFn: () => api.proposals.list(orgId, { ids }),
  });
  return (query.data ?? []).filter((p) => ids.includes(p.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

/**
 * What accepted proposals changed on their agents' pages, wherever they were accepted: the instructions and role
 * (profile card, hero, team), and the apps (the Access tab and the matrix).
 */
function refreshAccepted(qc: QueryClient, orgId: string, decided: Proposal[]) {
  const accepted = decided.filter((p) => p.status === "accepted" && p.target.type !== "org_context");
  if (accepted.length === 0) return;
  void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
  void qc.invalidateQueries({ queryKey: keys.team(orgId) });
  for (const p of accepted) {
    void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, p.agentId) });
    if (p.target.type === "agent_access") void qc.invalidateQueries({ queryKey: keys.scopes(orgId, p.agentId) });
  }
  if (accepted.some((p) => p.target.type === "agent_access"))
    void qc.invalidateQueries({ queryKey: keys.access(orgId) });
}

export function useDecideProposal(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: "accept" | "refuse"; text?: string }) =>
      input.decision === "accept"
        ? api.proposals.accept(orgId, input.id, input.text)
        : api.proposals.refuse(orgId, input.id),
    // The page explains a stale proposal (409) itself.
    meta: { silent: true },
    onSuccess: (row) => refreshAccepted(qc, orgId, [row]),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.proposals(orgId) }),
  });
}

/**
 * A card's rows accepted or refused at once: one request per row, so each applies on its own and a stale one
 * never stops the rest, then one refresh. Resolves with the rows decided and the ones that failed and why.
 */
export function useDecideProposals(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids: string[]; decision: "accept" | "refuse" }) => {
      const decided: Proposal[] = [];
      const failed: { id: string; error: unknown }[] = [];
      for (const id of input.ids) {
        try {
          decided.push(
            await (input.decision === "accept" ? api.proposals.accept(orgId, id) : api.proposals.refuse(orgId, id)),
          );
        } catch (error) {
          failed.push({ id, error });
        }
      }
      return { decided, failed };
    },
    meta: { silent: true },
    onSuccess: ({ decided }) => refreshAccepted(qc, orgId, decided),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.proposals(orgId) }),
  });
}

/** People, files and today's uploads against the workspace's limits (ADR 0079): any member. */
export const useWorkspaceLimits = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.limits(orgId), queryFn: () => api.orgs.limits(orgId), enabled });
};

export const useStorage = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.storage(orgId), queryFn: () => api.storage.get(orgId), enabled });
};

export function useTestStorage(orgId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (input: S3Input) => api.storage.test(orgId, input) });
}

export function useSaveStorage(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: "agentes" } | { kind: "s3"; s3: S3Input }) => api.storage.save(orgId, input),
    onSuccess: (config) => {
      qc.setQueryData(keys.storage(orgId), config);
      qc.removeQueries({ queryKey: keys.storageMigration(orgId) });
      void qc.invalidateQueries({ queryKey: keys.limits(orgId) });
    },
  });
}

/** Copy status; polls while the copy runs. */
export const useStorageMigration = (orgId: string, enabled: boolean) => {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.storageMigration(orgId),
    queryFn: async () => {
      const was = qc.getQueryData<StorageMigration | null>(keys.storageMigration(orgId))?.status;
      const m = await api.storage.migration(orgId);
      // A copy that stops has moved files from one storage to the other: what each holds (`usage`, and what the
      // storage limit counts) is stale.
      if (was === "running" && m?.status !== "running") {
        void qc.invalidateQueries({ queryKey: keys.storage(orgId), exact: true });
        void qc.invalidateQueries({ queryKey: keys.limits(orgId) });
      }
      return m;
    },
    enabled,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
    refetchIntervalInBackground: true,
  });
};

export function useStartMigration(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.storage.migrate(orgId),
    onSuccess: (m) => qc.setQueryData(keys.storageMigration(orgId), m),
  });
}

export const useArtifacts = (orgId: string, filters: ArtifactFilters) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactList(orgId, filters),
    queryFn: () => api.artifacts.list(orgId, filters),
    placeholderData: (prev) => prev,
  });
};

/** One artifact at a version (latest when omitted). */
/** `GET …/artifacts-trash`: deleted files (30 days). */
export const useArtifactTrash = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.artifacts(orgId), "trash"] as const,
    queryFn: () => api.artifacts.trash(orgId),
  });
};

export const useArtifact = (orgId: string, id: string | null, version?: number) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifact(orgId, id ?? "", version),
    queryFn: () => api.artifacts.get(orgId, id ?? "", version),
    enabled: Boolean(id),
    // Old versions never change.
    staleTime: version ? Number.POSITIVE_INFINITY : 0,
  });
};

/** A vote: the answers come in over the socket (`poll.updated`). */
export const usePoll = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.poll(orgId, id ?? ""),
    queryFn: () => api.artifacts.poll(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export const useVote = (orgId: string, id: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (options: number[]) => api.artifacts.vote(orgId, id, options),
    onSuccess: (poll) => qc.setQueryData(keys.poll(orgId, id), poll),
  });
};

/** A choice card's answer (ADR 0124): it comes in over the socket too (`choices.updated`). */
export const useChoices = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.choices(orgId, id ?? ""),
    queryFn: () => api.artifacts.choices(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export const useAnswerChoices = (orgId: string, id: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (picks: number[]) => api.artifacts.answerChoices(orgId, id, picks, newClientId()),
    onSuccess: (out) => qc.setQueryData(keys.choices(orgId, id), out.choices),
    // The card says it itself, and says nothing when someone answered first.
    meta: { silent: true },
  });
};

export const useKeepBlock = (orgId: string, id: string) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.artifacts.keep(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
};

export const useBlockReply = (orgId: string, id: string) => {
  const api = useApi();
  return useMutation({
    mutationFn: ({ text, clientId }: { text: string; clientId: string }) =>
      api.artifacts.reply(orgId, id, text, clientId),
  });
};

export const useArtifactVersions = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactVersions(orgId, id ?? ""),
    queryFn: () => api.artifacts.versions(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export function useSaveArtifact(orgId: string, id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: ArtifactContent; note?: string | null; baseVersion: number }) =>
      api.artifacts.update(orgId, id, input),
    // The viewer explains a stale version (409) itself.
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** Uploads a file to the Drive, or a new version of `artifactId`. Errors are shown by the caller. */
export function useUploadFile(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      file: File;
      title?: string;
      channelId?: string | null;
      artifactId?: string;
      note?: string;
    }): Promise<ArtifactDetail> =>
      input.artifactId
        ? api.artifacts.uploadVersion(orgId, input.artifactId, input.file, { note: input.note })
        : api.artifacts.upload(orgId, input.file, { title: input.title, channelId: input.channelId }),
    meta: { silent: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.artifacts(orgId) }),
  });
}

/** The bytes of a file version as an object URL (previews); never refetched (versions don't change). */
export const useArtifactBlob = (orgId: string, id: string, version: number, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.artifactBlob(orgId, id, version),
    queryFn: () => api.artifacts.fileBlob(orgId, id, version),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
    meta: { quiet: true },
  });
};

// ── Issues ───────────────────────────────────────────────────────────────────

export const useIssues = (orgId: string, q = "") => {
  const api = useApi();
  return useQuery({
    queryKey: keys.issueList(orgId, q),
    queryFn: () => api.issues.list(orgId, q ? { q } : {}),
    placeholderData: (prev) => prev,
    // While an agent works on an issue its steps change without an event: look again every 10 s.
    refetchInterval: (query) => (query.state.data?.some((i) => i.work && i.work.state !== "stalled") ? 10_000 : false),
  });
};

export const useIssue = (orgId: string, number: number) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.issue(orgId, number),
    queryFn: () => api.issues.get(orgId, number),
    refetchInterval: (query) => (query.state.data?.work && query.state.data.work.state !== "stalled" ? 10_000 : false),
  });
};

export const useIssueActivity = (orgId: string, id: string | undefined) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.issueActivity(orgId, id ?? ""),
    queryFn: () => api.issues.activity(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

/**
 * A live event while a task is open: a comment or an event on it (`issue.comment`) goes into its activity once, and
 * an event also refreshes the task itself (status, assignee, a linked PR). `false`: not about this task.
 */
export function applyIssueActivityEvent(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  issueId: string,
  event: { type: string },
): boolean {
  if (event.type !== "issue.comment" || !("issueId" in event) || !("activity" in event)) return false;
  const { issueId: id, activity } = event as IssueActivityEvent;
  if (id !== issueId) return false;
  qc.setQueryData<IssueActivity[]>(keys.issueActivity(orgId, issueId), (list) =>
    !list || list.some((a) => a.id === activity.id) ? list : [...list, activity],
  );
  if (activity.kind === "event") void qc.invalidateQueries({ queryKey: [...keys.issues(orgId), "one"] });
  return true;
}

/**
 * A task's activity live while it is open: comments and events come on the task's channel, or as org broadcasts
 * for a task with none. What was missed while the connection was down comes back on reconnect.
 */
export function useIssueLive(
  orgId: string,
  connection: RealtimeConnection | null,
  issue: { id: string; channelId: string | null } | undefined,
) {
  const qc = useQueryClient();
  const issueId = issue?.id;
  const channelId = issue?.channelId ?? null;
  useEffect(() => {
    if (!connection || !issueId) return;
    const take = (event: { type: string }) => void applyIssueActivityEvent(qc, orgId, issueId, event);
    const offOrg = connection.onUserEvent(take);
    const offChannel = channelId ? connection.subscribe(channelId, take) : undefined;
    const offReconnect = connection.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: keys.issueActivity(orgId, issueId) });
    });
    return () => {
      offOrg();
      offChannel?.();
      offReconnect();
    };
  }, [connection, orgId, qc, issueId, channelId]);
}

export function useIssueAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "create"; input: IssueInput }
        | { type: "update"; id: string; patch: IssuePatch }
        | { type: "criterion"; id: string; criterionId: string; done: boolean }
        | { type: "comment"; id: string; text: string; attachmentIds?: string[] }
        | { type: "ask"; id: string; agentId: string },
    ): Promise<unknown> => {
      switch (action.type) {
        case "create":
          return api.issues.create(orgId, action.input);
        case "update":
          return api.issues.update(orgId, action.id, action.patch);
        case "criterion":
          return api.issues.setCriterion(orgId, action.id, action.criterionId, action.done);
        case "comment":
          return api.issues.comment(orgId, action.id, action.text, action.attachmentIds);
        case "ask":
          return api.issues.askAgent(orgId, action.id, action.agentId);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.issues(orgId) });
      void qc.invalidateQueries({ queryKey: keys.calendar(orgId) });
    },
  });
}

/** The board's columns; they live under the issues key, so any issue change refreshes them too. */
export const useIssueColumns = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.issueColumns(orgId), queryFn: () => api.issues.columns(orgId) });
};

export function useIssueColumnAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "add"; name: string; stage: IssueStatus; afterId?: string | null }
        | { type: "update"; columnId: string; name?: string; index?: number }
        | { type: "delete"; columnId: string; moveTo: string },
    ): Promise<IssueColumn[]> => {
      switch (action.type) {
        case "add":
          return api.issues.addColumn(orgId, { name: action.name, stage: action.stage, afterId: action.afterId });
        case "update":
          return api.issues.updateColumn(orgId, action.columnId, { name: action.name, index: action.index });
        case "delete":
          return api.issues.deleteColumn(orgId, action.columnId, action.moveTo);
      }
    },
    onSuccess: (columns) => qc.setQueryData(keys.issueColumns(orgId), columns),
    // Deleting a column moves its tasks.
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.issues(orgId) }),
  });
}

// ── Routines ─────────────────────────────────────────────────────────────────

export const useRoutines = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.routines(orgId),
    queryFn: () => api.routines.list(orgId),
    refetchInterval: (q) => usagePauseRefetchMs(q.state.data),
  });
};

export const useRoutineRuns = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.routineRuns(orgId, id ?? ""),
    queryFn: () => api.routines.runs(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

/** A webhook routine's address and latest calls (ADR 0106), for who manages it. */
export const useRoutineHook = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.routineHook(orgId, id ?? ""),
    queryFn: () => api.routines.hook(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

/** A new address, a new signing secret (its `secret` shown once) or none, and Testar. */
export function useRoutineHookAction(orgId: string, id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: "address" | "secret" | "unsign" | "test",
    ): Promise<{ hook: RoutineHook; secret?: string; runId?: string | null }> => {
      if (action === "address") return { hook: await api.routines.newHookAddress(orgId, id) };
      if (action === "secret") return api.routines.newHookSecret(orgId, id);
      if (action === "unsign") return { hook: await api.routines.removeHookSecret(orgId, id) };
      return api.routines.testHook(orgId, id);
    },
    onSuccess: ({ hook }) => qc.setQueryData(keys.routineHook(orgId, id), hook),
    // The list carries the address too, and a test starts a run (both under the routines' key).
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.routines(orgId) }),
  });
}

export const useScheduleParse = (orgId: string, phrase: string, enabled: boolean, timezone?: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ["org", orgId, "routines", "parse", phrase, timezone ?? ""] as const,
    queryFn: () => api.routines.parseSchedule(orgId, phrase, timezone),
    enabled,
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

/** `POST …/routines/parse-rule`: a phrase → rule (fills the picker). */
export const useRuleParse = (orgId: string, phrase: string, enabled: boolean, timezone?: string) => {
  const api = useApi();
  return useQuery({
    queryKey: ["org", orgId, "routines", "parse-rule", phrase, timezone ?? ""] as const,
    queryFn: () => api.routines.parseRule(orgId, phrase, timezone),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

/** `POST …/routines/describe-rule`: the picker's sentence and next runs. */
export const useRuleDescribe = (orgId: string, rule: ApiRule | null) => {
  const api = useApi();
  const key = rule ? JSON.stringify(rule) : "";
  return useQuery({
    queryKey: ["org", orgId, "routines", "describe-rule", key] as const,
    queryFn: () => api.routines.describeRule(orgId, rule as ApiRule),
    enabled: Boolean(rule),
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

export function useRoutineAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      action:
        | { type: "create"; input: RoutineInput }
        | { type: "active"; id: string; active: boolean }
        | { type: "run"; id: string }
        | { type: "stop"; id: string }
        /** Continuar agora on a run paused near its plan's or budget's limit. */
        | { type: "continueUsage"; id: string }
        | { type: "update"; id: string; patch: RoutinePatch }
        | { type: "delete"; id: string }
        | { type: "duplicate"; id: string; name?: string }
        /** "Assumir rotina": I become its creator, and it runs again. */
        | { type: "takeOver"; id: string }
        /** "Adicionar agente ao canal": the agent joins the channel it delivers to, and it runs again. */
        | { type: "addAgent"; id: string; agentId: string; channelId: string },
    ): Promise<unknown> => {
      if (action.type === "create") return api.routines.create(orgId, action.input);
      if (action.type === "update") return api.routines.update(orgId, action.id, action.patch);
      if (action.type === "delete") return api.routines.remove(orgId, action.id);
      if (action.type === "duplicate") return api.routines.duplicate(orgId, action.id, action.name);
      if (action.type === "active") return api.routines.setActive(orgId, action.id, action.active);
      if (action.type === "stop") return api.routines.stop(orgId, action.id);
      if (action.type === "continueUsage") return api.routines.continueUsage(orgId, action.id);
      if (action.type === "takeOver") {
        await api.routines.takeOver(orgId, action.id);
        return api.routines.setActive(orgId, action.id, true);
      }
      if (action.type === "addAgent") {
        await api.chat.addMember(orgId, action.channelId, { agentId: action.agentId });
        return api.routines.setActive(orgId, action.id, true);
      }
      return api.routines.runNow(orgId, action.id);
    },
    // A routine just made or changed is in the list at once, before it comes back: its page reads it from there.
    onSuccess: (saved, action) => {
      if (action.type !== "create" && action.type !== "update" && action.type !== "duplicate") return;
      const routine = saved as Routine;
      qc.setQueryData<Routine[]>(keys.routines(orgId), (list) =>
        list?.some((r) => r.id === routine.id)
          ? list.map((r) => (r.id === routine.id ? routine : r))
          : list && [...list, routine],
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.calendar(orgId) });
    },
  });
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export const useCalendar = (orgId: string, from: string, to: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.calendarRange(orgId, from),
    queryFn: () => api.calendar.range(orgId, from, to),
    placeholderData: (prev) => prev,
  });
};

export function useCalendarAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | { type: "create"; input: CalendarEventInput }
        | { type: "confirm" | "dismiss"; id: string }
        | {
            type: "update";
            id: string;
            patch: CalendarEventPatch;
            series?: { scope: SeriesScope; occurrenceStart: string };
          }
        | { type: "remove"; id: string; series?: { scope: SeriesScope; occurrenceStart: string } },
    ): Promise<unknown> => {
      if (action.type === "create") return api.calendar.create(orgId, action.input);
      if (action.type === "update") return api.calendar.update(orgId, action.id, action.patch, action.series);
      if (action.type === "remove") return api.calendar.remove(orgId, action.id, action.series);
      if (action.type === "confirm") return api.calendar.confirmProposal(orgId, action.id);
      return api.calendar.dismissProposal(orgId, action.id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.calendar(orgId) }),
  });
}

// ── Agent access (tool tree) ─────────────────────────────────────────────────

/** The agent's tool tree. `retry: false`: a 404 means the backend doesn't have it yet. */
export const useAgentAccess = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentAccess(orgId, agentId),
    queryFn: () => api.access.get(orgId, agentId),
    enabled,
    retry: false,
  });
};

// ── Skills ───────────────────────────────────────────────────────────────────

/** The org library. `retry: false`: a 404 means the server doesn't have skills. */
export const useSkills = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({ queryKey: keys.skills(orgId), queryFn: () => api.skills.list(orgId), enabled, retry: false });
};

export const useSkill = (orgId: string, id: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.skill(orgId, id ?? ""),
    queryFn: () => api.skills.get(orgId, id ?? ""),
    enabled: Boolean(id),
  });
};

export const useAgentSkills = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentSkills(orgId, agentId),
    queryFn: () => api.skills.forAgent(orgId, agentId),
    enabled,
    retry: false,
  });
};

/** Skills the agent made from its own how-tos ("Aprendizados"); empty on a server without them. */
export const useLearnedSkills = (orgId: string, agentId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.learnedSkills(orgId, agentId),
    queryFn: () => api.skills.learned?.(orgId, agentId) ?? Promise.resolve([]),
    retry: false,
  });
};

/** Which agents use each skill (the API lists skills per agent): skillId → agents. */
export function useSkillUsage(orgId: string, enabled: boolean) {
  const api = useApi();
  const agents = useAgents(orgId);
  const list = enabled ? (agents.data ?? []) : [];
  const per = useQueries({
    queries: list.map((a) => ({
      queryKey: keys.agentSkills(orgId, a.id),
      queryFn: () => api.skills.forAgent(orgId, a.id),
      retry: false,
    })),
  });
  const usage = new Map<string, { id: string; name: string }[]>();
  per.forEach((q, i) => {
    const agent = list[i];
    if (!agent) return;
    for (const s of q.data ?? []) {
      if (!s.enabled) continue;
      usage.set(s.id, [...(usage.get(s.id) ?? []), { id: agent.id, name: agent.name }]);
    }
  });
  return usage;
}

/** `silent`: the screen says every refusal itself (Instalar skill), so the app's own error toast stays out. */
export function useSkillAction(orgId: string, { silent = false } = {}) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    ...(silent ? { meta: { silent: true } } : {}),
    mutationFn: (
      action:
        | { type: "import"; input: { url: string; list?: boolean } | { zipBase64: string } }
        | { type: "importPicked"; url: string; paths: string[] }
        | { type: "create"; input: SkillInput }
        | { type: "update"; id: string; patch: SkillPatch }
        | { type: "reimport"; id: string }
        | { type: "remove"; id: string }
        | { type: "revert"; id: string }
        | { type: "restore"; id: string }
        | { type: "assign"; agentId: string; skills: { skillId: string; enabled: boolean }[] },
    ): Promise<unknown> => {
      switch (action.type) {
        case "import":
          return api.skills.import(orgId, action.input);
        case "importPicked":
          return api.skills.importPicked(orgId, action.url, action.paths);
        case "create":
          return api.skills.create(orgId, action.input);
        case "update":
          return api.skills.update(orgId, action.id, action.patch);
        case "reimport":
          return api.skills.reimport(orgId, action.id);
        case "remove":
          return api.skills.remove(orgId, action.id);
        case "assign":
          return api.skills.setForAgent(orgId, action.agentId, action.skills);
        case "revert":
          return api.skills.revert?.(orgId, action.id) ?? Promise.resolve();
        case "restore":
          return api.skills.restore?.(orgId, action.id) ?? Promise.resolve();
      }
    },
    // The library and every agent's lists (`keys.skills` is their prefix).
    onSettled: () => qc.invalidateQueries({ queryKey: keys.skills(orgId) }),
  });
}

// ── Agent computer and Run code settings ─────────────────────────────────────

/** The organization's Run code settings (`retry: false`). */
export const useSandboxSettings = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.sandboxSettings(orgId),
    queryFn: () => api.sandbox.settings(orgId),
    enabled,
    retry: false,
  });
};

export function useSaveSandboxSettings(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SandboxSettingsInput) => api.sandbox.saveSettings(orgId, input),
    onSuccess: (saved) => qc.setQueryData(keys.sandboxSettings(orgId), saved),
  });
}

/**
 * "Quem pensa" (its owner or an admin; members don't load it). `pollMs`: asked again this often where no event
 * keeps it current (the onboarding opens no socket).
 */
export const useAgentBrain = (orgId: string, agentId: string, enabled = true, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentBrain(orgId, agentId),
    queryFn: () => api.agents.brain(orgId, agentId),
    enabled,
    retry: false,
    refetchInterval: pollMs,
  });
};

/** "Quem pensa" for an agent still being created ("Criar agente"): the workspace's computers and what each offers. */
export const useBrainMachines = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.brainMachines(orgId),
    queryFn: () => api.agents.brainMachines(orgId),
    retry: false,
  });
};

/** "Criar agente": what a new agent starts thinking with (ADR 0094), for whoever creates agents. */
export const useNewAgentSetup = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.newAgentSetup(orgId),
    queryFn: () => api.agents.newAgentSetup(orgId),
    enabled,
    retry: false,
  });
};

/** "Usar em outros agentes": what the setup would do to each agent, nothing kept; asked again when either changes. */
export const useSetupPreview = (orgId: string, setup: AgentSetup | null, agentIds: readonly string[]) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.setupPreview(orgId, JSON.stringify([setup, agentIds])),
    queryFn: () => api.agents.applySetup(orgId, { setup: setup as AgentSetup, agentIds: [...agentIds], preview: true }),
    enabled: setup !== null && agentIds.length > 0,
    retry: false,
    // Each run walks every agent through its rules: once per opening is enough.
    refetchOnWindowFocus: false,
  });
};

/** "Contas de IA": the viewer's AI accounts on every computer, and where they can add one. */
export const useAiAccounts = (orgId: string, enabled = true, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.aiAccounts(orgId),
    queryFn: () => api.machines.aiAccounts(orgId),
    enabled,
    refetchInterval: pollMs,
  });
};

/**
 * ADR 0041 §2: a sign-in on the computer, asked every 2 s until it ends (done, failed or expired), through failed
 * reads too (`loginRead` says how long they may last).
 */
export const useAccountLogin = (orgId: string, machineId: string, loginId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.accountLogin(orgId, machineId, loginId ?? ""),
    queryFn: async ({ client, queryKey }) => {
      try {
        return await api.machines.accountLogin(orgId, machineId, loginId ?? "");
      } catch (error) {
        if (!loginReadPasses(error)) throw error;
        // The read before this one failed too: the run goes on from its first.
        const before = client.getQueryState(queryKey)?.error;
        throw new LoginReadError(error, before instanceof LoginReadError ? before.since : Date.now());
      }
    },
    enabled: loginId !== null,
    // Waiting from its start. With data, a read keeps the last error until an answer clears it, so a run of failed
    // reads adds up, and the block never drops back to loading meanwhile.
    initialData: loginId === null ? undefined : { state: "waiting" },
    retry: false,
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "waiting" ? false : 2000),
    // The person is on Claude's page in another tab meanwhile.
    refetchIntervalInBackground: true,
  });
};

export const useComputer = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.computer(orgId, agentId),
    queryFn: () => api.sandbox.computer(orgId, agentId),
    enabled,
    retry: false,
    meta: { quiet: true },
  });
};

/** A connected machine for the agent, or none; the computer view follows the answer. */
export function useSetComputerTarget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, machineId }: { agentId: string; machineId: string | null }) =>
      api.sandbox.setTarget(orgId, agentId, machineId),
    meta: { silent: true },
    onSuccess: (target, { agentId }) => {
      qc.setQueryData<AgentComputer>(keys.computer(orgId, agentId), (old) => (old ? { ...old, target } : old));
      void qc.invalidateQueries({ queryKey: keys.computer(orgId, agentId) });
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
    },
  });
}

// ── Connected computers ─────────────────────────────────────────────────────

/** `pollMs`: also refetch this often (while waiting for a new machine to pair); events keep it live otherwise. */
export const useMachines = (orgId: string, enabled = true, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.machines(orgId),
    queryFn: () => api.machines.list(orgId),
    enabled,
    retry: false,
    refetchInterval: pollMs,
    meta: { quiet: true },
  });
};

/**
 * Offline computers that agents wait for, and where they could move. While any is shown it refetches
 * every 30 s (and on focus); `machine.status` / `machine.agents_moved` events refresh it too.
 */
export const useMachineOutages = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.machineOutages(orgId),
    queryFn: () => api.machines.outages(orgId),
    enabled,
    retry: false,
    refetchInterval: (q) => ((q.state.data?.outages.length ?? 0) > 0 ? 30_000 : false),
    refetchOnWindowFocus: true,
    meta: { quiet: true },
  });
};

/**
 * A computer's line (who works on it, who waits, estimates). `computer.queue` events refetch it; while anything
 * waits it also refetches every 30 s, so the estimates keep counting down.
 */
export const useMachineQueue = (orgId: string, machineId: string | null | undefined, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.machineQueue(orgId, machineId ?? ""),
    queryFn: () => api.machines.queue(orgId, machineId ?? ""),
    enabled: enabled && Boolean(machineId),
    retry: false,
    refetchInterval: (q) => ((q.state.data?.waiting.length ?? 0) > 0 ? 30_000 : false),
    meta: { quiet: true },
  });
};

/** "Trocar computador": moves waiting agents off an offline computer; outages, agents, computers and chats follow. */
export function useMoveAgents(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, ...input }: MoveAgentsInput & { machineId: string }) =>
      api.machines.moveAgents(orgId, machineId, input),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      // Every conversation's messages (the waiting cards change).
      void qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "org" &&
          q.queryKey[1] === orgId &&
          q.queryKey[2] === "channel" &&
          q.queryKey[4] === "messages",
      });
    },
  });
}

/** `/conectar?code=`: the computer that made this code (ADR 0036 §5). */
export const useMachineDevice = (userCode: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.machineDevice(userCode),
    queryFn: () => api.machines.device(userCode),
    enabled: enabled && userCode.length > 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { quiet: true },
  });
};

/** "Conectar": the computer joins `orgId`; the list refreshes. */
export function useConfirmDevice() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { orgId: string; userCode: string; name?: string }) =>
      api.machines.confirmDevice(input.orgId, input.userCode, input.name ? { name: input.name } : {}),
    meta: { silent: true },
    onSuccess: (_m, input) => void qc.invalidateQueries({ queryKey: keys.machines(input.orgId) }),
  });
}

/** "Não fui eu". */
export function useDenyDevice() {
  const api = useApi();
  return useMutation({
    mutationFn: (userCode: string) => api.machines.denyDevice(userCode),
    meta: { silent: true },
  });
}

/** The newest desktop app build (`null`: none published, or the server can't read releases). */
export const useDesktopLatest = (target: string, arch: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.desktopLatest(target, arch),
    queryFn: () => api.machines.desktopLatest(target, arch),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    meta: { quiet: true },
  });
};

/** Removes a folder (for everyone or one agent) or turns a tool off; the machine follows. */
export function useReduceMachineAccess(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, ...input }: MachineAccessReduce & { machineId: string }) =>
      api.machines.reduceAccess(orgId, machineId, input),
    meta: { silent: true },
    onSuccess: (access, { machineId }) => {
      qc.setQueryData<Machine[]>(keys.machines(orgId), (list) =>
        list?.map((m) => (m.id === machineId ? { ...m, access } : m)),
      );
    },
  });
}

export function useMachineAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: { machineId: string; action: "rename"; name: string } | { machineId: string; action: "remove" },
    ) =>
      input.action === "rename"
        ? api.machines.rename(orgId, input.machineId, input.name).then(() => undefined)
        : api.machines.remove(orgId, input.machineId),
    meta: { silent: true },
    onSuccess: (_r, input) => {
      qc.setQueryData<Machine[]>(keys.machines(orgId), (list) =>
        input.action === "remove"
          ? list?.filter((m) => m.id !== input.machineId)
          : list?.map((m) => (m.id === input.machineId ? { ...m, name: input.name } : m)),
      );
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      // Agents on a removed machine are left with no computer; a renamed one shows its new name.
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
    },
  });
}

/** The server's own computer in this organization; null when the server has none or doesn't serve it. */
export const useHostComputer = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.hostComputer(orgId),
    queryFn: () => api.machines.host(orgId),
    enabled,
    retry: false,
    meta: { quiet: true },
  });
};

/**
 * The workspace's own computer on its way (ADR 0056 §10): `machine.provisioning` events keep it live in the
 * org shell; `pollMs` where no socket is open (the onboarding), a time or one picked from the last answer.
 */
export const useComputerSetup = (
  orgId: string,
  enabled = true,
  pollMs: number | false | ((setup: ComputerSetup | undefined) => number | false) = false,
) => {
  const api = useApi();
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.computerSetup(orgId),
    queryFn: async () =>
      newerSetup(qc.getQueryData(keys.computerSetup(orgId)), await api.machines.computerSetup(orgId)),
    enabled: enabled && orgId.length > 0,
    retry: false,
    refetchInterval: typeof pollMs === "function" ? (query) => pollMs(query.state.data) : pollMs,
    // Events keep it current; a reconnect asks again (what came while offline is gone).
    staleTime: 5 * 60_000,
    meta: { quiet: true },
  });
};

/** "Usar o computador deste servidor": it comes back in the list and connects at its next sync. */
export function useHostComputerOn(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.machines.hostOn(orgId),
    meta: { silent: true },
    onSuccess: (state) => {
      qc.setQueryData(keys.hostComputer(orgId), state);
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
    },
  });
}

// ── Forum ────────────────────────────────────────────────────────────────────

export const useForumTopics = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.forum(orgId),
    queryFn: () => api.forum.list(orgId),
    enabled,
    staleTime: 15_000,
  });
};

/** A topic with its posts; refreshed every few seconds while the discussion is on (or stalled). */
export const useForumTopic = (orgId: string, topicId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.forumTopic(orgId, topicId ?? ""),
    queryFn: () => api.forum.get(orgId, topicId ?? ""),
    enabled: topicId !== null,
    refetchInterval: (q) => (q.state.data?.status === "open" ? 5000 : false),
    meta: { quiet: true },
  });
};

export type ForumAction =
  | { type: "create"; input: ForumTopicInput }
  | { type: "post"; topicId: string; input: ForumPostInput }
  | { type: "conclude"; topicId: string }
  | { type: "cancel"; topicId: string }
  | { type: "pass"; topicId: string }
  | { type: "resume"; topicId: string }
  | { type: "participants"; topicId: string; input: ForumParticipantsInput }
  | { type: "issues"; topicId: string; items: ForumSuggestedIssue[] }
  | { type: "accept"; messageId: string; overrides?: ForumSuggestionOverrides }
  | { type: "dismiss"; messageId: string };

export function useForumAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: ForumAction): Promise<unknown> => {
      switch (action.type) {
        case "create":
          return api.forum.create(orgId, action.input);
        case "post":
          return api.forum.post(orgId, action.topicId, action.input);
        case "conclude":
          return api.forum.conclude(orgId, action.topicId);
        case "cancel":
          return api.forum.cancel(orgId, action.topicId);
        case "pass":
          return api.forum.pass(orgId, action.topicId);
        case "resume":
          return api.forum.resume(orgId, action.topicId);
        case "participants":
          return api.forum.participants(orgId, action.topicId, action.input);
        case "issues":
          return api.forum.createIssues(orgId, action.topicId, action.items);
        case "accept":
          return api.forum.acceptSuggestion(orgId, action.messageId, action.overrides);
        case "dismiss":
          return api.forum.dismissSuggestion(orgId, action.messageId);
      }
    },
    onSuccess: (result, action) => {
      if (action.type === "accept") {
        const topic = (result as { topic?: ForumTopicDetail }).topic;
        if (topic) qc.setQueryData(keys.forumTopic(orgId, topic.id), topic);
        return;
      }
      if (
        action.type !== "issues" &&
        action.type !== "post" &&
        action.type !== "dismiss" &&
        result &&
        typeof result === "object" &&
        "id" in result
      ) {
        qc.setQueryData(keys.forumTopic(orgId, (result as ForumTopicDetail).id), result);
      }
    },
    onSettled: (_r, _e, action) => {
      void qc.invalidateQueries({ queryKey: keys.forum(orgId) });
      if ("topicId" in action) void qc.invalidateQueries({ queryKey: keys.forumTopic(orgId, action.topicId) });
      if (action.type === "issues") void qc.invalidateQueries({ queryKey: ["org", orgId, "issues"] });
    },
  });
}

// ── Wiki ─────────────────────────────────────────────────────────────────────

/** Every page (titles, folders, tags): the tree, `[[link]]` resolution, ⌘K. */
export const useWikiTree = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiTree(orgId),
    queryFn: () => api.wiki.tree(orgId),
    enabled,
    staleTime: 30_000,
  });
};

export const useWikiPage = (orgId: string, slug: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiPage(orgId, slug ?? ""),
    queryFn: () => api.wiki.get(orgId, slug ?? ""),
    enabled: slug !== null && slug !== "",
    retry: false,
  });
};

export const useWikiHistory = (orgId: string, slug: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiHistory(orgId, slug),
    queryFn: () => api.wiki.history(orgId, slug),
    enabled,
  });
};

export const useWikiGraph = (orgId: string, enabled: boolean) => {
  const api = useApi();
  return useQuery({ queryKey: keys.wikiGraph(orgId), queryFn: () => api.wiki.graph(orgId), enabled });
};

/** What the agents read most in the last 7 days (the wiki's home). */
export const useWikiReads = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.wikiReads(orgId),
    queryFn: () => api.wiki.reads(orgId),
    enabled,
    staleTime: 60_000,
  });
};

export function useWikiAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (
      action:
        | { type: "create"; input: WikiPageInput }
        | { type: "update"; slug: string; input: WikiUpdateInput }
        | { type: "rename"; slug: string; title: string }
        | { type: "move"; slug: string; folder: string }
        | { type: "lock"; slug: string; locked: boolean }
        | { type: "pin"; slug: string; pinned: boolean }
        | { type: "audience"; slug: string; access: WikiAccess }
        | {
            type: "append";
            slug: string;
            text: string;
            source: { kind: "message"; channelId: string; messageId: string } | { kind: "forum"; topicId: string };
          },
    ): Promise<WikiPage> => {
      switch (action.type) {
        case "create":
          return api.wiki.create(orgId, action.input);
        case "update":
          return api.wiki.update(orgId, action.slug, action.input);
        case "rename":
          return api.wiki.rename(orgId, action.slug, action.title);
        case "move":
          return api.wiki.move(orgId, action.slug, action.folder);
        case "lock":
          return api.wiki.lock(orgId, action.slug, action.locked);
        case "pin":
          return api.wiki.pin(orgId, action.slug, action.pinned);
        case "audience":
          return api.wiki.audience(orgId, action.slug, action.access);
        case "append":
          return api.wiki.append(orgId, action.slug, { text: action.text, source: action.source });
      }
    },
    onSuccess: (page) => {
      qc.setQueryData(keys.wikiPage(orgId, page.slug), page);
      void qc.invalidateQueries({ queryKey: keys.wiki(orgId) });
    },
  });
}

/** A wiki folder's audience and the closest limited folder above it. */
export function useWikiFolderAudience(orgId: string, folder: string, enabled = true) {
  const api = useApi();
  return useQuery({
    enabled,
    queryKey: [...keys.wiki(orgId), "folder-audience", folder],
    queryFn: () => api.wiki.folderAudience(orgId, folder),
  });
}

/** Saves a folder's audience: it reaches its pages, so everything in the wiki is read again. */
export function useSetWikiFolderAudience(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { folder: string; access: WikiAccess }) =>
      api.wiki.setFolderAudience(orgId, input.folder, input.access),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.wiki(orgId) });
    },
  });
}

// ── Threads (ADR 0029) ──────────────────────────────────────────────────────

/** The Threads page: one page per cursor, most recent activity first. */
export function useThreadList(orgId: string, filters: ThreadFilters, enabled = true) {
  const api = useApi();
  return useInfiniteQuery({
    enabled,
    queryKey: keys.threadList(orgId, filters),
    queryFn: ({ pageParam }) => api.threads.list(orgId, { ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
}

/** A channel's threads (its "Threads (N)", closed lines and context marks). One page of 100. */
export const channelThreadsQuery = (api: ApiClient, orgId: string, channelId: string, tab: "all" | "archived") =>
  queryOptions({
    queryKey: keys.channelThreads(orgId, channelId, tab),
    queryFn: () => api.threads.inChannel(orgId, channelId, { tab, limit: 100 }),
    staleTime: 30_000,
  });

export function useChannelThreads(orgId: string, channelId: string, tab: "all" | "archived", enabled = true) {
  const api = useApi();
  return useQuery({ ...channelThreadsQuery(api, orgId, channelId, tab), enabled });
}

export function useThreadInfo(orgId: string, threadId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.threadInfo(orgId, threadId ?? ""),
    queryFn: () => api.threads.get(orgId, threadId ?? ""),
    enabled: Boolean(threadId),
    staleTime: 15_000,
  });
}

/** A thread's root and replies (the same cache the channel uses for agent replies). */
export function useThreadMessages(orgId: string, channelId: string | undefined, rootId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.thread(orgId, channelId ?? "", rootId),
    queryFn: () => api.chat.messages(orgId, channelId ?? "", { threadId: rootId, limit: THREAD_PAGE }),
    enabled: Boolean(channelId),
    staleTime: 30_000,
  });
}

/** How far back the context block looks for the start of a range (pages of 200). */
const RANGE_PAGES = 5;

/**
 * The messages of a thread's context range, oldest first. Not moved: the
 * context channel's top-level messages from the first to the last, minus the
 * excluded ones. Moved: they are replies of the root now, written before it
 * (real replies always come after the root, which is made after the range).
 */
export async function loadThreadRange(api: ApiClient, orgId: string, thread: ThreadInfo): Promise<Message[]> {
  const ctx = thread.context;
  if (!ctx) return [];
  if (ctx.moved) {
    const all = await api.chat.messages(orgId, thread.channelId, { threadId: thread.id, limit: 200 });
    return all.filter((m) => m.id !== thread.id && m.createdAt < thread.createdAt);
  }
  let list = await api.chat.messages(orgId, ctx.channelId, { limit: 200 });
  for (let page = 1; page < RANGE_PAGES && !list.some((m) => m.id === ctx.firstMessageId); page++) {
    const oldest = list[0];
    if (!oldest) break;
    const older = await api.chat.messages(orgId, ctx.channelId, { before: oldest.createdAt, limit: 200 });
    if (older.length === 0) break;
    list = [...older, ...list];
  }
  const from = list.findIndex((m) => m.id === ctx.firstMessageId);
  const to = list.findIndex((m) => m.id === ctx.lastMessageId);
  if (from < 0 || to < from) return [];
  const excluded = new Set(ctx.excludedMessageIds);
  return list.slice(from, to + 1).filter((m) => !excluded.has(m.id) && m.id !== thread.id && !m.meta?.threadStart);
}

export function useThreadRange(orgId: string, thread: ThreadInfo | undefined, enabled = true) {
  const api = useApi();
  const ctx = thread?.context;
  return useQuery({
    queryKey: [
      ...keys.threadRange(orgId, thread?.id ?? ""),
      ctx?.firstMessageId,
      ctx?.lastMessageId,
      ctx?.excludedMessageIds.length,
      ctx?.moved,
    ],
    queryFn: () => (thread ? loadThreadRange(api, orgId, thread) : Promise.resolve([])),
    enabled: Boolean(enabled && thread?.context),
    staleTime: 30_000,
  });
}

/** After a change: lists, the thread, and both conversations (markers, moved messages). */
function refreshThread(qc: ReturnType<typeof useQueryClient>, orgId: string, thread: ThreadInfo, gone = false) {
  if (gone) qc.removeQueries({ queryKey: keys.threadInfo(orgId, thread.id) });
  else qc.setQueryData(keys.threadInfo(orgId, thread.id), thread);
  void qc.invalidateQueries({ queryKey: keys.threads(orgId), predicate: (q) => q.queryKey[3] !== "one" });
  for (const channelId of new Set([thread.channelId, thread.context?.channelId].filter(Boolean) as string[])) {
    void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
  }
}

export function useCreateThread(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: ThreadCreateInput) => api.threads.create(orgId, input),
    onSuccess: (thread) => refreshThread(qc, orgId, thread),
  });
}

/**
 * Every change to one thread: rename or adjust (`update`), the actions
 * (move, return, close, reopen, archive, unarchive) and undoing a new one
 * (`delete`). Errors are the caller's to say (translated by code).
 */
export function useThreadMutation(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: async (
      change:
        | { type: "update"; thread: ThreadInfo; patch: ThreadPatch }
        | { type: "action"; thread: ThreadInfo; action: ThreadAction }
        | { type: "delete"; thread: ThreadInfo },
    ): Promise<ThreadInfo | null> => {
      if (change.type === "update") return api.threads.update(orgId, change.thread.id, change.patch);
      if (change.type === "action") return api.threads.act(orgId, change.thread.id, change.action);
      await api.threads.remove(orgId, change.thread.id);
      return null;
    },
    // The view a change came back with (its `canManage` is ours); a deleted thread leaves the cache.
    onSuccess: (thread, change) => refreshThread(qc, orgId, thread ?? change.thread, change.type === "delete"),
  });
}

// ── Notifications ────────────────────────────────────────────────────────────

type QC = ReturnType<typeof useQueryClient>;

/** One filter's list (pages of 50), with the counts of every filter on the first page. */
export function useNotifications(orgId: string, filter: NotificationFilter) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.notificationList(orgId, filter),
    queryFn: ({ pageParam }) =>
      api.notifications.list(orgId, { filter, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

/** The badge on the bell: unread (and how many wait on me). Live via `notification.counts`. */
export const useNotificationCount = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.notificationCount(orgId),
    queryFn: () => api.notifications.count(orgId),
    staleTime: 60_000,
    meta: { quiet: true },
  });
};

/** What reaches my devices as a notification in this workspace (ADR 0071 §8). */
export const useNoticePrefs = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: keys.noticePrefs(orgId), queryFn: () => api.notifications.prefs(orgId) });
};

/** One category on or off: the switch moves at once, and goes back if the server refuses. */
export function useSetNoticePref(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ category, on }: { category: NoticeCategory; on: boolean }) =>
      api.notifications.setPref(orgId, category, on),
    onMutate: async ({ category, on }) => {
      await qc.cancelQueries({ queryKey: keys.noticePrefs(orgId) });
      const before = qc.getQueryData<NoticePrefs>(keys.noticePrefs(orgId));
      qc.setQueryData<NoticePrefs>(keys.noticePrefs(orgId), (prefs) =>
        prefs ? { ...prefs, categories: prefs.categories.map((c) => (c.id === category ? { ...c, on } : c)) } : prefs,
      );
      return { before };
    },
    onError: (_error, _input, context) => qc.setQueryData(keys.noticePrefs(orgId), context?.before),
    onSuccess: (prefs) => qc.setQueryData(keys.noticePrefs(orgId), prefs),
  });
}

/** Where I put the tools at the top of my sidebar in this workspace (only the ones I moved). */
export const useSidebarItems = (orgId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.sidebarItems(orgId),
    queryFn: () => api.orgs.sidebarItems(orgId),
    staleTime: 60_000,
  });
};

/**
 * Moves one tool, or with `null` puts every tool back on its default: the sidebar changes at once and goes back if the
 * server refuses. The server keeps my other choices as it has them, so one made on another device stays, and answers
 * with every choice it keeps. The requests go one at a time, so the last answer is what stays (`onMutate` still runs
 * at once for one that waits its turn).
 */
export function useSetSidebarItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const mutationKey = ["sidebar-items", orgId];
  return useMutation({
    mutationKey,
    scope: { id: `sidebar-items:${orgId}` },
    mutationFn: (move: { item: SidebarItem; place: SidebarPlace } | null) =>
      move
        ? api.orgs.setSidebarItem(orgId, move.item, move.place === SIDEBAR_DEFAULTS[move.item] ? null : move.place)
        : api.orgs.setSidebarItems(orgId, {}),
    onMutate: async (move) => {
      await qc.cancelQueries({ queryKey: keys.sidebarItems(orgId) });
      const before = qc.getQueryData<SidebarItems>(keys.sidebarItems(orgId));
      qc.setQueryData<SidebarItems>(keys.sidebarItems(orgId), (items) =>
        move ? withSidebarPlace(items, move.item, move.place) : {},
      );
      return { before };
    },
    onError: (_error, _move, context) => {
      // A later choice still on its way answers with every choice the server keeps: its answer decides.
      if (qc.isMutating({ mutationKey }) > 1) return;
      qc.setQueryData(keys.sidebarItems(orgId), context?.before);
      // `before` can hold an earlier choice the server refused as well: it says what stays.
      void qc.invalidateQueries({ queryKey: keys.sidebarItems(orgId) });
    },
    // A later choice still on its way keeps the screen until its own answer.
    onSuccess: (items) => {
      if (qc.isMutating({ mutationKey }) <= 1) qc.setQueryData(keys.sidebarItems(orgId), items);
    },
  });
}

/** The sidebar's sections in my order in this workspace (the default until it loads). */
export const useSidebarOrder = (orgId: string): SidebarSection[] => {
  const api = useApi();
  return (
    useQuery({
      queryKey: keys.sidebarOrder(orgId),
      queryFn: () => api.orgs.sidebarOrder(orgId),
      staleTime: 60_000,
    }).data ?? [...SIDEBAR_SECTIONS]
  );
};

/** Saves my section order (`null`: the default): the sidebar changes at once and goes back if the server refuses. */
export function useSetSidebarOrder(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `sidebar-order:${orgId}` },
    mutationFn: (order: SidebarSection[] | null) => api.orgs.setSidebarOrder(orgId, order),
    onMutate: async (order) => {
      await qc.cancelQueries({ queryKey: keys.sidebarOrder(orgId) });
      const before = qc.getQueryData<SidebarSection[]>(keys.sidebarOrder(orgId));
      qc.setQueryData<SidebarSection[]>(keys.sidebarOrder(orgId), order ?? [...SIDEBAR_SECTIONS]);
      return { before };
    },
    onError: (_error, _order, context) => qc.setQueryData(keys.sidebarOrder(orgId), context?.before),
    onSuccess: (order) => qc.setQueryData(keys.sidebarOrder(orgId), order),
  });
}

const listCaches = (qc: QC, orgId: string) =>
  qc.getQueriesData<NotificationPages>({ queryKey: [...keys.notifications(orgId), "list"] });

const knownNotification = (qc: QC, orgId: string, id: string) => {
  for (const [, data] of listCaches(qc, orgId)) {
    const hit = allItems(data).find((n) => n.id === id);
    if (hit) return hit;
  }
  return undefined;
};

/** The badge follows one item's change (read, done, snoozed, new) until the server's numbers arrive. */
function moveCount(qc: QC, orgId: string, before: AppNotification | undefined, after: AppNotification | undefined) {
  const delta = (f: "unread" | "waiting") =>
    (after && matchesFilter(after, f) ? 1 : 0) - (before && matchesFilter(before, f) ? 1 : 0);
  qc.setQueryData<NotificationCount>(keys.notificationCount(orgId), (c) =>
    c ? { unread: Math.max(0, c.unread + delta("unread")), waiting: Math.max(0, c.waiting + delta("waiting")) } : c,
  );
}

/** A fresh notification (event, server answer or my optimistic change) in every loaded list and the badge. */
export function cacheNotification(qc: QC, orgId: string, item: AppNotification) {
  const before = knownNotification(qc, orgId, item.id);
  for (const [key, data] of listCaches(qc, orgId)) {
    if (!data) continue;
    const filter = key[4] as NotificationFilter;
    qc.setQueryData<NotificationPages>(key, upsertInPages(data, filter, item, before));
  }
  moveCount(qc, orgId, before, item);
}

/** Resolved on its own (question answered, approval decided, turn passed): out of every list. */
/**
 * Takes a notification out of every list. `keepDone`: the `notification.removed` event says only that it left the
 * inbox, so "Concluídas" keeps it; a drop the page asks for (answered, passed) takes it from there too.
 */
export function dropNotification(qc: QC, orgId: string, id: string, keepDone = false) {
  const before = knownNotification(qc, orgId, id);
  for (const [key, data] of listCaches(qc, orgId)) {
    if (data && !(keepDone && key[4] === "done"))
      qc.setQueryData<NotificationPages>(key, removeFromPages(data, id, before));
  }
  moveCount(qc, orgId, before, undefined);
}

/** `notification.upserted` / `removed` / `counts` (user scope). */
export function applyNotificationEvent(qc: QC, orgId: string, event: NotificationEvent) {
  if (event.type === "notification.upserted" && event.notification.kind === "join_request")
    void qc.invalidateQueries({ queryKey: keys.joinRequests(orgId) });
  if (event.type === "notification.upserted") cacheNotification(qc, orgId, event.notification);
  else if (event.type === "notification.removed") {
    dropNotification(qc, orgId, event.id, true);
    // Marked done on another device: "Concluídas" gains it (one auto-resolved changes nothing there).
    void qc.invalidateQueries({ queryKey: keys.notificationList(orgId, "done") });
  } else {
    const count = { unread: event.unread, waiting: event.waiting };
    qc.setQueryData<NotificationCount>(keys.notificationCount(orgId), count);
    for (const [key, data] of listCaches(qc, orgId))
      if (data) qc.setQueryData<NotificationPages>(key, withServerCounts(data, count.unread, count.waiting));
  }
}

export const isNotificationEvent = (e: { type: string }): e is NotificationEvent =>
  e.type === "notification.upserted" || e.type === "notification.removed" || e.type === "notification.counts";

export type NotificationAction =
  | { type: "read"; item: AppNotification; read: boolean }
  | { type: "done"; item: AppNotification; done: boolean }
  /** `until: null` undoes a snooze ("Desfazer"). */
  | { type: "snooze"; item: AppNotification; until: string | null }
  | { type: "readAll"; filter: NotificationFilter }
  /** Undo of "Marcar tudo como lido": the ids it changed. */
  | { type: "unreadMany"; ids: string[] };

/** The changed items as the server sent them, and the ids "Marcar tudo como lido" touched. */
export interface NotificationActionResult {
  items: AppNotification[];
  ids: string[];
}

/** What an action does to the items we have, for the optimistic copy. */
function optimistic(qc: QC, orgId: string, action: NotificationAction, now: string): AppNotification[] {
  switch (action.type) {
    case "read":
      return [{ ...action.item, readAt: action.read ? (action.item.readAt ?? now) : null }];
    case "done":
      return [{ ...action.item, doneAt: action.done ? now : null }];
    case "snooze":
      return [{ ...action.item, snoozedUntil: action.until }];
    case "readAll": {
      const loaded = allItems(qc.getQueryData<NotificationPages>(keys.notificationList(orgId, action.filter)));
      return loaded.filter((n) => n.readAt === null).map((n) => ({ ...n, readAt: now }));
    }
    case "unreadMany":
      return action.ids.flatMap((id) => {
        const known = knownNotification(qc, orgId, id);
        return known ? [{ ...known, readAt: null }] : [];
      });
  }
}

/**
 * Read, Feito, Lembrar depois, Marcar tudo como lido (and their undo): the
 * lists and the badge change at once; a refusal puts them back.
 */
export function useNotificationAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: NotificationAction): Promise<NotificationActionResult> => {
      switch (action.type) {
        case "read":
          return { items: [await api.notifications.read(orgId, action.item.id, action.read)], ids: [action.item.id] };
        case "done":
          return { items: [await api.notifications.done(orgId, action.item.id, action.done)], ids: [action.item.id] };
        case "snooze":
          return {
            items: [await api.notifications.snooze(orgId, action.item.id, action.until)],
            ids: [action.item.id],
          };
        case "readAll":
          return { items: [], ids: (await api.notifications.readAll(orgId, action.filter)).ids };
        case "unreadMany":
          return {
            items: await Promise.all(action.ids.map((id) => api.notifications.read(orgId, id, false))),
            ids: action.ids,
          };
      }
    },
    onMutate: async (action) => {
      await qc.cancelQueries({ queryKey: keys.notifications(orgId) });
      const lists = listCaches(qc, orgId);
      const count = qc.getQueryData<NotificationCount>(keys.notificationCount(orgId));
      for (const item of optimistic(qc, orgId, action, new Date().toISOString())) cacheNotification(qc, orgId, item);
      return { lists, count };
    },
    onError: (_error, _action, ctx) => {
      if (!ctx) return;
      for (const [key, data] of ctx.lists) qc.setQueryData(key, data);
      qc.setQueryData(keys.notificationCount(orgId), ctx.count);
    },
    onSuccess: (result) => {
      for (const item of result.items) cacheNotification(qc, orgId, item);
    },
    onSettled: (_r, _e, action) => {
      void qc.invalidateQueries({ queryKey: keys.notificationCount(orgId) });
      // Marking everything read touches items beyond the loaded pages.
      if (action.type === "readAll" || action.type === "unreadMany")
        void qc.invalidateQueries({ queryKey: [...keys.notifications(orgId), "list"] });
    },
  });
}

/**
 * "Responder" in the inbox, through the endpoints that already exist: a
 * message (channel, thread or DM), an issue comment, an answer to an agent's
 * question, or my turn at the forum table.
 */
export function useNotificationReply(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, text, choice }: { target: ReplyTarget; text: string; choice?: boolean }) => {
      switch (target.kind) {
        case "message": {
          const message = await api.chat.post(orgId, target.channelId, {
            body: text,
            clientId: newClientId(),
            ...(target.threadId ? { threadId: target.threadId } : {}),
          });
          cacheMessage(qc, orgId, message);
          return { kind: "message" as const, message };
        }
        case "issue":
          await api.issues.comment(orgId, target.issueId, text);
          void qc.invalidateQueries({ queryKey: keys.issueActivity(orgId, target.issueId) });
          void qc.invalidateQueries({ queryKey: keys.issues(orgId) });
          return { kind: "issue" as const };
        case "question":
          return {
            kind: "question" as const,
            question: await api.questions.answer(orgId, target.questionId, choice ? { choice: text } : { text }),
          };
        case "forum":
          await api.forum.post(orgId, target.topicId, { body: text });
          void qc.invalidateQueries({ queryKey: keys.forumTopic(orgId, target.topicId) });
          void qc.invalidateQueries({ queryKey: keys.forum(orgId), exact: true });
          return { kind: "forum" as const };
      }
    },
  });
}

// ── Phone app: read state, pins, following, working now, reminders ─────────────

/** The optional parts of the client (`ApiClient.pins`…): throws when this client lacks one. */
function part<K extends "pins" | "threadFollows" | "working" | "reminders" | "actions" | "agentForYou" | "gifs">(
  api: ApiClient,
  name: K,
): NonNullable<ApiClient[K]> {
  const value = api[name];
  if (!value) throw new Error(`This API client has no ${name}`);
  return value as NonNullable<ApiClient[K]>;
}

/** Marks a channel or DM read now; the channel and DM lists show it with no unread at once. */
export function useMarkChannelRead(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (channelId: string) => api.dms.markRead(orgId, channelId),
    onMutate: (channelId) => {
      qc.setQueryData<Channel[]>(keys.channels(orgId), (list) =>
        list?.map((c) => (c.id === channelId ? { ...c, unreadCount: 0 } : c)),
      );
      qc.setQueryData<DirectMessage[]>(keys.dms(orgId), (list) =>
        list?.map((d) => (d.channelId === channelId ? { ...d, unread: 0 } : d)),
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
    },
  });
}

/** A channel's pinned messages, newest pin first (live: `message.pinned` / `message.unpinned`). */
export function usePins(orgId: string, channelId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.pins(orgId, channelId),
    queryFn: () => part(api, "pins").list(orgId, channelId),
    enabled: enabled && Boolean(api.pins),
    staleTime: 30_000,
  });
}

/** Pin or unpin a message; refreshes the pins and the conversation (its `pinned` marks). */
export function usePinMessage(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ channelId, messageId, pinned }: { channelId: string; messageId: string; pinned: boolean }) => {
      const pins = part(api, "pins");
      if (pinned) await pins.pin(orgId, channelId, messageId);
      else await pins.unpin(orgId, channelId, messageId);
    },
    onSuccess: (_v, { channelId }) => {
      void qc.invalidateQueries({ queryKey: keys.pins(orgId, channelId) });
      void qc.invalidateQueries({ queryKey: keys.messages(orgId, channelId) });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId, "thread"] });
    },
  });
}

/** Follow or unfollow a thread; the thread views and the channel list (unread) follow. */
export function useFollowThread(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, following }: { threadId: string; following: boolean }) => {
      const follows = part(api, "threadFollows");
      return following ? follows.follow(orgId, threadId) : follows.unfollow(orgId, threadId);
    },
    onSuccess: (result) => {
      qc.setQueryData<ThreadInfo>(keys.threadInfo(orgId, result.threadId), (t) =>
        t ? { ...t, following: result.following } : t,
      );
      void qc.invalidateQueries({ queryKey: keys.threads(orgId), predicate: (q) => q.queryKey[3] !== "one" });
      void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
    },
  });
}

/**
 * "Trabalhando agora": agent runs in progress where you are (refetch on `agent.run` / `run.finished`). `pollMs`: asked
 * again this often where no channel's events reach (Início).
 */
export function useWorkingRuns(orgId: string, enabled = true, pollMs: number | false = false) {
  const api = useApi();
  return useQuery({
    queryKey: keys.working(orgId),
    queryFn: () => part(api, "working").list(orgId),
    enabled: enabled && Boolean(api.working),
    staleTime: 10_000,
    refetchInterval: pollMs,
  });
}

/** Your pending reminders, soonest first. */
export function useReminders(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.reminders(orgId),
    queryFn: () => part(api, "reminders").list(orgId),
    enabled: enabled && Boolean(api.reminders),
    staleTime: 30_000,
  });
}

/** "Lembrar" (create) and cancel. Errors are the caller's to say (translated by code). */
export function useReminderAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (action: { type: "create"; input: ReminderInput } | { type: "cancel"; id: string }) => {
      const reminders = part(api, "reminders");
      return action.type === "create" ? reminders.create(orgId, action.input) : reminders.cancel(orgId, action.id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.reminders(orgId) });
      void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
    },
  });
}

// ── GIFs (ADR 0091) ─────────────────────────────────────────────────────────

/** What a search box holds, once it has been still for `ms` (at once when it is emptied). */
export function useSettled(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), value.trim() ? ms : 0);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

/**
 * The picker's GIF search, a page at a time (`fetchNextPage` while `hasNextPage`): free text, a category, or
 * neither (what is trending), in the person's language (`lang`, two letters). Off while `enabled` is false or this
 * client has no GIF search. A search is kept a few minutes: going back to a chip shows it at once.
 */
export function useGifSearch(
  orgId: string,
  search: { q: string; category: GifCategory | null; lang: string },
  enabled = true,
) {
  const api = useApi();
  const q = search.q.trim();
  // Free text wins: a chip only searches with an empty box.
  const category = q ? null : search.category;
  return useInfiniteQuery({
    queryKey: keys.gifSearch(orgId, q, category, search.lang),
    queryFn: ({ pageParam }) =>
      part(api, "gifs").search(orgId, {
        ...(q ? { q } : {}),
        ...(category ? { category } : {}),
        offset: pageParam,
        limit: GIF_PAGE,
        lang: search.lang,
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: enabled && Boolean(api.gifs),
    staleTime: 5 * 60_000,
    // The words already on screen stay while the next search loads (no flash of the empty state).
    placeholderData: (prev) => prev,
  });
}

// ── Databases (ADR 0039) ────────────────────────────────────────────────────

/** The organization's databases (no passwords), with the agents that read each. */
export const useDatabases = (orgId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.databaseList(orgId),
    queryFn: () => api.databases.list(orgId),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
};

/** A database's tables (the rules' table picker). */
export const useDatabaseTables = (orgId: string, connectionId: string | null) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.databaseTables(orgId, connectionId ?? ""),
    queryFn: () => api.databases.tables(orgId, connectionId ?? ""),
    enabled: Boolean(connectionId),
    staleTime: 5 * 60_000,
    retry: false,
  });
};

/** An agent's access and rules per database. */
export const useAgentDatabases = (orgId: string, agentId: string, enabled = true) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDatabases(orgId, agentId),
    queryFn: () => api.databases.agent(orgId, agentId),
    enabled,
    retry: false,
  });
};

/** Connect, rename or reconnect, and disconnect a database; each refreshes every database read. */
export function useDatabaseAction(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: keys.databases(orgId) });
  return {
    connect: useMutation({
      mutationFn: (input: DatabaseConnectionInput) => api.databases.connect(orgId, input),
      onSuccess: done,
      // The form says why (wrong password, server not reachable…).
      meta: { silent: true },
    }),
    update: useMutation({
      mutationFn: ({
        connectionId,
        ...input
      }: DatabaseConnectionInput & { connectionId: string; offActions?: DatabaseActionName[] }) =>
        api.databases.update(orgId, connectionId, input),
      onSuccess: done,
      meta: { silent: true },
    }),
    disconnect: useMutation({
      mutationFn: (connectionId: string) => api.databases.disconnect(orgId, connectionId),
      onSuccess: done,
    }),
  };
}

/** Saves an agent's access and rules for one database. */
export function useSetAgentDatabase(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      connectionId,
      input,
    }: {
      agentId: string;
      connectionId: string;
      input: AgentDatabaseInput;
    }) => api.databases.setAgent(orgId, agentId, connectionId, input),
    meta: { silent: true },
    onSuccess: (saved, { agentId }) => {
      qc.setQueryData<AgentDatabase[]>(keys.agentDatabases(orgId, agentId), (list) =>
        list ? list.map((d) => (d.connectionId === saved.connectionId ? saved : d)) : list,
      );
      void qc.invalidateQueries({ queryKey: keys.databaseList(orgId) });
      void qc.invalidateQueries({ queryKey: keys.scopes(orgId, agentId) });
    },
  });
}

/** `/autorizar?req=`: the app asking and the workspaces it could get (ADR 0119). Asked once: it answers once. */
export const useAppConsent = (requestId: string) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.appConsent(requestId),
    queryFn: () => api.apps.consent(requestId),
    enabled: requestId.length > 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    meta: { quiet: true },
  });
};

/** Permitir or Cancelar on the consent page; the page goes to `redirectTo` once. */
export function useDecideAppConsent(requestId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AppConsentDecision) => api.apps.decide(requestId, input),
    meta: { silent: true },
    onSuccess: (_r, input) => {
      if (input.orgId) void qc.invalidateQueries({ queryKey: ["org", input.orgId, "apps"] });
    },
  });
}

/** Settings → AI apps. `pollMs`: also refetch this often (while waiting for an app to connect). */
export const useApps = (orgId: string, all = false, pollMs: number | false = false) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.apps(orgId, all),
    queryFn: () => api.apps.list(orgId, all),
    refetchInterval: pollMs,
  });
};

/** Desconectar an app, Revogar a token, Criar token: both lists refresh. */
export function useAppActions(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["org", orgId, "apps"] });
  return {
    disconnect: useMutation({ mutationFn: (grantId: string) => api.apps.disconnect(orgId, grantId), onSuccess: done }),
    revokeToken: useMutation({
      mutationFn: (grantId: string) => api.apps.revokeToken(orgId, grantId),
      onSuccess: done,
    }),
    createToken: useMutation({
      mutationFn: (input: PersonalTokenInput) => api.apps.createToken(orgId, input),
      meta: { silent: true },
      onSuccess: done,
    }),
  };
}
