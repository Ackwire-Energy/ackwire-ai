import {
  useAgentBrain,
  useAgentDetail,
  useCredentials,
  useModels,
  usePlatformKey,
  useSettings,
  useUsage,
} from "@agenteschat/client";
import { audienceSummary } from "@agenteschat/client/lib/audience";
import { formatMonth, formatPercent, formatTokensShort, formatUsd } from "@agenteschat/client/lib/format";
import { can as canDo } from "@agenteschat/client/lib/permissions";
import { modelChoices } from "@agenteschat/client/lib/providers";
import {
  AffixInput,
  type AgentAppearance,
  Avatar,
  Button,
  Card,
  CheckboxPill,
  Chip,
  Field,
  Icon,
  type IconName,
  Input,
  Meter,
  randomAppearance,
} from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentBrainChoice, agentBrainLine } from "@/components/AgentBrain";
import { AgentComputerPanel } from "@/components/AgentComputer";
import {
  BudgetField,
  KeySelect,
  keyOptions,
  LookField,
  ModelCards,
  ModelCardView,
  NO_OWNER,
  OwnerSelect,
  usd,
} from "@/components/AgentFields";
import { AgentSecretsList } from "@/components/AgentSecrets";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { AGENT_SECTIONS, type AgentSection, type Field as EditField, FIELD_PLACE } from "@/lib/agent-edit";
import { BLANK_LOOK } from "@/lib/new-agent";
import { CardHead, useAgentEdit, WasLine } from "./context";
import { ReadOnlyNote, useVisibleChannels } from "./pieces";

const SECTION_ICON: Record<AgentSection, IconName> = {
  identity: "person",
  brain: "bulb",
  budget: "wallet",
  owner: "members",
  audience: "message",
  channels: "channel",
  computer: "computer",
  danger: "archive",
};

