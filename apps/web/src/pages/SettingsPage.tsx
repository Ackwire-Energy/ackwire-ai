import type { Credential, OrgSettings } from "@agenteschat/client";
import {
  useAddCredential,
  useAgents,
  useAiAccounts,
  useAiStatus,
  useAuthConfig,
  useComposioUsage,
  useComputerSetup,
  useConnections,
  useCredentials,
  useInvitations,
  useMachines,
  useOverview,
  usePlatformKey,
  useRemoveCredential,
  useRotateCredential,
  useServerTelemetry,
  useSetServerTelemetry,
  useSettings,
  useSkills,
  useStorage,
  useUpdateSettings,
  useUsageReport,
} from "@agenteschat/client";
import { keyRemovalText } from "@agenteschat/client/lib/ai-accounts";
import { composioUsageText, showsComposioUsage } from "@agenteschat/client/lib/composio";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import { errorText, keyRefusal } from "@agenteschat/client/lib/errors";
import { formatPercent, formatShortDate, formatUsd, relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  keyLooksValid,
  keyNamedAfterProvider,
  type ProviderId,
  providerGuess,
  providerLabel,
  providerOf,
} from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { parseAmount } from "@agenteschat/client/lib/text";
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  InfoHint,
  Input,
  List,
  Locked,
  Meter,
  PageHeader,
  ProviderLogo,
  SettingNote,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AboutSection } from "@/components/AboutSettings";
import { AccessMatrixSection } from "@/components/AccessLevels";
import { AccountSection } from "@/components/AccountSettings";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AiAppsSection } from "@/components/AiApps";
import { ApprovalsSection } from "@/components/ApprovalCover";
import { AuditSection } from "@/components/Audit";
import { AutoModelsRow } from "@/components/AutoModels";
import { AiAccountsSection } from "@/components/ai/AiAccounts";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { EndpointForm } from "@/components/ai/EndpointForm";
import { WhoPicksSection } from "@/components/ai/Jev";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { ComputersSection } from "@/components/Computers";
import { ConnectorsSection } from "@/components/Connectors";
import { DeleteWorkspaceDialog } from "@/components/DeleteWorkspace";
import { ImportExportSection } from "@/components/ImportFlow";
import { BillingMeters } from "@/components/Limits";
import { ErrorState, LoadingLine, LoadingList } from "@/components/Loading";
import { MachinePage } from "@/components/Machines";
import { MediaSettingsSection } from "@/components/MediaSettings";
import { NoticePrefsSection } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { UsageTabs } from "@/components/PeopleUsage";
import { PlanUsageCards } from "@/components/PlanUsage";
import { MyFace, OrgLogoDialog, OrgMark } from "@/components/ProfilePhoto";
import { KeyMismatch, KeyRefused, KeySite, ProviderKeySelect } from "@/components/ProviderKey";
import { RightHandSettingsSection } from "@/components/RightHandSettings";
import { RolesSection } from "@/components/roles/RolesSection";
import { SkillsSection } from "@/components/Skills";
import { StorageSection } from "@/components/StorageSettings";
import { VoiceSettingsSection } from "@/components/VoiceSettings";
import { VaultSection } from "@/components/vault/VaultSection";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useCentreCurrent } from "@/hooks/useCentreCurrent";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useOpenParam } from "@/lib/open-param";
import { workspaceUsesApi } from "@/lib/plan-usage";
import { useToast } from "@/lib/toast";
import { MembersPage } from "./MembersPage";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from "./settings-sections";

/**
 * Settings: a left sub-nav and one section per URL (`/settings/connectors`, …).
 * Members only see what they can open.
 */
export function SettingsPage(props: ComponentProps<typeof Settings>) {
  // What this server offers decides the sections (`allowed`): the page waits for it, so none moves in afterwards.
  return useAuthConfig().isPending ? null : <Settings {...props} />;
}

