import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Segmented,
  Switch,
} from "@agenteschat/ui";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useAgents, useCatalog, useConnectWithKey, useCustomServerAction, useStartOAuth } from "@/api/queries";
import type { Agent, AgentAccess, ConnectorDef, CustomServer, ToolAccess } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { LoadingList, useStepText } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { type ConnectedItem, fromConnection, fromServer, itemName } from "@/lib/connected";
import {
  type ConnectorLevel,
  catalogToolClass,
  LEVELS,
  levelOf,
  readScopesOf,
  withLevel,
} from "@/lib/connector-access";
import { decisionsOf, draftFrom, humanize, isHttpsUrl, type ToolDraft } from "@/lib/custom-tools";
import { navigateAway } from "@/lib/navigate";
import { connectorDescription, connectorName } from "@/lib/scopes";
import { useToast } from "@/lib/toast";

/**
 * Connecting a service, in one dialog and three steps: (1) connect (OAuth
 * or an API key), (2) what it does (each tool reads, writes or always asks
 * for approval; off = never offered), (3) who can use it (one level per
 * agent). Rows of "Conectados" open steps 2 and 3 again.
 */
export type FlowState =
  /** Step 1: a catalog entry, or `null` for any MCP server by address. */
  { step: 0; def: ConnectorDef | null } | { step: 1 | 2; item: ConnectedItem };

const CLASSES: ToolAccess[] = ["read", "write", "approval"];

/** Back from OAuth the app lands here; the server adds `?connected=…`. */
const returnPath = (orgId: string) => `/org/${orgId}/settings/connectors`;

/** Every agent's access tree (shared cache with the agent page and the matrix). */
export function useAgentsAccess(agents: Agent[], enabled = true) {
  const api = useApi();
  const { org } = useOrg();
  const queries = useQueries({
    queries: agents.map((a) => ({
      queryKey: keys.agentAccess(org.id, a.id),
      queryFn: () => api.access.get(org.id, a.id),
      enabled,
      retry: false,
    })),
  });
  const byAgent = new Map<string, AgentAccess>();
  queries.forEach((q, i) => {
    const a = agents[i];
    if (a && q.data) byAgent.set(a.id, q.data);
  });
  return { byAgent, loading: queries.some((q) => q.isLoading) };
}

