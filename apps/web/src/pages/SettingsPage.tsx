import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Field,
  Input,
  List,
  Textarea,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddCredential,
  useCatalog,
  useConnections,
  useConnectWithKey,
  useCredentials,
  useDisconnect,
  usePlatformKey,
  useRemoveCredential,
  useRotateCredential,
  useSettings,
  useStartOAuth,
  useUpdateSettings,
  useUsageReport,
} from "@/api/queries";
import type { Connection, ConnectorDef, Credential } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { formatShortDate, formatUsd, relativeTime } from "@/lib/format";
import { navigateAway } from "@/lib/navigate";
import { can } from "@/lib/permissions";
import { connectorDescription } from "@/lib/scopes";
import { useToast } from "@/lib/toast";

const isHttps = (v: string) => /^https:\/\/[^\s/]+/.test(v.trim());

/** Connector search over label, id and description. */
export function searchCatalog(list: ConnectorDef[], query: string) {
  const q = query.trim().toLowerCase();
  return q ? list.filter((d) => `${d.label} ${d.id} ${d.description}`.toLowerCase().includes(q)) : list;
}

/** Organization settings: context, connectors (two-layer, D7), provider keys and usage. */
export function SettingsPage({ connected }: { connected?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const catalog = useCatalog();

  // Back from the OAuth provider: `?connected=github`.
  useEffect(() => {
    if (!connected || !catalog.data) return;
    const name = catalog.data.connectors.find((d) => d.id === connected)?.label ?? connected;
    toast.show(t("connectors.connectedToast", { name }));
    window.history.replaceState(null, "", window.location.pathname);
  }, [connected, catalog.data, toast, t]);

  return (
    <div className="page page--wide">
      <header className="page__header">
        <h1 className="page-title">{t("settings.title")}</h1>
      </header>
      {!can(org.role, "configure") && <p className="page__note">{t("settings.readOnly")}</p>}
      <OrgSection />
      <ConnectorsSection />
      <KeysSection />
      <UsageSection />
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
        <div className="grid-fields">
          <Field label={t("settings.name")} id="set-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!editable} />
          </Field>
          <Field label={t("settings.timezone")} id="set-tz" help={t("settings.timezoneHelp")}>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} readOnly={!editable} />
          </Field>
        </div>
        <Field label={t("settings.context")} id="set-ctx" help={t("settings.contextHelp")}>
          <Textarea rows={6} value={context} onChange={(e) => setContext(e.target.value)} readOnly={!editable} />
        </Field>
        {editable && (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button type="submit" variant="primary" disabled={!dirty || !name.trim() || update.isPending}>
              {t("settings.save")}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function ConnectorsSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const disconnect = useDisconnect(org.id);
  const toast = useToast();
  const admin = can(org.role, "configure");
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState<ConnectorDef | null>(null);
  const [removing, setRemoving] = useState<{ connection: Connection; def: ConnectorDef } | null>(null);
  const active = (connections.data ?? []).filter((c) => !c.revokedAt);
  const defOf = (c: Connection) => catalog.data?.connectors.find((d) => d.id === c.connector);

  return (
    <Card aria-labelledby="sec-conn">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-conn" className="ac-card__title">
            {t("connectors.title")}
          </h2>
          <span className="small muted">{t("connectors.subtitle", { org: org.name })}</span>
        </div>
        {admin && (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            {t("connectors.add")}
          </Button>
        )}
      </div>
      {connections.isSuccess && active.length === 0 && <p className="small muted">{t("connectors.none")}</p>}
      {active.length > 0 && (
        <List>
          {active.map((c) => {
            const def = defOf(c);
            return (
              <div key={c.id} className="ac-list__row">
                <span className="list-col">
                  <span style={{ fontWeight: 600 }}>{def?.label ?? c.label}</span>
                  <span className="small muted">
                    {c.accountLabel
                      ? t("connectors.connectedAs", { account: c.accountLabel })
                      : t("connectors.connectedAt", { when: formatShortDate(i18n.language, c.createdAt) })}{" "}
                    · {c.authType === "oauth" ? t("connectors.viaOAuth") : t("connectors.viaKey")}
                  </span>
                </span>
                <Chip icon="check" tone="done">
                  {t("connectors.connected")}
                </Chip>
                {admin && def && (
                  <div className="row" style={{ gap: 4 }}>
                    <Button variant="ghost" size="sm" onClick={() => setConnecting(def)}>
                      {t("connectors.reconnect")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ac-btn--danger"
                      onClick={() => setRemoving({ connection: c, def })}
                    >
                      {t("connectors.disconnect")}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </List>
      )}

      <AddConnectorDialog
        open={adding}
        onOpenChange={setAdding}
        connectors={catalog.data?.connectors ?? []}
        connected={new Set(active.map((c) => c.connector))}
        onPick={(def) => {
          setAdding(false);
          setConnecting(def);
        }}
      />
      <ConnectDialog def={connecting} onClose={() => setConnecting(null)} />
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("connectors.disconnectTitle", { name: removing?.def.label ?? "" })}
        description={t("connectors.disconnectText", { name: removing?.def.label ?? "" })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={disconnect.isPending}
            onClick={() => {
              if (!removing) return;
              disconnect.mutate(removing.connection.id, {
                onSuccess: () => {
                  toast.show(t("connectors.disconnected", { name: removing.def.label }));
                  setRemoving(null);
                },
              });
            }}
          >
            {t("connectors.disconnect")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

/** "Adicionar conector": the catalog in a searchable list. */
function AddConnectorDialog({
  open,
  onOpenChange,
  connectors,
  connected,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorDef[];
  connected: Set<string>;
  onPick: (def: ConnectorDef) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const shown = searchCatalog(connectors, q);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("connectors.addTitle")} closeLabel={t("common.close")}>
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("connectors.search")}
        searchPlaceholder={t("connectors.searchPlaceholder")}
        isEmpty={shown.length === 0}
        emptyText={t("connectors.empty", { q })}
      >
        {shown.map((d) => (
          <div key={d.id} className="member-row">
            <span className="list-col">
              <span style={{ fontWeight: 600 }}>{d.label}</span>
              <span className="small muted">
                {connectorDescription(t, d)} · {t("connectors.scopesCount", { count: d.scopes.length })}
              </span>
            </span>
            {connected.has(d.id) ? (
              <Chip icon="check" tone="done">
                {t("connectors.connected")}
              </Chip>
            ) : (
              <Button size="sm" onClick={() => onPick(d)}>
                {t("connectors.connect")}
              </Button>
            )}
          </div>
        ))}
      </DialogSearchList>
      <div style={{ height: 20 }} />
    </Dialog>
  );
}

/** Connect (or replace the key of) one connector: OAuth when the server has an app, else an API key. */
function ConnectDialog({ def, onClose }: { def: ConnectorDef | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const withKey = useConnectWithKey(org.id);
  const oauth = useStartOAuth(org.id);
  const [apiKey, setApiKey] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [touched, setTouched] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form for each connector
  useEffect(() => {
    setApiKey("");
    setServerUrl("");
    setTouched(false);
  }, [def]);
  if (!def) return null;
  const canOAuth = def.auth.includes("oauth") && def.oauthConfigured;
  const canKey = def.auth.includes("api_key");
  const keyError = touched && apiKey.trim().length < 8 ? t("connectors.apiKeyInvalid") : undefined;
  const urlError = touched && def.needsServerUrl && !isHttps(serverUrl) ? t("connectors.serverUrlInvalid") : undefined;
  const server = def.needsServerUrl ? serverUrl.trim() : undefined;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.connectTitle", { name: def.label })}
      description={connectorDescription(t, def)}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (apiKey.trim().length < 8 || (def.needsServerUrl && !isHttps(serverUrl))) return;
          withKey.mutate(
            { connector: def.id, apiKey: apiKey.trim(), serverUrl: server },
            {
              onSuccess: () => {
                toast.show(t("connectors.connectedToast", { name: def.label }));
                onClose();
              },
            },
          );
        }}
      >
        <DialogBody>
          {def.needsServerUrl && (
            <Field
              label={t("connectors.serverUrl")}
              id="conn-url"
              help={t("connectors.serverUrlHelp", { org: org.name })}
              error={urlError}
            >
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://"
                inputMode="url"
              />
            </Field>
          )}
          {canOAuth && (
            <>
              <Button
                variant="primary"
                block
                disabled={oauth.isPending || (def.needsServerUrl && !isHttps(serverUrl))}
                onClick={() =>
                  oauth.mutate(
                    { connector: def.id, returnTo: `/org/${org.id}/settings`, serverUrl: server },
                    { onSuccess: (url) => navigateAway(url) },
                  )
                }
              >
                {t("connectors.connectOAuth", { name: def.label })}
              </Button>
              <span className="small muted">{t("connectors.oauthHelp", { name: def.label })}</span>
              {canKey && <div className="auth__or">{t("connectors.orKey")}</div>}
            </>
          )}
          {canKey && (
            <Field label={t("connectors.apiKey")} id="conn-key" help={t("connectors.apiKeyHelp")} error={keyError}>
              <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {canKey && (
            <Button type="submit" variant={canOAuth ? "default" : "primary"} disabled={withKey.isPending}>
              {t("connectors.saveKey")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
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
                    {t("settings.keyEndsIn", { hint: c.keyHint })} ·{" "}
                    {t("settings.keyAdded", { when: relativeTime(t, i18n.language, c.createdAt) })}
                  </span>
                </span>
                {isDefault ? (
                  <Chip icon="check">{t("settings.defaultKey")}</Chip>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={updateSettings.isPending}
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
                    onClick={() => setDialog({ type: "remove", cred: c })}
                  >
                    {t("settings.remove")}
                  </Button>
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
  const [touched, setTouched] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form each time it opens
  useEffect(() => {
    setLabel("");
    setApiKey("");
    setTouched(false);
  }, [mode, cred]);
  const error = touched && apiKey.trim().length < 8 ? t("settings.keyInvalid") : undefined;
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
          if (apiKey.trim().length < 8) return;
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
              { provider: "anthropic", label: label.trim() || "Anthropic", apiKey: apiKey.trim() },
              { onSuccess: onClose },
            );
          }
        }}
      >
        <DialogBody>
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
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
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
      {report.isError && <Alert>{t("common.loadFailed")}</Alert>}
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