function Settings({
  section = "general",
  connected,
  outcome,
  review,
  mail,
  account,
  machineId,
  install,
  skill,
  agent,
  person,
}: {
  section?: SettingsSection;
  connected?: string;
  /** Back from OAuth: what came in (`connected`, `reconnected`, `same_account`). */
  outcome?: string;
  review?: boolean;
  /** Back from Gmail/Outlook: `connected` or `failed`, and the mailbox (`account`). */
  mail?: string;
  account?: string;
  /** Skills, back from connecting GitHub in Instalar skill: the link to read again. */
  install?: string;
  /** Skills: the skill to open (a notice of its update). */
  skill?: string;
  /** Computadores → one computer (`/settings/computers/{id}`). */
  machineId?: string;
  /** Auditoria: the agent it opens filtered to. */
  agent?: string;
  /** Orçamento e uso › Pessoas: the person whose month opens (a limit's notice). */
  person?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const server = useAuthConfig().data;
  const visible = SETTINGS_SECTIONS.filter((s) => s.allowed(org, server));
  // A section this person can't open (a member's link to Geral): their first one, their account.
  const current = visible.some((s) => s.id === section) ? section : (visible[0]?.id ?? "account");
  const setup = useComputerSetup(org.id);
  const edition = computerEdition(setup.data);
  const strip = useRef<HTMLDivElement>(null);
  useCentreCurrent(strip, current);
  // The right hand's section goes by its name and face (admins may rename it).
  const rightHand = useDirectory(org.id).agents.find(isRightHand);
  const sectionName = (id: SettingsSection) =>
    id === "right_hand" && rightHand ? rightHand.name : t(`settings.section.${id}`);

  return (
    <div className="settings page-split">
      <nav className="settings__nav" data-scroll-restoration-id="settings-nav" aria-label={t("settings.nav")}>
        <div className="settings__head">
          <h1 className="settings__title">{t("settings.title")}</h1>
          <span className="settings__org">
            <OrgMark logo={org.logo} size={18} />
            <span>{org.name}</span>
          </span>
        </div>
        <div className="settings__groups" ref={strip}>
          {SETTINGS_GROUPS.map((g) => {
            const items = visible.filter((s) => s.group === g);
            if (items.length === 0) return null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a labelled group of links in the nav, not form fields
              <div key={g} className="settings__group" role="group" aria-labelledby={`settings-group-${g}`}>
                <span id={`settings-group-${g}`} className="settings__group-label">
                  {t(`settings.group.${g}`)}
                </span>
                <ul>
                  {items.map((s) => (
                    <li key={s.id}>
                      <Link
                        to="/org/$orgId/settings/$section"
                        params={{ orgId: org.id, section: s.id }}
                        className="settings__link"
                        aria-current={s.id === current ? "page" : undefined}
                      >
                        {s.id === "account" ? (
                          <MyFace size="xs" />
                        ) : s.id === "right_hand" && rightHand ? (
                          <AgentAvatar agentId={rightHand.id} name={rightHand.name} size="xs" />
                        ) : (
                          <Icon name={s.icon} size={18} />
                        )}
                        {sectionName(s.id)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="settings__body" data-scroll-restoration-id="settings-section">
        {current !== "members" && current !== "general" && current !== "roles" && current !== "vault" && (
          <PageHeader
            level={2}
            title={sectionName(current)}
            meta={
              current !== "computers" ? (
                t(`settings.sectionText.${current}`)
              ) : edition ? (
                t(edition === "cloud" ? "computers.leadCloud" : "computers.lead")
              ) : setup.isError ? null : (
                // Never one edition's words before the server says which this is (the section says if it couldn't).
                <LoadingLine width={320} />
              )
            }
          />
        )}
        {current === "account" && <AccountSection />}
        {current === "notifications" && <NoticePrefsSection />}
        {current === "approvals" && <ApprovalsSection />}
        {current === "apps" && <AiAppsSection />}
        {current === "general" && <GeneralSection />}
        {current === "members" && <MembersPage embedded />}
        {current === "roles" && <RolesSection />}
        {current === "vault" && <VaultSection />}
        {current === "right_hand" && <RightHandSettingsSection />}
        {current === "audit" && <AuditSection agent={agent} />}
        {current === "media" && <MediaSettingsSection />}
        {current === "voice" && <VoiceSettingsSection />}
        {current === "access" && <AccessMatrixSection />}
        {current === "connectors" && (
          <ConnectorsSection connected={connected} outcome={outcome} review={review} mail={mail} account={account} />
        )}
        {current === "skills" && <SkillsSection install={install} connected={connected} skill={skill} />}
        {current === "keys" && (
          <>
            <AiAccountsSection />
            <KeysSection />
            <WhoPicksSection />
          </>
        )}
        {current === "storage" && <StorageSection />}
        {current === "computers" && (machineId ? <MachinePage machineId={machineId} /> : <ComputersSection />)}
        {current === "usage" && <UsageTabs person={person} summary={<UsageSection />} />}
        {current === "import" && <ImportExportSection />}
        {current === "billing" && <BillingSection />}
        {current === "about" && <AboutSection />}
      </div>
    </div>
  );
}

/**
 * Plano e cobrança (ADR 0079): people and files against the plan's limits; the plan, card and invoices live on the
 * billing service, opened signed in.
 */
function BillingSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Card aria-label={t("settings.section.billing")}>
      <BillingMeters />
      <div className="row">
        <BillingLinkButton orgId={org.id} from="settings" variant="primary" icon="external">
          {t("billing.open")}
        </BillingLinkButton>
      </div>
    </Card>
  );
}

/**
 * Geral: the org's rows, the context every agent reads, then a
 * tile per area with how it is now. Every change saves by itself: name on blur, zone on pick, context
 * while typing.
 */
function GeneralSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const editable = can(org, "configure");
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [timezone, setTimezone] = useState("");
  const [logo, setLogo] = useState(false);
  const [saved, setSaved] = useState(false);
  const loaded = useRef<string | null>(null);
  const contextTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  // Filled once per org: a refetch after a save must not undo what is being typed.
  useEffect(() => {
    if (!settings.data || loaded.current === org.id) return;
    loaded.current = org.id;
    setName(settings.data.name);
    setContext(settings.data.context);
    setTimezone(settings.data.timezone);
  }, [settings.data, org.id]);
  useEffect(
    () => () => {
      clearTimeout(contextTimer.current);
      clearTimeout(savedTimer.current);
    },
    [],
  );

  const save = (patch: Partial<OrgSettings>) => {
    if (!editable) return;
    update.mutate(patch, {
      onSuccess: () => {
        setSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1800);
      },
    });
  };
  const saveName = () => {
    const next = name.trim();
    if (!next) {
      setName(settings.data?.name ?? "");
      return;
    }
    if (next !== settings.data?.name) save({ name: next });
  };
  const changeContext = (value: string) => {
    setContext(value);
    clearTimeout(contextTimer.current);
    contextTimer.current = setTimeout(() => save({ context: value }), 800);
  };
  const flushContext = () => {
    clearTimeout(contextTimer.current);
    if (settings.data && context !== settings.data.context) save({ context });
  };
  const addIdea = (label: string) => {
    const value = `${context.replace(/\s*$/, "")}${context.trim() ? "\n\n" : ""}${label}: `;
    changeContext(value);
    requestAnimationFrame(() => {
      const el = contextRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(value.length, value.length);
    });
  };
  const ideas = (["who", "now", "never"] as const).map((k) => t(`settings.contextIdeas.${k}`));
  const orgName = name.trim() || org.name;
  const contextTitle = t("settings.contextTitle", { name: orgName });
  const missing = ideas.filter((label) => !context.toLowerCase().includes(label.toLowerCase()));

  return (
    <>
      <PageHeader
        level={2}
        title={t("settings.section.general")}
        meta={t("settings.sectionText.general")}
        actions={
          <span className="settings__saved" data-on={saved || undefined} role="status">
            {saved && (
              <>
                <Icon name="check" size={16} />
                {t("settings.savedShort")}
              </>
            )}
          </span>
        }
      />
      {!editable && <p className="page__note">{t("settings.readOnly")}</p>}

      <Card aria-label={t("settings.orgTitle")}>
        <div className="settings-rows">
          <div className="settings-row ac-actrow">
            <div className="settings-row__text ac-actrow__text">
              <span className="settings-row__label">{t("orgLogo.label")}</span>
            </div>
            <div className="settings-row__control">
              <OrgMark logo={org.logo} size={40} className="settings__org-logo" />
              {editable && (
                <Button size="sm" type="button" onClick={() => setLogo(true)}>
                  {org.logo ? t("orgLogo.change") : t("orgLogo.add")}
                </Button>
              )}
            </div>
          </div>
          <div className="settings-row ac-actrow">
            <div className="settings-row__text ac-actrow__text">
              <label className="settings-row__label" htmlFor="set-name">
                {t("settings.name")}
              </label>
            </div>
            <div className="settings-row__control">
              <Input
                id="set-name"
                spellCheck={false}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                readOnly={!editable}
              />
            </div>
          </div>
          <div className="settings-row ac-actrow">
            <div className="settings-row__text ac-actrow__text">
              <span className="ac-hintline">
                <span className="settings-row__label">{t("settings.timezone")}</span>
                <InfoHint name={t("common.about", { label: t("settings.timezone") })}>
                  {t("settings.timezoneHelp")}
                </InfoHint>
              </span>
            </div>
            <div className="settings-row__control">
              <ZoneSelect
                value={timezone || "UTC"}
                onChange={(zone) => {
                  setTimezone(zone);
                  if (zone !== settings.data?.timezone) save({ timezone: zone });
                }}
                disabled={!editable}
                aria-label={t("settings.timezone")}
              />
            </div>
          </div>
          <div className="settings-row ac-actrow">
            <div className="settings-row__text ac-actrow__text">
              <span className="ac-hintline">
                <label className="settings-row__label" htmlFor="set-action-check">
                  {t("settings.actionCheck")}
                </label>
                <InfoHint name={t("common.about", { label: t("settings.actionCheck") })} id="set-action-check-hint">
                  {t("settings.actionCheckHelp")}
                </InfoHint>
              </span>
            </div>
            <div className="settings-row__control">
              <Switch
                id="set-action-check"
                checked={settings.data?.actionCheck ?? true}
                onCheckedChange={(on) => save({ actionCheck: on })}
                disabled={!editable || !settings.data}
                aria-describedby="set-action-check-hint"
              />
            </div>
          </div>
        </div>
      </Card>

      <Card aria-labelledby="sec-context">
        <CardHeader
          id="sec-context"
          icon="agent"
          title={contextTitle}
          hint={{
            name: t("common.about", { label: contextTitle }),
            text: t("common.joinSentences", {
              a: t("settings.contextSubtitle"),
              b: t("settings.contextHelp", { name: orgName }),
            }),
          }}
        />
        <Textarea
          ref={contextRef}
          rows={7}
          maxLength={20_000}
          value={context}
          onChange={(e) => changeContext(e.target.value)}
          onBlur={flushContext}
          readOnly={!editable}
          placeholder={t("settings.contextPlaceholder")}
          aria-label={t("settings.context")}
        />
        {editable && missing.length > 0 && (
          <div className="settings-ideas">
            <span>{t("settings.contextMissing")}</span>
            {missing.map((label) => (
              <Button key={label} size="sm" variant="ghost" icon="plus" onClick={() => addIdea(label)}>
                {label}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <SettingsTiles />
      <UsageStatisticsCard />
      {org.role === "owner" && <DeleteWorkspaceCard />}
      <OrgLogoDialog open={logo} onClose={() => setLogo(false)} />
    </>
  );
}

/**
 * Owners, at the bottom of Geral: deleting the workspace. Its dialog is kept in the address (`?delete=1`), which the
 * phone, the account's blockers and a sign-in again open.
 */
function DeleteWorkspaceCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useOpenParam("delete");
  return (
    <Card aria-labelledby="sec-delete" className="settings-danger">
      <CardHeader
        id="sec-delete"
        icon="trash"
        title={t("deleteOrg.card.title")}
        subtitle={t("deleteOrg.card.text", { name: org.name })}
        action={
          <Button size="sm" variant="danger" onClick={() => setOpen(1)}>
            {t("deleteOrg.card.button")}
          </Button>
        }
      />
      <DeleteWorkspaceDialog org={org} open={open !== null} onClose={() => setOpen(null)} />
    </Card>
  );
}

/**
 * The usage report's switch (ADR 0060 §5): the title, the switch and "Ver o que é enviado". Only the
 * installation's owner gets it (the API answers `null` to everyone else, and on agentes.chat itself).
 */
function UsageStatisticsCard() {
  const { t } = useTranslation();
  const telemetry = useServerTelemetry();
  const set = useSetServerTelemetry();
  const [open, setOpen] = useState(false);
  const data = telemetry.data;
  if (!data) return null;
  return (
    <Card aria-labelledby="sec-telemetry">
      <CardHeader
        id="sec-telemetry"
        icon="chart"
        title={t("settings.telemetry.title")}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(true);
              void telemetry.refetch();
            }}
          >
            {t("settings.telemetry.see")}
          </Button>
        }
      />
      <div className="settings-rows">
        <div className="settings-row ac-actrow">
          <div className="settings-row__text ac-actrow__text">
            <span className="ac-hintline">
              <label className="settings-row__label" htmlFor="set-telemetry">
                {t("settings.telemetry.label")}
              </label>
              <InfoHint name={t("common.about", { label: t("settings.telemetry.label") })} id="set-telemetry-hint">
                {t("settings.telemetry.help")}
              </InfoHint>
            </span>
            {data.envOff && (
              <span className="settings-row__help" id="set-telemetry-help">
                {t(
                  data.report.install === "desktop" ? "settings.telemetry.envOffDesktop" : "settings.telemetry.envOff",
                )}
              </span>
            )}
          </div>
          <div className="settings-row__control">
            <Switch
              id="set-telemetry"
              checked={data.enabled && !data.envOff}
              onCheckedChange={(on) => set.mutate(on)}
              disabled={data.envOff || set.isPending}
              aria-describedby={data.envOff ? "set-telemetry-hint set-telemetry-help" : "set-telemetry-hint"}
            />
          </div>
        </div>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("settings.telemetry.dialogTitle")}
        description={t("settings.telemetry.dialogText")}
        closeLabel={t("common.close")}
        width={560}
      >
        <DialogBody>
          <pre className="md__code" style={{ margin: 0, maxHeight: 420 }}>
            {JSON.stringify(data.report, null, 2)}
          </pre>
        </DialogBody>
      </Dialog>
    </Card>
  );
}

/** "Tudo da organização": a tile per area the person can open, with how it is now. */
function SettingsTiles() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const server = useAuthConfig().data;
  const shown = (id: SettingsSection) => SETTINGS_SECTIONS.some((s) => s.id === id && s.allowed(org, server));
  const overview = useOverview(org.id);
  const invitations = useInvitations(org.id, can(org, "invite_people"));
  const connections = useConnections(org.id);
  const skills = useSkills(org.id, shown("skills"));
  const machines = useMachines(org.id, shown("computers"));
  const managesKeys = can(org, "manage_credentials");
  const credentials = useCredentials(org.id, managesKeys);
  const plans = useAiAccounts(org.id, shown("keys") && !managesKeys);
  const platform = usePlatformKey(org.id);
  const storage = useStorage(org.id, shown("storage"));
  const edition = computerEdition(useComputerSetup(org.id, shown("storage")).data);
  const agents = useAgents(org.id).data ?? [];
  const aiStatus = useAiStatus(org.id).data;
  // The budget's share only where the workspace uses the API: on plans alone no 0% budget (ADR 0063 §5).
  const budget =
    overview.data && workspaceUsesApi(agents, aiStatus, overview.data.budgetUsedPercent)
      ? overview.data.budgetUsedPercent
      : null;

  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const keys = (credentials.data ?? []).filter((c) => !c.revokedAt);
  const online = (machines.data ?? []).filter((m) => m.online).length;
  const pending = invitations.data?.length ?? 0;
  const state: Partial<Record<SettingsSection, string | undefined>> = {
    members:
      overview.data &&
      [
        t("settings.tileState.members", { count: overview.data.people }),
        pending > 0 ? t("settings.tileState.invitations", { count: pending }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    access: overview.data && t("settings.tileState.agents", { count: overview.data.agents }),
    connectors:
      connections.data &&
      (live.length === 0
        ? t("settings.tileState.noConnectors")
        : [
            t("settings.tileState.connectors", { count: live.length }),
            live
              .slice(0, 3)
              .map((c) => c.label)
              .join(", "),
          ].join(" · ")),
    skills: skills.data && t("settings.tileState.skills", { count: skills.data.length }),
    computers:
      machines.data &&
      (machines.data.length === 0
        ? t("settings.tileState.noComputers")
        : t("settings.tileState.computers", { count: machines.data.length, online })),
    usage:
      budget !== null ? t("settings.tileState.usage", { percent: formatPercent(i18n.language, budget) }) : undefined,
    keys: managesKeys
      ? credentials.data &&
        (keys.length > 0
          ? t("settings.tileState.keys", { count: keys.length })
          : platform.data
            ? t("settings.tileState.platformKey")
            : t("settings.tileState.noKeys"))
      : plans.data &&
        (plans.data.accounts.length > 0
          ? t("settings.tileState.plans", { count: plans.data.accounts.length })
          : t("settings.tileState.noPlans")),
    storage:
      storage.data && edition
        ? t(storage.data.kind === "s3" ? "storage.s3" : edition === "cloud" ? "storage.agentes" : "storage.server")
        : undefined,
  };
  type Tile = (typeof SETTINGS_SECTIONS)[number] & { id: Exclude<SettingsSection, "general"> };
  // The workspace's areas: "Você" is the person's own.
  const tiles = SETTINGS_SECTIONS.filter(
    (s): s is Tile => s.id !== "general" && s.group !== "you" && s.allowed(org, server),
  );
  return (
    <section className="settings-tiles" aria-labelledby="sec-tiles">
      <h2 id="sec-tiles" className="settings-tiles__title">
        {t("settings.tilesTitle")}
      </h2>
      <div className="settings-tiles__grid">
        {tiles.map((s) => (
          <Link
            key={s.id}
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: s.id }}
            className="ac-card ac-card--interactive settings-tile"
          >
            <div className="ac-card__head">
              <span className="ac-card__key" aria-hidden="true">
                <Icon name={s.icon} size={16} />
              </span>
              <div className="ac-card__heading">
                <h3>{t(`settings.section.${s.id}`)}</h3>
              </div>
              <Icon name="chevronRight" size={16} className="settings-tile__chevron" />
            </div>
            {s.id === "usage" && budget !== null && (
              <Meter value={Math.min(100, budget)} max={100} label={t("settings.section.usage")} />
            )}
            <span className="settings-tile__state">{state[s.id] ?? "\u00a0"}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function KeysSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const allowed = can(org, "manage_credentials");
  const credentials = useCredentials(org.id, allowed);
  const settings = useSettings(org.id);
  const platform = usePlatformKey(org.id);
  const updateSettings = useUpdateSettings(org.id);
  const remove = useRemoveCredential(org.id);
  const [dialog, setDialog] = useState<
    | null
    | { type: "add" }
    | { type: "rotate"; cred: Credential }
    | { type: "remove"; cred: Credential }
    | { type: "models"; cred: Credential }
  >(null);
  const look = useRightHandLook();
  const hold = usePlanHold();
  if (!allowed) return null;
  const live = (credentials.data ?? []).filter((c) => !c.revokedAt);
  const noKeys = credentials.isSuccess && live.length === 0;
  return (
    <Card aria-labelledby="sec-keys">
      <CardHeader
        id="sec-keys"
        icon="key"
        title={t("settings.keysTitle")}
        hint={{ name: t("common.about", { label: t("settings.keysTitle") }), text: t("settings.keysSubtitle") }}
        action={
          !noKeys &&
          !hold && (
            <Button size="sm" icon="plus" onClick={() => setDialog({ type: "add" })}>
              {t("settings.addKey")}
            </Button>
          )
        }
      />
      {platform.data && <p className="small muted">{t("settings.platformAvailable")}</p>}
      {credentials.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {hold && <SettingNote icon="alert">{t("connectAi.key.closed")}</SettingNote>}
      {noKeys && !hold && (
        <EmptyState
          size="panel"
          agent={look}
          title={t("settings.noKeysTitle")}
          actions={
            <Button variant="primary" icon="plus" onClick={() => setDialog({ type: "add" })}>
              {t("settings.addKey")}
            </Button>
          }
        >
          {t("settings.noKeys")}
        </EmptyState>
      )}
      {live.length > 0 && (
        <List>
          {live.map((c) => {
            const isDefault = settings.data?.defaultCredentialId === c.id;
            return (
              <div key={c.id} className="ac-list__row key-row">
                <ProviderLogo id={c.provider} size="sm" />
                <span className="list-col">
                  <span className="ac-captop" style={{ fontWeight: 600 }}>
                    {c.label}
                  </span>
                  <span className="small muted">
                    {c.endpoint
                      ? `${c.endpoint.baseURL} · `
                      : `${keyNamedAfterProvider(c) ? "" : `${providerLabel(c.provider)} · `}${t("settings.keyEndsIn", { hint: c.keyHint })} · `}
                    <span style={{ whiteSpace: "nowrap" }}>
                      {t("settings.keyAdded", { when: relativeTime(t, i18n.language, c.createdAt) })}
                    </span>
                  </span>
                </span>
                <span className="key-row__tail ac-captail ac-captop">
                  {c.endpoint ? (
                    <Button variant="ghost" size="sm" onClick={() => setDialog({ type: "models", cred: c })}>
                      {t("endpoint.models")}
                    </Button>
                  ) : isDefault ? (
                    <Chip icon="check">{t("settings.default")}</Chip>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={updateSettings.isPending}
                      loading={updateSettings.isPending}
                      onClick={() => updateSettings.mutate({ defaultCredentialId: c.id })}
                    >
                      {t("settings.makeDefault")}
                    </Button>
                  )}
                  <div className="row" style={{ gap: 4 }}>
                    {!hold && (
                      <Button variant="ghost" size="sm" onClick={() => setDialog({ type: "rotate", cred: c })}>
                        {t("settings.rotate")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ac-btn--danger"
                      onClick={() => setDialog({ type: "remove", cred: c })}
                    >
                      {t("settings.remove")}
                    </Button>
                  </div>
                </span>
              </div>
            );
          })}
        </List>
      )}
      {live.some((c) => c.provider === "openrouter") && <AutoModelsRow />}
      <KeyDialog
        mode={dialog?.type === "add" ? "add" : dialog?.type === "rotate" ? "rotate" : null}
        cred={dialog && dialog.type !== "add" ? dialog.cred : undefined}
        onClose={() => setDialog(null)}
      />
      <Dialog
        open={dialog?.type === "models"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("endpoint.modelsTitle", { name: dialog?.type === "models" ? dialog.cred.label : "" })}
        closeLabel={t("common.close")}
        width={520}
      >
        {dialog?.type === "models" && (
          <EndpointForm
            orgId={org.id}
            credential={dialog.cred}
            onCancel={() => setDialog(null)}
            onDone={() => setDialog(null)}
          />
        )}
      </Dialog>
      <Dialog
        open={dialog?.type === "remove"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("settings.removeTitle", { label: dialog?.type === "remove" ? dialog.cred.label : "" })}
        description={dialog?.type === "remove" ? keyRemovalText(t, dialog.cred, live, platform.data === true) : ""}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDialog(null)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            loading={remove.isPending}
            onClick={() => {
              if (dialog?.type !== "remove") return;
              remove.mutate({ id: dialog.cred.id, purge: true, release: true }, { onSuccess: () => setDialog(null) });
            }}
          >
            {t("settings.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

/**
 * Adds or rotates a key. The Connect dialog (`ConnectAi`) opens it to add one with the provider it
 * guessed, or the key a person pasted in the chat, and hears when it was saved (`onAdded`).
 */
export function KeyDialog({
  mode,
  cred,
  onClose,
  provider: suggested,
  apiKey: pasted,
  title,
  onAdded,
}: {
  mode: "add" | "rotate" | null;
  cred: Credential | undefined;
  onClose: () => void;
  provider?: string;
  apiKey?: string;
  title?: string;
  onAdded?: (cred: Credential) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const add = useAddCredential(org.id, true);
  const rotate = useRotateCredential(org.id, true);
  const [refused, setRefused] = useState<ReturnType<typeof keyRefusal>>(null);
  const failed = (e: unknown) => {
    setRefused(keyRefusal(t, e));
    if (!keyRefusal(t, e)) toast.show(errorText(t, e), "error");
  };
  const unchecked = (saved: Credential) => {
    if (saved.check === "unchecked")
      toast.show(t("connectAi.key.savedUnchecked", { provider: providerLabel(saved.provider) }), "info");
  };
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  // "Outro provedor" (ADR 0146): its own form instead of a key's.
  const [custom, setCustom] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [touched, setTouched] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form each time it opens
  useEffect(() => {
    setLabel("");
    setApiKey(pasted ?? "");
    setWorkspaceId("");
    setProvider(providerGuess(pasted, suggested ?? cred?.provider));
    setCustom(mode === "add" && suggested === CUSTOM_PROVIDER);
    setTouched(false);
    setRefused(null);
  }, [mode, cred]);
  const valid = keyLooksValid(provider, apiKey);
  const error =
    !touched || valid ? undefined : mode === "add" ? (
      <KeyMismatch provider={provider} apiKey={apiKey} onPick={setProvider} />
    ) : (
      t(`onboarding.keyInvalid.${provider}`)
    );
  const pending = add.isPending || rotate.isPending;
  const providerSelect = (
    <Field label={t("settings.provider")} id="key-provider">
      <ProviderKeySelect
        value={custom ? CUSTOM_PROVIDER : provider}
        disabled={pending}
        onChange={(v) => {
          setCustom(v === CUSTOM_PROVIDER);
          if (v !== CUSTOM_PROVIDER) setProvider(v);
        }}
      />
    </Field>
  );
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(o) => !o && onClose()}
      title={
        mode === "rotate"
          ? t("settings.rotateTitle", { label: cred?.label ?? "" })
          : (title ?? t("settings.addKeyTitle"))
      }
      description={mode === "rotate" ? t("settings.rotateHelp") : undefined}
      closeLabel={t("common.close")}
      width={440}
    >
      {custom && mode === "add" ? (
        <EndpointForm
          orgId={org.id}
          lead={providerSelect}
          onCancel={onClose}
          onDone={(saved) => {
            onAdded?.(saved);
            onClose();
          }}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!valid) return;
            setRefused(null);
            if (mode === "rotate" && cred) {
              rotate.mutate(
                { id: cred.id, apiKey: apiKey.trim() },
                {
                  onError: failed,
                  onSuccess: (saved) => {
                    toast.show(t("settings.rotated"));
                    unchecked(saved);
                    onClose();
                  },
                },
              );
            } else {
              add.mutate(
                {
                  provider,
                  label: label.trim() || providerLabel(provider),
                  apiKey: apiKey.trim(),
                  ...(provider === "anthropic" && workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
                },
                {
                  onError: failed,
                  onSuccess: (saved) => {
                    unchecked(saved);
                    onAdded?.(saved);
                    onClose();
                  },
                },
              );
            }
          }}
        >
          <Locked when={pending}>
            <DialogBody>
              {mode === "add" && providerSelect}
              {mode === "add" && (
                <Field label={t("settings.keyLabel")} id="key-label">
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t("settings.keyLabelPlaceholder", { provider: providerLabel(provider) })}
                  />
                </Field>
              )}
              <Field
                label={t("settings.keyValue")}
                id="key-value-set"
                error={error}
                help={<KeySite provider={provider} />}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={providerOf(provider)?.placeholder}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </Field>
              {refused && <KeyRefused refusal={refused} />}
              {mode === "add" && provider === "anthropic" && (
                <Field
                  label={t("onboarding.anthropicWorkspace")}
                  id="key-ws-set"
                  hint={{
                    name: t("common.about", { label: t("onboarding.anthropicWorkspace") }),
                    text: t("onboarding.anthropicWorkspaceHelp"),
                  }}
                >
                  <Input
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    placeholder={t("settings.workspaceIdPlaceholder")}
                    autoComplete="off"
                  />
                </Field>
              )}
            </DialogBody>
          </Locked>
          <DialogFooter>
            <Button onClick={onClose} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {mode === "rotate" ? t("settings.rotate") : t("settings.saveKey")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/**
 * Uso (ADR 0063): the plan accounts by computer and the API per agent for everyone (money only for
 * admins), then the API's spend by kind and the default budget (admins).
 */
function UsageSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const allowed = can(org, "view_usage");
  const report = useUsageReport(org.id, allowed);
  // Calls, not money: every member sees them.
  const composio = useComposioUsage(org.id);
  return (
    <>
      <PlanUsageCards />
      {composio.data && showsComposioUsage(composio.data) && (
        <Card>
          <span className="small">{composioUsageText(t, i18n.language, composio.data)}</span>
        </Card>
      )}
      {allowed && (
        <Card aria-labelledby="sec-usage">
          <CardHeader id="sec-usage" icon="chart" title={t("settings.usageTitle")} />
          {report.isLoading && <LoadingList count={4} avatar={false} trailing />}
          {report.isError && !report.data && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
          {report.data && (
            <>
              <span className="small muted">
                {t("settings.usageTotal", {
                  amount: formatUsd(i18n.language, report.data.totalUsd),
                  since: formatShortDate(i18n.language, report.data.since),
                })}
              </span>
              <div>
                {report.data.byKind.map((k) => (
                  <div key={k.kind} className="connector-row">
                    <span className="connector-row__name">{t(`settings.kinds.${k.kind}`)}</span>
                    <span className="connector-row__granted tabular">
                      {t("settings.usageCalls", { count: k.calls })}
                    </span>
                    <span className="tabular">{formatUsd(i18n.language, k.costUsd)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}
      {allowed && <DefaultBudgetCard />}
    </>
  );
}

/** Budget of every agent without its own; members only ever see percentages of it. */
function DefaultBudgetCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const toast = useToast();
  const editable = can(org, "configure");
  const saved = settings.data?.defaultAgentBudgetUsd;
  const [value, setValue] = useState("");
  useEffect(() => {
    if (saved !== undefined) setValue(new Intl.NumberFormat(i18n.language).format(saved));
  }, [saved, i18n.language]);
  const amount = parseAmount(value);
  const invalid = value.trim() !== "" && !(amount > 0);
  const dirty = saved !== undefined && amount > 0 && amount !== saved;
  return (
    <Card aria-labelledby="sec-default-budget">
      <CardHeader id="sec-default-budget" icon="wallet" title={t("settings.defaultBudgetTitle")} />
      <form
        className="row"
        style={{ gap: 12, alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty) return;
          update.mutate(
            { defaultAgentBudgetUsd: amount },
            { onSuccess: () => toast.show(t("settings.defaultBudgetSaved")) },
          );
        }}
      >
        <Locked when={update.isPending}>
          <Field
            label={t("settings.defaultBudget")}
            id="set-default-budget"
            hint={{
              name: t("common.about", { label: t("settings.defaultBudget") }),
              text: t("settings.defaultBudgetHelp"),
            }}
            error={invalid ? t("agent.budgetInvalid") : undefined}
          >
            <Input
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              readOnly={!editable}
              disabled={saved === undefined}
            />
          </Field>
        </Locked>
        {editable && (
          <Button type="submit" variant="primary" disabled={!dirty || update.isPending} loading={update.isPending}>
            {t("common.save")}
          </Button>
        )}
      </form>
    </Card>
  );
}