export function ConnectFlow({
  flow,
  onChange,
  onClose,
}: {
  flow: FlowState | null;
  onChange: (flow: FlowState) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!flow) return null;
  const name = flow.step === 0 ? (flow.def ? connectorName(t, flow.def) : null) : itemName(t, flow.item);
  const icon = flow.step === 0 ? flow.def : flow.item.def;
  const title =
    flow.step === 0
      ? name
        ? t("connectFlow.connectTitle", { name })
        : t("connectFlow.customTitle")
      : flow.step === 1
        ? t("connectFlow.toolsTitle", { name })
        : t("connectFlow.whoTitle", { name });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="cflow__title">
          {name ? (
            <ConnectorIcon def={icon} label={name} size="lg" />
          ) : (
            <span className="connector-icon connector-icon--lg connector-icon--mono" aria-hidden="true">
              <Icon name="plus" />
            </span>
          )}
          <span>{title}</span>
        </span>
      }
      closeLabel={t("common.close")}
      width={620}
      className="cflow"
    >
      <ol className="cflow__steps" aria-label={t("connectFlow.steps")}>
        {([0, 1, 2] as const).map((i) => (
          <li key={i} data-on={i <= flow.step || undefined} aria-current={i === flow.step ? "step" : undefined}>
            <span className="ac-visually-hidden">{t(`connectFlow.step.${i}`)}</span>
          </li>
        ))}
      </ol>
      {flow.step === 0 && (
        <ConnectStep def={flow.def} onConnected={(item) => onChange({ step: 1, item })} onClose={onClose} />
      )}
      {flow.step === 1 && (
        <ToolsStep
          key={flow.item.id}
          item={flow.item}
          onNext={(item) => onChange({ step: 2, item })}
          onClose={onClose}
        />
      )}
      {flow.step === 2 && (
        <WhoStep
          key={flow.item.id}
          item={flow.item}
          onBack={() => onChange({ step: 1, item: flow.item })}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Step 1: OAuth ("Continuar no Linear"), or an API key. */
function ConnectStep({
  def,
  onConnected,
  onClose,
}: {
  def: ConnectorDef | null;
  onConnected: (item: ConnectedItem) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const catalog = useCatalog();
  const { connect } = useCustomServerAction(org.id);
  const withKey = useConnectWithKey(org.id);
  const oauth = useStartOAuth(org.id);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [touched, setTouched] = useState<"oauth" | "key" | null>(null);

  // A server by address (any, or a vendor's official one) or our catalog connector.
  const byAddress = def === null || def.kind === "remote_mcp";
  const askUrl = def === null || (def.kind === "catalog" && def.needsServerUrl);
  const canOAuth = byAddress || Boolean(def?.oauthConfigured && def.auth.includes("oauth"));
  const canKey = byAddress || Boolean(def?.auth.includes("api_key"));
  const serverUrl = def?.kind === "remote_mcp" ? (def.serverUrl ?? "") : url.trim();
  const busy = connect.isPending || withKey.isPending || oauth.isPending;
  const steps = useStepText(connect.isPending, [
    t("connectFlow.reaching"),
    t("connectFlow.listing"),
    t("connectFlow.almost"),
  ]);

  const urlError = touched && askUrl && !isHttpsUrl(url) ? t("connectors.serverUrlInvalid") : undefined;
  const keyError = touched === "key" && apiKey.trim().length < 8 ? t("connectors.apiKeyInvalid") : undefined;

  const done = (item: ConnectedItem) => {
    toast.show(t("connectors.connectedToast", { name: itemName(t, item) }));
    onConnected(item);
  };
  const byAddressResult = (result: Awaited<ReturnType<typeof connect.mutateAsync>>) => {
    if (result.status === "oauth") navigateAway(result.authorizeUrl);
    else if (result.status === "needs_key") {
      setNeedsKey(true);
      setKeyOpen(true);
      setTouched(null);
    } else done(fromServer(result.server, catalog.data?.connectors ?? []));
  };
  const name = (def ? connectorName(t, def) : label.trim()) || undefined;

  const startOAuth = () => {
    setTouched("oauth");
    if (askUrl && !isHttpsUrl(url)) return;
    if (byAddress) {
      connect.mutate({ serverUrl, label: name, returnTo: returnPath(org.id) }, { onSuccess: byAddressResult });
    } else if (def) {
      oauth.mutate(
        { connector: def.id, returnTo: returnPath(org.id), serverUrl: askUrl ? serverUrl : undefined },
        { onSuccess: (to) => navigateAway(to) },
      );
    }
  };
  const submitKey = () => {
    setTouched("key");
    if ((askUrl && !isHttpsUrl(url)) || apiKey.trim().length < 8) return;
    if (byAddress) {
      connect.mutate(
        { serverUrl, label: name, apiKey: apiKey.trim(), returnTo: returnPath(org.id) },
        { onSuccess: byAddressResult },
      );
    } else if (def) {
      withKey.mutate(
        { connector: def.id, apiKey: apiKey.trim(), serverUrl: askUrl ? serverUrl : undefined },
        { onSuccess: (c) => done(fromConnection(c, catalog.data?.connectors ?? [])) },
      );
    }
  };

  const keyForm = (
    <form
      className="cflow__key"
      onSubmit={(e) => {
        e.preventDefault();
        submitKey();
      }}
    >
      {needsKey && <Alert tone="neutral">{t("connectFlow.needsKey")}</Alert>}
      <Field label={t("connectors.apiKey")} id="cflow-key" help={t("connectors.apiKeyHelp")} error={keyError}>
        <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <div>
        <Button
          type="submit"
          variant={canOAuth ? "default" : "primary"}
          disabled={busy}
          loading={(withKey.isPending || connect.isPending) && touched === "key"}
        >
          {t("connectors.saveKey")}
        </Button>
      </div>
    </form>
  );

  return (
    <>
      <DialogBody className="cflow__body">
        {def ? (
          <p className="muted cflow__text">
            {connectorDescription(t, def)} {canOAuth && t("connectFlow.oauthHelp", { name: def.label })}
          </p>
        ) : (
          <p className="muted cflow__text">{t("connectFlow.customText")}</p>
        )}
        {askUrl && (
          <Field
            label={t("connectors.serverUrl")}
            id="cflow-url"
            help={def ? t("connectors.serverUrlHelp", { org: org.name }) : t("connectFlow.urlHelp")}
            error={urlError}
          >
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setNeedsKey(false);
              }}
              placeholder="https://"
              inputMode="url"
            />
          </Field>
        )}
        {def === null && (
          <Field label={t("connectFlow.name")} id="cflow-name">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("connectFlow.namePlaceholder")}
            />
          </Field>
        )}
        {canOAuth && (
          <Button
            variant="primary"
            block
            className="cflow__oauth"
            disabled={busy}
            loading={(connect.isPending || oauth.isPending) && touched === "oauth"}
            onClick={startOAuth}
          >
            {def ? t("connectFlow.continueIn", { name: def.label }) : t("connectors.connect")}
          </Button>
        )}
        {canOAuth && canKey && (
          <>
            <div className="auth__or">{t("connectFlow.or")}</div>
            <details
              className="cflow__more"
              open={keyOpen}
              onToggle={(e) => setKeyOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>{t("connectFlow.withKey")}</summary>
              {keyForm}
            </details>
          </>
        )}
        {!canOAuth && canKey && keyForm}
      </DialogBody>
      <DialogFooter bar note={connect.isPending ? steps : t("connectFlow.nothingYet")}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
      </DialogFooter>
    </>
  );
}

/** A group of tools under "Lê", "Escreve" or "Pede aprovação sempre". */
function ToolGroup({ access, count, children }: { access: ToolAccess; count: number; children: ReactNode }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <section className="cflow-group" aria-label={t(`connectFlow.group.${access}`)}>
      <h3 className="cflow-group__title">
        {access === "approval" && <Icon name="lock" />}
        {t(`connectFlow.group.${access}`)}
        <span className="cflow-group__count">{count}</span>
      </h3>
      {children}
    </section>
  );
}

