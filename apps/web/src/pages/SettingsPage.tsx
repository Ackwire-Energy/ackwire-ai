import {
  Button,
  Card,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  type IconName,
  Input,
  List,
  Select,
  Textarea,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddCredential,
  useCredentials,
  usePlatformKey,
  useRemoveCredential,
  useRotateCredential,
  useSettings,
  useUpdateSettings,
  useUsageReport,
} from "@/api/queries";
import type { Credential, Role } from "@/api/types";
import { AccessMatrixSection } from "@/components/AccessLevels";
import { SandboxSection } from "@/components/AgentComputer";
import { ConnectorsSection } from "@/components/Connectors";
import { ErrorState, LoadingList } from "@/components/Loading";
import { MachinesSection } from "@/components/Machines";
import { useOrg } from "@/components/org-context";
import { OrgLogoDialog, OrgMark } from "@/components/ProfilePhoto";
import { SkillsSection } from "@/components/Skills";
import { StorageSection } from "@/components/StorageSettings";
import { ZoneSelect } from "@/components/ZoneSelect";
import { formatShortDate, formatUsd, relativeTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import { isProviderId, keyLooksValid, PROVIDERS, type ProviderId, providerLabel } from "@/lib/providers";
import { useToast } from "@/lib/toast";
import { MembersPage } from "./MembersPage";

export type SettingsSection =
  | "general"
  | "members"
  | "access"
  | "connectors"
  | "skills"
  | "keys"
  | "storage"
  | "sandbox"
  | "computers"
  | "usage";

/** The settings sub-nav, in order, with who can open each. */
export const SETTINGS_SECTIONS: { id: SettingsSection; icon: IconName; allowed: (role: Role) => boolean }[] = [
  { id: "general", icon: "settings", allowed: () => true },
  { id: "members", icon: "members", allowed: () => true },
  { id: "access", icon: "agent", allowed: (r) => can(r, "configure") },
  { id: "connectors", icon: "link", allowed: () => true },
  { id: "skills", icon: "document", allowed: (r) => can(r, "configure") },
  { id: "keys", icon: "approve", allowed: (r) => can(r, "manage_credentials") },
  { id: "storage", icon: "drive", allowed: (r) => can(r, "configure") },
  { id: "sandbox", icon: "code", allowed: (r) => can(r, "configure") },
  // Every member sees the connected computers and can pair one (ADR 0025).
  { id: "computers", icon: "computer", allowed: (r) => can(r, "read") },
  { id: "usage", icon: "waiting", allowed: (r) => can(r, "view_usage") },
];

export const isSettingsSection = (v: unknown): v is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === v);

/** `?connected=github` (back from OAuth) and `?review=1` (a custom MCP server to classify). */
export const settingsSearch = (search: Record<string, unknown>): { connected?: string; review?: string } => ({
  connected: typeof search.connected === "string" ? search.connected : undefined,
  review: search.review === undefined ? undefined : String(search.review),
});

/**
 * Settings: a left sub-nav and one section per URL (`/settings/connectors`, …).
 * Members only see what they can open.
 */
