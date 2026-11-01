import type { Agent, AgentAudience, AudienceMode } from "@agenteschat/client";
import { useAgents, useAiStatus, useRoles } from "@agenteschat/client";
import { audienceChip } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, onlyOwnerReplies } from "@agenteschat/client/lib/no-ai";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  Avatar,
  Checkbox,
  Chip,
  fold,
  Icon,
  type IconName,
  InfoHint,
  OptionList,
  RadioCard,
  RadioGroup,
  RoleMark,
  SearchField,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** A picture per choice: the whole workspace, the people you pick, only the person responsible. */
const AUDIENCE_ICON: Record<AudienceMode, IconName> = {
  everyone: "audienceEveryone",
  people: "audiencePeople",
  owner: "audienceOwner",
};

const MODES: AudienceMode[] = ["everyone", "people", "owner"];

/**
 * "Seus agentes só atendem você.", before inviting anyone (setup's Team step, Members' invite card): every agent
 * with an AI is the viewer's and answers only them, so whoever joins now gets no answer. Nothing otherwise.
 */
export function OnlyYouNote({ orgId, viewerId }: { orgId: string; viewerId: string }) {
  const { t } = useTranslation();
  const agents = useAgents(orgId);
  const status = useAiStatus(orgId);
  const thinks = (id: string) => (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  if (!onlyOwnerReplies(agents.data ?? [], thinks, viewerId)) return null;
  return (
    <p className="setup-line ac-iconline">
      <Icon name="audienceOwner" size={14} />
      <span>
        {t("members.agentsOnlyYou")}{" "}
        <InfoHint name={t("common.about", { label: t("members.agentsOnlyYou") })}>
          {t("members.agentsOnlyYouHint")}
        </InfoHint>
      </span>
    </p>
  );
}

/** Chip "Pessoal" / "Restrito" next to the agent's name (nothing when everyone can talk to it). */
export function AudienceChip({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const label = audienceChip(t, agent);
  if (!label) return null;
  return (
    <Chip icon="lock" className="audience-chip">
      {label}
    </Chip>
  );
}

/**
 * The three choices (Todos do workspace / Só algumas pessoas ou papéis / Só o
 * responsável), with the roles and people picker under the second.
 * `compact`: a segmented control and one line about the choice ("Criar agente").
 */
export function AudienceChoice({
  value,
  onChange,
  ownerUserId,
  agentName,
  idPrefix,
  compact,
}: {
  value: AgentAudience;
  onChange: (next: AgentAudience) => void;
  ownerUserId: string | null;
  agentName: string;
  idPrefix: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const g = agentGrammar(t, agentName);
  const owner = ownerUserId ? dir.memberById.get(ownerUserId) : undefined;
  const roles = useRoles(org.id);
  const [query, setQuery] = useState("");
  const picked = new Set(value.userIds);
  const pickedRoles = new Set(value.roleIds ?? []);
  const candidates = dir.members.filter((m) => m.userId !== ownerUserId);
  // `everyone` ("Todos") is the first choice, not a role to pick.
  const roleCandidates = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const q = fold(query.trim());
  const rows = candidates.filter((m) => !q || fold(`${m.name} ${m.email} ${m.handle}`).includes(q));
  const roleRows = roleCandidates.filter((r) => !q || fold(r.name).includes(q));
  const toggle = (key: "userIds" | "roleIds", id: string, on: boolean) => {
    const next = new Set(value[key] ?? []);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ ...value, [key]: [...next] });
  };
  const modeText = (mode: AudienceMode) =>
    mode === "owner"
      ? owner
        ? t("audience.modeText.owner", { ...g, owner: owner.name })
        : t("audience.modeText.noOwner")
      : t(`audience.modeText.${mode}`, g);
  return (
    <div className="stack-4" style={{ gap: 12 }}>
      {compact ? (
        <>
          <OptionList
            aria-label={t("audience.title", g)}
            layout="cards"
            value={value.mode}
            onValueChange={(mode) => onChange({ ...value, mode })}
            options={MODES.map((mode) => ({
              value: mode,
              leading: (
                <span className="audience-card__icon">
                  <Icon name={AUDIENCE_ICON[mode]} size={20} />
                </span>
              ),
              title: t(`audience.mode.${mode}`),
              description: modeText(mode),
            }))}
          />
          {value.mode !== "everyone" && <span className="small muted">{t("audience.notListed")}</span>}
        </>
      ) : (
        <RadioGroup
          value={value.mode}
          onValueChange={(mode) => onChange({ ...value, mode: mode as AudienceMode })}
          aria-label={t("audience.title", g)}
          className="stack-4"
          style={{ gap: 8 }}
        >
          {MODES.map((mode) => (
            <RadioCard
              key={mode}
              value={mode}
              id={`${idPrefix}-${mode}`}
              checked={value.mode === mode}
              disabled={mode === "owner" && !ownerUserId}
              title={t(`audience.mode.${mode}`)}
              description={modeText(mode)}
            />
          ))}
        </RadioGroup>
      )}
      {value.mode === "people" && (
        <div className="people-picker">
          {owner && <span className="small muted">{t("audience.ownerAlways", { name: owner.name })}</span>}
          {(picked.size > 0 || pickedRoles.size > 0) && (
            <TokenList label={t("audience.picked")}>
              {roleCandidates
                .filter((r) => pickedRoles.has(r.id))
                .map((r) => (
                  <li key={r.id}>
                    <Token
                      leading={<RoleMark color={r.color} icon={r.icon} size={18} />}
                      removeLabel={t("common.removeName", { name: r.name })}
                      onRemove={() => toggle("roleIds", r.id, false)}
                    >
                      {r.name}
                    </Token>
                  </li>
                ))}
              {candidates
                .filter((m) => picked.has(m.userId))
                .map((m) => (
                  <li key={m.userId}>
                    <Token
                      leading={<Avatar kind="person" size="xs" name={m.name} imageUrl={m.image} />}
                      removeLabel={t("common.removeName", { name: m.name })}
                      onRemove={() => toggle("userIds", m.userId, false)}
                    >
                      {m.name}
                    </Token>
                  </li>
                ))}
            </TokenList>
          )}
          <SearchField
            size="sm"
            aria-label={t("audience.search")}
            placeholder={t("audience.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            clearLabel={t("filters.clearSearch")}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
          <div className="people-picker__results" role="region" aria-label={t("audience.search")}>
            {rows.length === 0 && roleRows.length === 0 ? (
              <p className="small muted">{t("audience.noMatch")}</p>
            ) : (
              <>
                {roleRows.length > 0 && (
                  <>
                    <span className="ac-field__label">{t("audience.roles")}</span>
                    <span className="small muted">{t("audience.rolesHint")}</span>
                    {roleRows.map((r) => {
                      const id = `${idPrefix}-r-${r.id}`;
                      return (
                        <label key={r.id} htmlFor={id} className="scope-row">
                          <Checkbox
                            id={id}
                            checked={pickedRoles.has(r.id)}
                            onCheckedChange={(on) => toggle("roleIds", r.id, on)}
                          />
                          <RoleMark color={r.color} icon={r.icon} size={26} />
                          <span className="scope-row__text">
                            <span>{r.name}</span>
                            <span className="small muted">{t("audience.roleMembers", { count: r.people })}</span>
                          </span>
                        </label>
                      );
                    })}
                  </>
                )}
                {rows.length > 0 && (
                  <>
                    {roleRows.length > 0 && <span className="ac-field__label">{t("audience.people")}</span>}
                    {rows.map((m) => {
                      const id = `${idPrefix}-p-${m.userId.replace(/[^a-zA-Z0-9]/g, "-")}`;
                      return (
                        <label key={m.userId} htmlFor={id} className="scope-row">
                          <Checkbox
                            id={id}
                            checked={picked.has(m.userId)}
                            onCheckedChange={(on) => toggle("userIds", m.userId, on)}
                          />
                          <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                          <span className="scope-row__text">
                            <span>{m.name}</span>
                            <span className="small muted">{m.email}</span>
                          </span>
                        </label>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A "people" audience needs someone (a person or a role) besides an absent owner. */
export const audienceValid = (a: AgentAudience, ownerUserId: string | null) =>
  a.mode === "everyone" ||
  (a.mode === "owner"
    ? Boolean(ownerUserId)
    : a.userIds.length > 0 || (a.roleIds?.length ?? 0) > 0 || Boolean(ownerUserId));
