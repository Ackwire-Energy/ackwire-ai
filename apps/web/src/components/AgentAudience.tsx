import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  RadioCard,
  RadioGroup,
  SearchInput,
  Segmented,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateAgent } from "@/api/queries";
import type { Agent, AgentAudience, AudienceMode } from "@/api/types";
import { EditDialog } from "@/components/EditDialog";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { audienceChip, audienceOf, audienceSummary, canEditAudience } from "@/lib/audience";
import { agentGrammar } from "@/lib/grammar";
import { useToast } from "@/lib/toast";

const MODES: AudienceMode[] = ["everyone", "people", "owner"];
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Chip "Pessoal" / "Restrito" next to the agent's name (nothing when everyone can talk to it). */
export function AudienceChip({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const { t } = useTranslation();
  const label = audienceChip(t, agent);
  if (!label) return null;
  return (
    <Chip icon="lock" className={compact ? "audience-chip audience-chip--compact" : "audience-chip"}>
      {label}
    </Chip>
  );
}

/**
 * The three choices (Todos do workspace / Só algumas pessoas / Só o
 * responsável), with the people picker under "Só algumas pessoas".
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
  const [query, setQuery] = useState("");
  const picked = new Set(value.userIds);
  const candidates = dir.members.filter((m) => m.userId !== ownerUserId);
  const q = fold(query.trim());
  const rows = candidates.filter((m) => !q || fold(`${m.name} ${m.email} ${m.handle}`).includes(q));
  const toggle = (userId: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(userId);
    else next.delete(userId);
    onChange({ ...value, userIds: [...next] });
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
          <Segmented
            label={t("audience.title", g)}
            value={value.mode}
            onValueChange={(mode) => onChange({ mode, userIds: value.userIds })}
            options={MODES.map((mode) => ({ value: mode, label: t(`audience.mode.${mode}`) }))}
          />
          <span className="small muted">
            {modeText(value.mode)} {t("audience.notListed")}
          </span>
        </>
      ) : (
        <RadioGroup
          value={value.mode}
          onValueChange={(mode) => onChange({ mode: mode as AudienceMode, userIds: value.userIds })}
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
          <span className="ac-field__label">{t("audience.people")}</span>
          {owner && <span className="small muted">{t("audience.ownerAlways", { name: owner.name })}</span>}
          {picked.size > 0 && (
            <TokenList label={t("audience.people")}>
              {candidates
                .filter((m) => picked.has(m.userId))
                .map((m) => (
                  <li key={m.userId}>
                    <Token
                      leading={<Avatar kind="person" size="xs" name={m.name} imageUrl={m.image} />}
                      removeLabel={t("common.removeName", { name: m.name })}
                      onRemove={() => toggle(m.userId, false)}
                    >
                      {m.name}
                    </Token>
                  </li>
                ))}
            </TokenList>
          )}
          <SearchInput
            aria-label={t("audience.search")}
            placeholder={t("audience.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
          <div className="people-picker__results" role="region" aria-label={t("audience.search")}>
            {rows.length === 0 ? (
              <p className="small muted">{t("audience.noMatch")}</p>
            ) : (
              rows.map((m) => {
                const id = `${idPrefix}-p-${m.userId.replace(/[^a-zA-Z0-9]/g, "-")}`;
                return (
                  <label key={m.userId} htmlFor={id} className="scope-row">
                    <Checkbox id={id} checked={picked.has(m.userId)} onCheckedChange={(on) => toggle(m.userId, on)} />
                    <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                    <span className="scope-row__text">
                      <span>{m.name}</span>
                      <span className="small muted">{m.email}</span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A "people" audience needs someone besides an absent owner. */
export const audienceValid = (a: AgentAudience, ownerUserId: string | null) =>
  a.mode === "everyone" || (a.mode === "owner" ? Boolean(ownerUserId) : a.userIds.length > 0 || Boolean(ownerUserId));

const sameAudience = (a: AgentAudience, b: AgentAudience) =>
  a.mode === b.mode && (a.mode !== "people" || [...a.userIds].sort().join() === [...b.userIds].sort().join());

/** Profile row "Quem pode falar com o Theo" with "Editar" (owner and admins). */
export function AudienceRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const g = agentGrammar(t, agent.name);
  const editable = canEditAudience(org.role, agent, me.user.id);
  const nameOf = (id: string) => dir.memberById.get(id)?.name;
  return (
    <section aria-labelledby="sec-audience" className="summary-row">
      <div className="summary-row__text">
        <h2 id="sec-audience" className="summary-row__title">
          {t("audience.title", g)}
        </h2>
        <div className="summary-row__body">
          <span className="row" style={{ gap: 8, alignItems: "center" }}>
            <span>{audienceSummary(t, agent, nameOf)}</span>
            <AudienceChip agent={agent} />
          </span>
          <span className="small muted">{t("audience.help", g)}</span>
        </div>
      </div>
      {editable && (
        <div className="summary-row__action">
          <Button
            size="sm"
            aria-label={t("agent.editSection", { section: t("audience.section") })}
            onClick={() => setOpen(true)}
          >
            {t("agent.edit")}
          </Button>
        </div>
      )}
      {editable && <AudienceDialog open={open} onClose={() => setOpen(false)} agent={agent} />}
    </section>
  );
}

function AudienceDialog({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const saved = audienceOf(agent);
  const [value, setValue] = useState<AgentAudience>(saved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset to the saved value each time it opens
  useEffect(() => {
    if (open) setValue(saved);
  }, [open]);
  const valid = audienceValid(value, agent.ownerUserId);
  return (
    <EditDialog
      open={open}
      onClose={onClose}
      title={t("audience.title", g)}
      description={t("audience.help", g)}
      dirty={!sameAudience(value, saved) && valid}
      saving={update.isPending}
      width={520}
      onSave={() =>
        update.mutate(
          { audience: { mode: value.mode, userIds: value.mode === "people" ? value.userIds : [] } },
          {
            onSuccess: () => {
              toast.show(t("agent.savedToast", g));
              onClose();
            },
          },
        )
      }
    >
      <AudienceChoice
        value={value}
        onChange={setValue}
        ownerUserId={agent.ownerUserId}
        agentName={agent.name}
        idPrefix={`aud-${agent.id}`}
      />
      {!valid && <p className="small muted">{t("audience.pickSomeone")}</p>}
    </EditDialog>
  );
}