/** Step 2: what it does. Custom servers: each tool on/off and its class. Ours: read-only, by scope. */
function ToolsStep({
  item,
  onNext,
  onClose,
}: {
  item: ConnectedItem;
  onNext: (item: ConnectedItem) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  const { save, refresh } = useCustomServerAction(org.id);
  const [drafts, setDrafts] = useState<ToolDraft[]>(() => (item.server ? draftFrom(item.server) : []));
  const server = item.server;
  const update = (name: string, patch: Partial<ToolDraft>) =>
    setDrafts((list) => list.map((d) => (d.name === name ? { ...d, ...patch } : d)));
  const options = CLASSES.map((v) => ({ value: v, label: t(`connectFlow.class.${v}`) }));
  const on = drafts.filter((d) => d.on).length;
  const next = (saved?: CustomServer) => onNext(saved ? fromServer(saved, catalog.data?.connectors ?? []) : item);

  if (!server) {
    const tools = (item.def?.tools ?? []).map((tool) => ({ ...tool, access: catalogToolClass(tool) }));
    return (
      <>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("connectFlow.catalogToolsText", { name: itemName(t, item) })}</p>
          {tools.length === 0 && <p className="muted">{t("connectFlow.noTools")}</p>}
          {CLASSES.map((access) => {
            const list = tools.filter((x) => x.access === access);
            return (
              <ToolGroup key={access} access={access} count={list.length}>
                <ul className="cflow-tools">
                  {list.map((x) => (
                    <li key={x.name} className="cflow-tool">
                      <span className="cflow-tool__text">
                        <span className="cflow-tool__name">{humanize(x.name)}</span>
                        <code className="cflow-tool__code">{x.name}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              </ToolGroup>
            );
          })}
        </DialogBody>
        <DialogFooter bar>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => next()}>
            {t("connectFlow.next")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogBody className="cflow__body">
        <div className="cflow__lead">
          <p className="muted cflow__text">{t("connectFlow.toolsText")}</p>
          <Button
            size="sm"
            variant="ghost"
            icon="repeat"
            disabled={refresh.isPending}
            loading={refresh.isPending}
            onClick={() =>
              refresh.mutate(server.id, {
                onSuccess: (fresh) => {
                  // Keep what was already changed here; new tools come with their suggestion.
                  setDrafts((list) => draftFrom(fresh).map((d) => list.find((x) => x.name === d.name) ?? d));
                },
              })
            }
          >
            {t("connectFlow.refresh")}
          </Button>
        </div>
        {drafts.length === 0 && <p className="muted">{t("connectFlow.noTools")}</p>}
        {CLASSES.map((access) => {
          const list = drafts.filter((d) => d.access === access);
          return (
            <ToolGroup key={access} access={access} count={list.length}>
              <ul className="cflow-tools">
                {list.map((d) => (
                  <li key={d.name} className="cflow-tool" data-off={!d.on || undefined}>
                    <Switch
                      checked={d.on}
                      onCheckedChange={(value) => update(d.name, { on: value })}
                      aria-label={t("connectFlow.useTool", { name: d.label })}
                    />
                    <span className="cflow-tool__text">
                      <span className="cflow-tool__name">
                        {d.label}
                        {d.isNew && (
                          <Chip icon="waiting" tone="waiting">
                            {t("connectFlow.newTool")}
                          </Chip>
                        )}
                      </span>
                      <code className="cflow-tool__code">{d.name}</code>
                      {d.description && <span className="cflow-tool__desc">{d.description}</span>}
                    </span>
                    <Segmented
                      size="sm"
                      className="cflow-tool__class"
                      label={t("connectFlow.toolClass", { name: d.label })}
                      value={d.access}
                      onValueChange={(value) => update(d.name, { access: value })}
                      options={options}
                    />
                  </li>
                ))}
              </ul>
            </ToolGroup>
          );
        })}
      </DialogBody>
      <DialogFooter bar note={t("connectFlow.toolsOn", { on, total: drafts.length })}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={save.isPending}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { id: server.id, label: server.label, tools: decisionsOf(drafts) },
              { onSuccess: (saved) => next(saved) },
            )
          }
        >
          {t("connectFlow.next")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Step 3: one level per agent; "Liberar" merges it into each agent's grants. */
function WhoStep({ item, onBack, onClose }: { item: ConnectedItem; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const access = useAgentsAccess(list);
  const current = (agentId: string) => levelOf(access.byAgent.get(agentId), item.id);
  const [who, setWho] = useState<Record<string, ConnectorLevel>>({});
  const ready = agents.isSuccess && !access.loading;
  // Starts from each agent's current level, once loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when loading ends
  useEffect(() => {
    if (ready) setWho(Object.fromEntries(list.map((a) => [a.id, current(a.id)])));
  }, [ready]);
  const levelLabel = (l: ConnectorLevel) => t(`connectFlow.level.${l}`);
  const options = LEVELS.map((l) => ({ value: l, label: levelLabel(l) }));
  const asks = item.server
    ? item.server.tools.filter((x) => x.access === "approval").map((x) => x.label || humanize(x.name))
    : (item.def?.tools ?? []).filter((x) => x.sensitive).map((x) => humanize(x.name));

  const grant = useMutation({
    mutationFn: async () => {
      const readScopes = readScopesOf({ connectionId: item.id, def: item.def, custom: item.custom });
      const changed = list.filter((a) => (who[a.id] ?? "none") !== current(a.id));
      for (const a of changed) {
        const [tree, raw] = await Promise.all([api.access.get(org.id, a.id), api.scopes.get(org.id, a.id)]);
        await api.access.set(org.id, a.id, withLevel(tree, item.id, readScopes, who[a.id] ?? "none", raw));
      }
      return changed.length;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.access(org.id) });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[4] === "scopes" });
      const count = list.filter((a) => (who[a.id] ?? "none") !== "none").length;
      toast.show(t("connectFlow.saved", { count, name: itemName(t, item) }));
      onClose();
    },
  });

  return (
    <>
      <DialogBody className="cflow__body">
        {!ready ? (
          <LoadingList count={3} />
        ) : list.length === 0 ? (
          <p className="muted">{t("connectFlow.noAgents")}</p>
        ) : (
          <>
            <div className="cflow__all">
              <span className="small muted">{t("connectFlow.all")}</span>
              {LEVELS.map((l) => (
                <Button
                  key={l}
                  size="sm"
                  variant="ghost"
                  aria-label={t("connectFlow.allLevel", { level: levelLabel(l) })}
                  onClick={() => setWho(Object.fromEntries(list.map((a) => [a.id, l])))}
                >
                  {levelLabel(l)}
                </Button>
              ))}
            </div>
            <ul className="cflow-agents">
              {list.map((a) => (
                <li key={a.id} className="cflow-agent">
                  <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                  <span className="cflow-agent__name">
                    <span>{a.name}</span>
                    {a.role && <span className="small muted">{a.role}</span>}
                  </span>
                  <Segmented
                    size="sm"
                    label={t("connectFlow.levelOf", { name: a.name })}
                    value={who[a.id] ?? "none"}
                    onValueChange={(l) => setWho((w) => ({ ...w, [a.id]: l }))}
                    options={options}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="small muted cflow__asks">
          <Icon name="lock" />
          {asks.length > 0
            ? t("connectFlow.asks", { tools: asks.slice(0, 4).join(", ") })
            : t("connectFlow.asksDefault")}
        </p>
      </DialogBody>
      <DialogFooter bar>
        <Button onClick={onBack}>{t("connectFlow.back")}</Button>
        <Button
          variant="primary"
          disabled={!ready || grant.isPending}
          loading={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {t("connectFlow.grant")}
        </Button>
      </DialogFooter>
    </>
  );
}
