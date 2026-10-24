import type { Credential, OrgSettings } from "@agenteschat/client";
import {
  useAddCredential,
  useAiAccounts,
  useConnections,
  useCredentials,
  useInvitations,
  useMachines,
  useOverview,
  usePlatformKey,
  useRemoveCredential,
  useRotateCredential,
  useSettings,
  useSkills,
  useStorage,
  useUpdateSettings,
  useUsageReport,
} from "@agenteschat/client";
import { formatPercent, formatShortDate, formatUsd, relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  isProviderId,
  keyLooksValid,
  PROVIDERS,
  type ProviderId,
  providerLabel,
  providerOf,
  providersForKey,
} from "@agenteschat/client/lib/providers";
import { parseAmount } from "@agenteschat/client/lib/text";
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  List,
  Meter,
  ProviderLogo,
  Select,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessMatrixSection } from "@/components/AccessLevels";
import { AiAccountsSection } from "@/components/ai/AiAccounts";
import { ComputersSection } from "@/components/Computers";
import { ConnectorsSection } from "@/components/Connectors";
import { ImportExportSection } from "@/components/ImportFlow";
import { ErrorState, LoadingList } from "@/components/Loading";
import { MachinePage } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { PlanUsageCards } from "@/components/PlanUsage";
import { OrgLogoDialog, OrgMark } from "@/components/ProfilePhoto";
import { KeyMismatch, KeySite } from "@/components/ProviderKey";
import { SkillsSection } from "@/components/Skills";
import { StorageSection } from "@/components/StorageSettings";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useToast } from "@/lib/toast";
import { MembersPage } from "./MembersPage";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from "./settings-sections";

/**
 * Settings: a left sub-nav and one section per URL (`/settings/connectors`, …).
 * Members only see what they can open.
 */