export function SettingsPage({
  section = "general",
  connected,
  review,
}: {
  section?: SettingsSection;
  connected?: string;
  review?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const visible = SETTINGS_SECTIONS.filter((s) => s.allowed(org.role));
  const current = visible.some((s) => s.id === section) ? section : "general";

  return (
    <div className="settings">
      <nav className="settings__nav" aria-label={t("settings.nav")}>
        <h1 className="settings__title">{t("settings.title")}</h1>
        <ul>
          {visible.map((s) => (
            <li key={s.id}>
              <Link
                to="/org/$orgId/settings/$section"
                params={{ orgId: org.id, section: s.id }}
                className="settings__link"
                aria-current={s.id === current ? "page" : undefined}
              >
                <Icon name={s.icon} />
                {t(`settings.section.${s.id}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings__body">
        {current !== "members" && (
          <header className="page__header">
            <h2 className="page-title">{t(`settings.section.${current}`)}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {t(`settings.sectionText.${current}`)}
            </p>
          </header>
        )}
        {current === "general" && (
          <>
            {!can(org.role, "configure") && <p className="page__note">{t("settings.readOnly")}</p>}
            <OrgSection />
          </>
        )}
        {current === "members" && <MembersPage embedded />}
        {current === "access" && <AccessMatrixSection />}
        {current === "connectors" && <ConnectorsSection connected={connected} review={review} />}
        {current === "skills" && <SkillsSection />}
        {current === "keys" && <KeysSection />}
        {current === "storage" && <StorageSection />}
        {current === "sandbox" && <SandboxSection />}
        {current === "computers" && <MachinesSection />}
        {current === "usage" && <UsageSection />}
      </div>
    </div>
  );
}

function OrgSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const toast = useToast();
  const editable = can(org.role, "configure");
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [timezone, setTimezone] = useState("");
  const [logo, setLogo] = useState(false);
  useEffect(() => {
    if (!settings.data) return;
    setName(settings.data.name);
    setContext(settings.data.context);
    setTimezone(settings.data.timezone);
  }, [settings.data]);
  const dirty =
    settings.data &&
    (name !== settings.data.name || context !== settings.data.context || timezone !== settings.data.timezone);
  return (
    <Card aria-labelledby="sec-org">
      <h2 id="sec-org" className="ac-card__title">
        {t("settings.orgTitle")}
      </h2>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          update.mutate(
            { name: name.trim(), context, timezone: timezone.trim() },
            { onSuccess: () => toast.show(t("settings.saved")) },
          );
        }}
      >
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <OrgMark logo={org.logo} size={48} className="settings__org-logo" />
          <div className="stack-4" style={{ gap: 2, flex: 1 }}>
            <span style={{ fontWeight: 600 }}>{t("orgLogo.label")}</span>
            <span className="small muted">{t("orgLogo.labelHelp")}</span>
          </div>
          {editable && (
            <Button size="sm" type="button" onClick={() => setLogo(true)}>
              {org.logo ? t("orgLogo.change") : t("orgLogo.add")}
            </Button>
          )}
        </div>
        <div className="grid-fields">
          <Field label={t("settings.name")} id="set-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!editable} />
          </Field>
          <Field label={t("settings.timezone")} id="set-tz" help={t("settings.timezoneHelp")}>
            <ZoneSelect value={timezone || "UTC"} onChange={setTimezone} disabled={!editable} />
          </Field>
        </div>
        <Field label={t("settings.context")} id="set-ctx" help={t("settings.contextHelp")}>
          <Textarea rows={6} value={context} onChange={(e) => setContext(e.target.value)} readOnly={!editable} />
        </Field>
        {editable && (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty || !name.trim() || update.isPending}
              loading={update.isPending}
            >
              {t("settings.save")}
            </Button>
          </div>
        )}
      </form>
      <OrgLogoDialog open={logo} onClose={() => setLogo(false)} />
    </Card>
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

function KeyDialog({
  mode,
  cred,
  onClose,
}: {
  mode: "add" | "rotate" | null;
  cred: Credential | undefined;
  onClose: () => void;
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
    setApiKey("");
    setWorkspaceId("");
    setProvider(cred && isProviderId(cred.provider) ? cred.provider : "anthropic");
    setTouched(false);
  }, [mode, cred]);
  const valid = keyLooksValid(provider, apiKey);
  const error = touched && !valid ? t(`onboarding.keyInvalid.${provider}`) : undefined;
  const pending = add.isPending || rotate.isPending;
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(o) => !o && onClose()}
      title={mode === "rotate" ? t("settings.rotateTitle", { label: cred?.label ?? "" }) : t("settings.addKeyTitle")}
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
              { onSuccess: onClose },
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
                options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
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
          <Field label={t("settings.keyValue")} id="key-value-set" error={error} help={t("connectors.apiKeyHelp")}>
            <Input
              type="password"
              autoComplete="off"
              placeholder={PROVIDERS.find((p) => p.id === provider)?.placeholder}
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

function UsageSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const allowed = can(org.role, "view_usage");
  const report = useUsageReport(org.id, allowed);
  if (!allowed) return null;
  return (
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
                <span className="connector-row__granted tabular">{t("settings.usageCalls", { count: k.calls })}</span>
                <span className="tabular">{formatUsd(t, i18n.language, k.costUsd)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