/** A section of Configurações: a card with its head and, when changed, the outline. */
function Section({
  id,
  title,
  fields,
  action,
  children,
  danger,
}: {
  id: AgentSection;
  title: string;
  fields: EditField[];
  action?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  const { changes, can } = useAgentEdit();
  const keys = changes.filter((c) => fields.includes(c.field)).map((c) => c.key);
  const editable = fields.some((f) => can(f));
  return (
    <Card
      as="section"
      id={`agp-sec-${id}`}
      className={danger ? "agp-card agp-sec agp-danger" : "agp-card agp-sec"}
      data-changed={keys.length > 0 || undefined}
      aria-labelledby={`agp-h-${id}`}
    >
      <CardHead
        id={`agp-h-${id}`}
        icon={SECTION_ICON[id]}
        title={title}
        changeKeys={keys}
        lock={editable || danger ? undefined : fields[0]}
        action={editable ? action : undefined}
      />
      {children}
    </Card>
  );
}

/** A read-only value where an input would be (members, or what the owner can't change). */
const ReadValue = ({ children }: { children: ReactNode }) => <span className="agp-ro">{children}</span>;

/** Configurações: identity and look, who thinks (and the API's model and key), budget, owner, audience, channels, computer. */
export function SettingsTab({
  section,
  onSection,
  onArchive,
}: {
  section: AgentSection | undefined;
  onSection: (sec: AgentSection) => void;
  onArchive: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, viewer, draft, saved, set, can, changes, errors, ownerFirst } = useAgentEdit();
  const admin = viewer === "admin";
  const models = useModels();
  const credentials = useCredentials(org.id, canDo(org.role, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const settings = useSettings(org.id);
  const detail = useAgentDetail(org.id, agent.id);
  const usage = useUsage(org.id);
  const brain = useAgentBrain(org.id, agent.id, viewer !== "member");
  const all = models.data?.models ?? [];
  const choices = modelChoices(all, credentials.data ?? [], platform.data ?? false);
  const current = all.find((m) => m.id === draft.model);
  const keys = keyOptions(t, credentials.data ?? [], settings.data?.defaultCredentialId ?? null);
  const savedKeyLabel = (() => {
    const id = detail.data?.credentialId;
    if (id && id !== settings.data?.defaultCredentialId) return t("agent.ownKey");
    return agent.hasCredential ? t("agent.withOrgKey", { org: org.name }) : t("agent.withPlatformKey");
  })();
  const sections = AGENT_SECTIONS.filter((s) => s !== "danger" || admin);
  const owner = draft.owner === NO_OWNER ? undefined : dir.memberById.get(draft.owner);
  const ownerId = draft.owner === NO_OWNER ? null : draft.owner;
  const used = detail.data?.budgetUsedPercent ?? 0;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const defaultBudget = settings.data?.defaultAgentBudgetUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const month = formatMonth(locale, new Date());
  const visibleChannels = useVisibleChannels().list;
  const look = draft.look;
  // A computer brain, for members (they don't load "Quem pensa"); the API shows its model and key.
  const memberBrain = agent.brain && agent.brain.kind !== "model" ? agentBrainLine(t, agent, "") : null;
  /** "Modelo (API)": its model and key (admins), or what it uses (everyone else). */
  const apiFields = can("model") ? (
    <>
      <ModelCards choices={choices} value={draft.model} money onChange={(id) => set("model", id)} />
      <WasLine changeKey="model" />
      <div className="agp-field">
        <span className="newag__label">{t("newAgent.key")}</span>
        {draft.key === undefined ? (
          <LoadingLine width={200} />
        ) : (
          <KeySelect value={draft.key} onChange={(k) => set("key", k)} options={keys} />
        )}
        <WasLine changeKey="key" />
        <span className="small muted">
          {t("brain.countsBudget", g)} {t("agentPage.settings.keySafe")}
        </span>
      </div>
    </>
  ) : (
    <div className="newag__models">
      {current ? <ModelCardView model={current} all={all} money={false} /> : <ReadValue>{draft.model}</ReadValue>}
      <div className="newag__model newag__model--ro">
        <span className="newag__model-head">
          <Icon name="key" size={16} />
          <b>{savedKeyLabel}</b>
        </span>
        <span className="newag__model-desc">
          {t("brain.countsBudget", g)} {t("agentPage.settings.keySafe")}
        </span>
      </div>
    </div>
  );
  return (
    <>
      <ReadOnlyNote />
      <div className="agp-cfg">
        <nav className="agp-subnav" aria-label={t("agentPage.settings.sections")}>
          {sections.map((s) => {
            const n = changes.filter((c) => FIELD_PLACE[c.field].sec === s).length;
            return (
              <button
                key={s}
                type="button"
                className="agp-subnav__item"
                data-danger={s === "danger" || undefined}
                aria-current={section === s ? "true" : undefined}
                onClick={() => onSection(s)}
              >
                <Icon name={SECTION_ICON[s]} size={14} />
                {s === "computer" ? t("agentPage.settings.computer") : t(`agentPage.settings.${s}`)}
                {n > 0 && (
                  <span className="agp-tag agp-tag--dot">
                    <Icon name="edit" size={14} />
                    <span className="ac-visually-hidden">{t("agentPage.changesCount", { count: n })}</span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="agp-col agp-col--cfg">
          <Section
            id="identity"
            title={t("agentPage.settings.identity")}
            fields={["name", "role", "look"]}
            action={
              can("look") ? (
                <Button
                  size="sm"
                  icon="shuffle"
                  onClick={() => set("look", { ...BLANK_LOOK, ...randomAppearance(look) } as Required<AgentAppearance>)}
                >
                  {t("newAgent.shuffle")}
                </Button>
              ) : undefined
            }
          >
            {can("name") ? (
              <div className="newag__grid2">
                <Field label={t("agent.nameLabel")} id="agp-name" error={errors.name}>
                  <Input
                    value={draft.name}
                    maxLength={80}
                    autoComplete="off"
                    onChange={(e) => set("name", e.target.value)}
                  />
                </Field>
                <Field label={t("agent.roleLabel")} id="agp-role" help={t("agent.roleHelp")}>
                  <Input
                    value={draft.role}
                    maxLength={200}
                    autoComplete="off"
                    onChange={(e) => set("role", e.target.value)}
                  />
                </Field>
                <WasLine changeKey="name" />
                <WasLine changeKey="role" />
              </div>
            ) : (
              <div className="newag__grid2">
                <div className="agp-field">
                  <span className="newag__label">{t("agent.nameLabel")}</span>
                  <ReadValue>{agent.name}</ReadValue>
                </div>
                <div className="agp-field">
                  <span className="newag__label">{t("agent.roleLabel")}</span>
                  <ReadValue>{agent.role || t("agentPage.none")}</ReadValue>
                </div>
              </div>
            )}
            <div className="agp-field">
              <span className="newag__label">{t("newAgent.handle")}</span>
              <AffixInput
                prefix="@"
                value={agent.handle}
                readOnly
                aria-label={t("newAgent.handle")}
                className="agp-locked"
              />
              <span className="small muted">{t("agent.identityHelp", { handle: agent.handle })}</span>
            </div>
            {can("look") ? (
              <div className="agp-field">
                <LookField look={look} name={agent.name} onChange={(next) => set("look", next)} />
                <WasLine changeKey="look" />
              </div>
            ) : (
              <div className="agp-field">
                <span className="newag__label">{t("agentPage.fields.look")}</span>
                <span className="agp-chips">
                  <Chip icon="agent">
                    {[
                      t(`look.colors.${look.color}`),
                      t(`look.eyesNames.${look.eyes}`),
                      ...(look.accessory !== "none" ? [t(`look.accessories.${look.accessory}`)] : []),
                    ].join(" · ")}
                  </Chip>
                </span>
              </div>
            )}
          </Section>

          <Section id="brain" title={t("brain.title")} fields={["brain", "model", "key"]}>
            {viewer === "member" ? (
              <>
                {memberBrain ? (
                  <span className="agp-chips">
                    <Chip icon={memberBrain.icon}>{memberBrain.text}</Chip>
                  </span>
                ) : (
                  apiFields
                )}
                <p className="small muted">
                  {ownerFirst ? t("brain.hidden", { owner: ownerFirst }) : t("brain.hiddenAdmins")}
                </p>
              </>
            ) : brain.data && draft.brain ? (
              <>
                <span className="small muted">{t("brain.sub", g)}</span>
                <AgentBrainChoice
                  view={brain.data}
                  value={draft.brain}
                  savedBrain={saved.brain?.brain}
                  onChange={can("brain") ? (v) => set("brain", v) : undefined}
                  g={g}
                  apiFields={apiFields}
                  look={look}
                />
                <WasLine changeKey="brain" />
              </>
            ) : brain.isError ? (
              apiFields
            ) : (
              <LoadingLine width={220} />
            )}
          </Section>

          <Section id="budget" title={t("agentPage.settings.budget")} fields={["budget"]}>
            <div className="agp-spent">
              <div className="agp-spent__top">
                {admin && spent !== undefined && limit !== undefined ? (
                  <>
                    <b>{formatUsd(t, locale, spent)}</b>
                    <span className="small muted">
                      {saved.budget === null
                        ? t("agentPage.settings.spentOfDefault", { month, amount: usd(t, locale, limit) })
                        : t("agentPage.settings.spentOf", { month, amount: usd(t, locale, limit) })}
                    </span>
                  </>
                ) : (
                  <>
                    <b>{formatPercent(locale, used)}</b>
                    <span className="small muted">
                      {detail.data?.monthlyBudgetUsd === null
                        ? t("agentPage.settings.usedDefault", { month })
                        : t("agentPage.settings.used", { month })}
                    </span>
                  </>
                )}
              </div>
              <Meter value={Math.min(100, used)} max={100} label={t("agent.budgetUsed")} />
              <span className="small muted">
                {t("agentPage.settings.budgetStats", {
                  runs: t("agent.runsCount", { count: detail.data?.runsThisMonth ?? 0 }),
                  tokens: t("agent.tokensCount", {
                    tokens: formatTokensShort(t, locale, detail.data?.tokensThisMonth ?? 0),
                  }),
                  who: ownerFirst ?? t("agentPage.settings.theAdmins"),
                })}
              </span>
            </div>
            {can("budget") && draft.budget !== undefined && saved.budget !== undefined ? (
              <div className="agp-field">
                <span className="newag__label">{t("agentPage.settings.limit")}</span>
                <BudgetField
                  id="agp-budget"
                  value={draft.budget}
                  onChange={(v) => set("budget", v)}
                  defaultBudget={defaultBudget}
                  error={errors.budget}
                >
                  {draft.budget.trim() && (
                    <Button variant="ghost" size="sm" className="agp-self-center" onClick={() => set("budget", "")}>
                      {t("agentPage.settings.useDefault")}
                    </Button>
                  )}
                </BudgetField>
                <WasLine changeKey="budget" />
                {!errors.budget && (
                  <span className="small muted">
                    {defaultBudget === undefined
                      ? t("agent.budgetDefaultHelp")
                      : t("agent.budgetDefaultHelpAmount", { amount: usd(t, locale, defaultBudget) })}{" "}
                    {t("agent.budgetHelp", { ...g, ownerNote: "" }).trim()}
                  </span>
                )}
              </div>
            ) : (
              !admin && (
                <span className="agp-lock">
                  <Icon name="lock" size={14} />
                  {t("agentPage.settings.budgetAdmins")}
                </span>
              )
            )}
          </Section>

          <Section id="owner" title={t("newAgent.owner")} fields={["owner"]}>
            {can("owner") ? (
              <>
                <OwnerSelect
                  value={draft.owner}
                  members={dir.members}
                  meId={me.user.id}
                  onChange={(v) => {
                    set("owner", v);
                    if (v !== NO_OWNER && draft.audience.userIds.includes(v))
                      set("audience", { ...draft.audience, userIds: draft.audience.userIds.filter((id) => id !== v) });
                  }}
                />
                <WasLine changeKey="owner" />
              </>
            ) : (
              <div className="agp-person">
                {owner ? (
                  <Avatar kind="person" size="md" name={owner.name} imageUrl={owner.image} />
                ) : (
                  <span className="newag__ib">
                    <Icon name="members" size={16} />
                  </span>
                )}
                <span className="agp-person__t">
                  <b>
                    {owner
                      ? owner.userId === me.user.id
                        ? t("newAgent.you", { name: owner.name })
                        : owner.name
                      : t("newAgent.noOwnerOption")}
                  </b>
                  {owner && <span>{t(`roles.${owner.role}`)}</span>}
                </span>
              </div>
            )}
            <span className="small muted">{ownerId ? t("newAgent.ownerHelp") : t("newAgent.noOwnerHelp")}</span>
          </Section>

          <Section id="audience" title={t("audience.title", g)} fields={["audience"]}>
            {can("audience") ? (
              <>
                <AudienceChoice
                  compact
                  value={draft.audience}
                  onChange={(a) => set("audience", a)}
                  ownerUserId={ownerId}
                  agentName={agent.name}
                  idPrefix="agp-audience"
                />
                {errors.audience && (
                  <span className="newag__err" role="alert">
                    <Icon name="info" size={14} />
                    {errors.audience}
                  </span>
                )}
                <WasLine changeKey="audience" />
              </>
            ) : (
              <>
                <span className="agp-chips">
                  <Chip icon="message">{audienceSummary(t, agent, (id) => dir.memberById.get(id)?.name)}</Chip>
                </span>
                <span className="small muted">{t("audience.notListed")}</span>
              </>
            )}
          </Section>

          <Section id="channels" title={t("newAgent.channels")} fields={["channels"]}>
            {draft.channels === undefined ? (
              <LoadingLine width={220} />
            ) : can("channels") ? (
              visibleChannels.length ? (
                <div className="newag__pills">
                  {visibleChannels.map((c) => (
                    <CheckboxPill
                      key={c.id}
                      id={`agp-ch-${c.id}`}
                      checked={draft.channels?.includes(c.id) ?? false}
                      onCheckedChange={(on) => {
                        const next = new Set(draft.channels ?? []);
                        if (on) next.add(c.id);
                        else next.delete(c.id);
                        set("channels", [...next].sort());
                      }}
                    >
                      {`#${c.name}`}
                    </CheckboxPill>
                  ))}
                </div>
              ) : (
                <span className="small muted">{t("newAgent.noChannels")}</span>
              )
            ) : draft.channels.length ? (
              <span className="agp-chips">
                {visibleChannels
                  .filter((c) => draft.channels?.includes(c.id))
                  .map((c) => (
                    <Chip key={c.id} icon="channel">
                      {c.name}
                    </Chip>
                  ))}
              </span>
            ) : (
              <span className="small muted">{t("agentPage.overview.noChannels", { handle: agent.handle })}</span>
            )}
            <WasLine changeKey="channels" />
            <span className="small muted">{t("agentPage.settings.channelsHelp", { handle: agent.handle })}</span>
          </Section>

          <Section id="computer" title={t("computer.title", g)} fields={["machine"]}>
            {viewer === "member" ? (
              <p className="small muted">
                {t("agentPage.computer.hidden", { owner: ownerFirst ?? t("roles.adminLower") })}
              </p>
            ) : (
              <AgentComputerPanel
                agent={agent}
                admin={admin}
                machine={draft.machine ?? "cloud"}
                onMachine={can("machine") && draft.machine !== undefined ? (v) => set("machine", v) : undefined}
                machineNote={<WasLine changeKey="machine" />}
              />
            )}
            <AgentSecretsList agent={agent} editable={admin} />
          </Section>

          {admin && (
            <Section id="danger" title={t("agentPage.settings.danger")} fields={[]} danger>
              <div className="agp-dz">
                <span className="agp-dz__t">
                  <b>{t("agentPage.archive.action", g)}</b>
                  <span>{t("agentPage.archive.help")}</span>
                </span>
                <Button variant="danger" icon="archive" onClick={onArchive}>
                  {t("agentPage.archive.button")}
                </Button>
              </div>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