export function SettingsPage({
  section = "general",
  connected,
  review,
  mail,
  machineId,
}: {
  section?: SettingsSection;
  connected?: string;
  review?: boolean;
  /** Back from Gmail/Outlook: `connected` or `failed`. */
  mail?: string;
  /** Computadores → one computer (`/settings/computers/{id}`). */
  machineId?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const visible = SETTINGS_SECTIONS.filter((s) => s.allowed(org.role));
  const current = visible.some((s) => s.id === section) ? section : "general";

  return (
    <div className="settings">
      <nav className="settings__nav" aria-label={t("settings.nav")}>
        <div className="settings__head">
          <h1 className="settings__title">{t("settings.title")}</h1>
          <span className="settings__org">
            <OrgMark logo={org.logo} size={18} />
            <span>{org.name}</span>
          </span>
        </div>
        <div className="settings__groups">
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
                        <Icon name={s.icon} size={18} />
                        {t(`settings.section.${s.id}`)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="settings__body">
        {current !== "members" && current !== "general" && (
          <header className="page__header">
            <h2 className="page-title">{t(`settings.section.${current}`)}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {t(`settings.sectionText.${current}`)}
            </p>
          </header>
        )}
        {current === "general" && <GeneralSection />}
        {current === "members" && <MembersPage embedded />}
        {current === "access" && <AccessMatrixSection />}
        {current === "connectors" && <ConnectorsSection connected={connected} review={review} mail={mail} />}
        {current === "skills" && <SkillsSection />}
        {current === "keys" && (
          <>
            <AiAccountsSection />
            <KeysSection />
          </>
        )}
        {current === "storage" && <StorageSection />}
        {current === "computers" && (machineId ? <MachinePage machineId={machineId} /> : <ComputersSection />)}
        {current === "usage" && <UsageSection />}
        {current === "import" && <ImportExportSection />}
      </div>
    </div>
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
  const editable = can(org.role, "configure");
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
  const missing = ideas.filter((label) => !context.toLowerCase().includes(label.toLowerCase()));

  return (
    <>
      <header className="page__header page__header--row">
        <div className="page__header-text">
          <h2 className="page-title">{t("settings.section.general")}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("settings.sectionText.general")}
          </p>
        </div>
        <span className="settings__saved" data-on={saved || undefined} role="status">
          {saved && (
            <>
              <Icon name="check" size={16} />
              {t("settings.savedShort")}
            </>
          )}
        </span>
      </header>
      {!editable && <p className="page__note">{t("settings.readOnly")}</p>}

      <Card aria-label={t("settings.orgTitle")}>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row__text">
              <span className="settings-row__label">{t("orgLogo.label")}</span>
              <span className="settings-row__help">{t("orgLogo.labelHelp")}</span>
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
          <div className="settings-row">
            <div className="settings-row__text">
              <label className="settings-row__label" htmlFor="set-name">
                {t("settings.name")}
              </label>
              <span className="settings-row__help">{t("settings.nameHelp")}</span>
            </div>
            <div className="settings-row__control">
              <Input
                id="set-name"
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
          <div className="settings-row">
            <div className="settings-row__text">
              <span className="settings-row__label">{t("settings.timezone")}</span>
              <span className="settings-row__help">{t("settings.timezoneHelp")}</span>
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
          <div className="settings-row">
            <div className="settings-row__text">
              <label className="settings-row__label" htmlFor="set-action-check">
                {t("settings.actionCheck")}
              </label>
              <span className="settings-row__help" id="set-action-check-help">
                {t("settings.actionCheckHelp")}
              </span>
            </div>
            <div className="settings-row__control">
              <Switch
                id="set-action-check"
                checked={settings.data?.actionCheck ?? true}
                onCheckedChange={(on) => save({ actionCheck: on })}
                disabled={!editable || !settings.data}
                aria-describedby="set-action-check-help"
              />
            </div>
          </div>
        </div>
      </Card>

      <Card aria-labelledby="sec-context">
        <CardHeader
          id="sec-context"
          icon="agent"
          title={t("settings.contextTitle", { name: name.trim() || org.name })}
          subtitle={t("settings.contextSubtitle")}
        />
        <Textarea
          ref={contextRef}
          rows={7}
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
        <CardFooter>{t("settings.contextHelp", { name: name.trim() || org.name })}</CardFooter>
      </Card>

      <SettingsTiles />
      <OrgLogoDialog open={logo} onClose={() => setLogo(false)} />
    </>
  );
}

/** "Tudo da organização": a tile per area the person can open, with how it is now. */
function SettingsTiles() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const role = org.role;
  const shown = (id: SettingsSection) => SETTINGS_SECTIONS.some((s) => s.id === id && s.allowed(role));
  const overview = useOverview(org.id);
  const invitations = useInvitations(org.id, can(role, "manage_members"));
  const connections = useConnections(org.id);
  const skills = useSkills(org.id, shown("skills"));
  const machines = useMachines(org.id, shown("computers"));
  const managesKeys = can(role, "manage_credentials");
  const credentials = useCredentials(org.id, managesKeys);
  const plans = useAiAccounts(org.id, shown("keys") && !managesKeys);
  const platform = usePlatformKey(org.id);
  const storage = useStorage(org.id, shown("storage"));

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
      overview.data &&
      t("settings.tileState.usage", { percent: formatPercent(i18n.language, overview.data.budgetUsedPercent) }),
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
    storage: storage.data && t(storage.data.kind === "s3" ? "storage.s3" : "storage.agentes"),
  };
  type Tile = (typeof SETTINGS_SECTIONS)[number] & { id: Exclude<SettingsSection, "general"> };
  const tiles = SETTINGS_SECTIONS.filter((s): s is Tile => s.id !== "general" && s.allowed(role));
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
                <p className="ac-card__sub">{t(`settings.tile.${s.id}`)}</p>
              </div>
              <Icon name="chevronRight" size={16} className="settings-tile__chevron" />
            </div>
            {s.id === "usage" && overview.data && (
              <Meter
                value={Math.min(100, overview.data.budgetUsedPercent)}
                max={100}
                label={t("settings.section.usage")}
              />
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
  const allowed = can(org.role, "manage_credentials");
  const credentials = useCredentials(org.id, allowed);
  const settings = useSettings(org.id);
  const platform = usePlatformKey(org.id);
  const updateSettings = useUpdateSettings(org.id);
  const remove = useRemoveCredential(org.id);
  const [dialog, setDialog] = useState<
    null | { type: "add" } | { type: "rotate"; cred: Credential } | { type: "remove"; cred: Credential }
  >(null);
  if (!allowed) return null;
  const live = (credentials.data ?? []).filter((c) => !c.revokedAt);
  return (
    <Card aria-labelledby="sec-keys">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-keys" className="ac-card__title">
            {t("settings.keysTitle")}
          </h2>
          <span className="small muted">{t("settings.keysSubtitle")}</span>
        </div>
        <Button size="sm" icon="plus" onClick={() => setDialog({ type: "add" })}>
          {t("settings.addKey")}
        </Button>
      </div>
      {platform.data && <p className="small muted">{t("settings.platformAvailable")}</p>}
      {credentials.isLoading && <LoadingList count={2} avatar={false} trailing />}
      {credentials.isSuccess && live.length === 0 && <p className="small muted">{t("settings.noKeys")}</p>}
      {live.length > 0 && (
        <List>
          {live.map((c) => {
            const isDefault = settings.data?.defaultCredentialId === c.id;
            return (
              <div key={c.id} className="ac-list__row">
                <ProviderLogo id={c.provider} size="sm" />
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>{c.label}</span>
                  <span className="small muted">
                    {providerLabel(c.provider)} · {t("settings.keyEndsIn", { hint: c.keyHint })} ·{" "}
                    {t("settings.keyAdded", { when: relativeTime(t, i18n.language, c.createdAt) })}
                  </span>
                </span>
                {isDefault ? (
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
                  <Button variant="ghost" size="sm" onClick={() => setDialog({ type: "rotate", cred: c })}>
                    {t("settings.rotate")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ac-btn--danger"
                    disabled={isDefault}
                    title={isDefault ? t("settings.removeDefaultBlocked") : undefined}
                    aria-describedby={isDefault ? `default-note-${c.id}` : undefined}
                    onClick={() => setDialog({ type: "remove", cred: c })}
                  >
                    {t("settings.remove")}
                  </Button>
                  {isDefault && (
                    <span id={`default-note-${c.id}`} className="ac-visually-hidden">
                      {t("settings.removeDefaultBlocked")}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </List>
      )}
      <KeyDialog
        mode={dialog?.type === "add" ? "add" : dialog?.type === "rotate" ? "rotate" : null}
        cred={dialog && dialog.type !== "add" ? dialog.cred : undefined}
        onClose={() => setDialog(null)}
      />
      <Dialog
        open={dialog?.type === "remove"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("settings.removeTitle", { label: dialog?.type === "remove" ? dialog.cred.label : "" })}
        description={t("settings.removeText")}
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
              remove.mutate({ id: dialog.cred.id, purge: true }, { onSuccess: () => setDialog(null) });
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
  const add = useAddCredential(org.id);
  const rotate = useRotateCredential(org.id);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [workspaceId, setWorkspaceId] = useState("");
  const [touched, setTouched] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form each time it opens
  useEffect(() => {
    setLabel("");
    setApiKey(pasted ?? "");
    setWorkspaceId("");
    // A pasted key says whose it is when only one provider's keys look like it; else the provider asked for.
    const fits = pasted ? providersForKey(pasted) : [];
    const guess = (fits.length === 1 ? fits[0]?.id : undefined) ?? suggested ?? fits[0]?.id ?? cred?.provider;
    setProvider(guess && isProviderId(guess) ? guess : "anthropic");
    setTouched(false);
  }, [mode, cred]);
  const valid = keyLooksValid(provider, apiKey);
  const error =
    !touched || valid ? undefined : mode === "add" ? (
      <KeyMismatch provider={provider} apiKey={apiKey} onPick={setProvider} />
    ) : (
      t(`onboarding.keyInvalid.${provider}`)
    );
  const pending = add.isPending || rotate.isPending;
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!valid) return;
          if (mode === "rotate" && cred) {
            rotate.mutate(
              { id: cred.id, apiKey: apiKey.trim() },
              {
                onSuccess: () => {
                  toast.show(t("settings.rotated"));
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
                onSuccess: (saved) => {
                  onAdded?.(saved);
                  onClose();
                },
              },
            );
          }
        }}
      >
        <DialogBody>
          {mode === "add" && (
            <Field label={t("settings.provider")} id="key-provider">
              <Select
                value={provider}
                onValueChange={setProvider}
                options={PROVIDERS.map((p) => ({
                  value: p.id,
                  label: p.label,
                  leading: <ProviderLogo id={p.id} size="xs" />,
                }))}
                renderValue={(o) => (
                  <span className="row">
                    {o.leading}
                    {o.label}
                  </span>
                )}
              />
            </Field>
          )}
          {mode === "add" && (
            <Field label={t("settings.keyLabel")} id="key-label">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("settings.keyLabelPlaceholder")}
              />
            </Field>
          )}
          <Field
            label={t("settings.keyValue")}
            id="key-value-set"
            error={error}
            help={
              <>
                <KeySite provider={provider} /> {t("connectors.apiKeyHelp")}
              </>
            }
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder={providerOf(provider)?.placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          {mode === "add" && provider === "anthropic" && (
            <Field
              label={t("onboarding.anthropicWorkspace")}
              id="key-ws-set"
              help={t("onboarding.anthropicWorkspaceHelp")}
            >
              <Input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} autoComplete="off" />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {mode === "rotate" ? t("settings.rotate") : t("settings.saveKey")}
          </Button>
        </DialogFooter>
      </form>
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
  const allowed = can(org.role, "view_usage");
  const report = useUsageReport(org.id, allowed);
  return (
    <>
      <PlanUsageCards />
      {allowed && (
        <Card aria-labelledby="sec-usage">
          <h2 id="sec-usage" className="ac-card__title">
            {t("settings.usageTitle")}
          </h2>
          {report.isLoading && <LoadingList count={4} avatar={false} trailing />}
          {report.isError && !report.data && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
          {report.data && (
            <>
              <span className="small muted">
                {t("settings.usageTotal", {
                  amount: formatUsd(t, i18n.language, report.data.totalUsd),
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
                    <span className="tabular">{formatUsd(t, i18n.language, k.costUsd)}</span>
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
  const editable = can(org.role, "configure");
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
      <h2 id="sec-default-budget" className="ac-card__title">
        {t("settings.defaultBudgetTitle")}
      </h2>
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
        <Field
          label={t("settings.defaultBudget")}
          id="set-default-budget"
          help={t("settings.defaultBudgetHelp")}
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
        {editable && (
          <Button type="submit" variant="primary" disabled={!dirty || update.isPending} loading={update.isPending}>
            {t("common.save")}
          </Button>
        )}
      </form>
    </Card>
  );
}
