import type { ConnectorDef, CustomServer } from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useConnections,
  useConnectWithKey,
  useCustomServerAction,
  useCustomServers,
  useStartOAuth,
} from "@agenteschat/client";
import {
  catalogToolClass,
  LEVELS,
  type Level,
  type LevelState,
  levelIn,
  saveLevels,
  sharedLevel,
} from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, fromConnection, fromServer, itemName } from "@agenteschat/client/lib/connected";
import { humanize, isHttpsUrl, sameServer } from "@agenteschat/client/lib/custom-tools";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import {
  partsOf,
  type ReviewTool,
  reviewDecisions,
  reviewToolsOf,
  toolName,
} from "@agenteschat/client/lib/tool-review";
import { Alert, Button, Dialog, DialogBody, DialogFooter, Field, Icon, Input, Segmented } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { FlowTitle } from "@/components/FlowTitle";
import { LoadingList, useStepText } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import { oauthReturnPath } from "@/lib/desktop";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";
import { reviewNote, ToolLevelsView, ToolReview, type ToolReviewState } from "./ToolReview";

/**
 * Connecting a service, in one dialog and three steps: (1) connect (OAuth
 * or an API key), (2) what it does (each tool reads, writes or always asks
 * for approval; off = never offered), (3) who can use it (one level per
 * agent). Rows of "Conectados" open steps 2 and 3 again.
 */
export type FlowState =
  /** Step 1: a catalog entry, or `null` for any MCP server by address. */
  { step: 0; def: ConnectorDef | null } | { step: 1 | 2; item: ConnectedItem };

/** Back from OAuth the app lands here; the server adds `?connected=…`. In the desktop app, through its window. */
const returnPath = (orgId: string) => oauthReturnPath(`/org/${orgId}/settings/connectors`);

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
        ? flow.item.server
          ? t("toolReview.title")
          : t("connectFlow.toolsTitle", { name })
        : t("connectFlow.whoTitle", { name });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <FlowTitle
          tile={
            name ? (
              <ConnectorIcon def={icon} image={flow.step === 0 ? null : flow.item.image} label={name} size="lg" />
            ) : (
              <span className="connector-icon connector-icon--lg connector-icon--mono" aria-hidden="true">
                <Icon name="plus" />
              </span>
            )
          }
        >
          {title}
        </FlowTitle>
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
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
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
  // As the server does: one connection per catalog connector, one per address; connecting again keeps the grants.
  const again = byAddress
    ? (servers.data ?? []).some((s) => sameServer(s.serverUrl, serverUrl))
    : (connections.data ?? []).some((c) => c.connector === def?.id && !c.revokedAt);
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
      <DialogFooter
        bar
        note={connect.isPending ? steps : t(again ? "connectFlow.keepAccess" : "connectFlow.allCanUse")}
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
      </DialogFooter>
    </>
  );
}

/** A catalog connector's tools for the read-only review (classified by our scopes). */
function catalogReviewTools(t: TFunction, item: ConnectedItem): ReviewTool[] {
  const prefix = item.def ? item.def.id : null;
  return (item.def?.tools ?? []).map((tool) => {
    const parts = partsOf(tool.name, prefix);
    const level = catalogToolClass(tool);
    return {
      name: tool.name,
      label: toolName(t, parts, tool.name),
      description: "",
      subject: parts.subject,
      level,
      suggested: level,
      reason: null,
      sensitive: tool.sensitive,
      pending: false,
      savedLabel: humanize(tool.name),
    };
  });
}

/**
 * Step 2: "Revise o que o agente pode fazer sozinho".
 * Servers by address: every tool comes classified; the person settles the
 * ones the name can't decide and changes what they want. Ours: read-only, by scope.
 */
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
  const toast = useToast();
  const catalog = useCatalog();
  const { save, refresh } = useCustomServerAction(org.id);
  const [server, setServer] = useState(item.server);
  const tools = server ? reviewToolsOf(t, server) : [];
  const [state, setState] = useState<ToolReviewState>({ levels: {}, decided: new Set() });
  const next = (saved?: CustomServer) => onNext(saved ? fromServer(saved, catalog.data?.connectors ?? []) : item);
  const name = itemName(t, item);

  if (!server) {
    const list = catalogReviewTools(t, item);
    return (
      <>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("toolReview.catalogLead", { name })}</p>
          {list.length === 0 ? <p className="muted">{t("toolReview.noTools")}</p> : <ToolLevelsView tools={list} />}
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
      <DialogBody className="cflow__body tr-body">
        <div className="cflow__lead">
          <p className="muted cflow__text">{t("toolReview.lead", { count: tools.length, name })}</p>
          <Button
            size="sm"
            variant="ghost"
            icon="repeat"
            disabled={refresh.isPending}
            loading={refresh.isPending}
            onClick={() => refresh.mutate(server.id, { onSuccess: (fresh) => setServer(fresh) })}
          >
            {t("toolReview.refresh")}
          </Button>
        </div>
        {tools.length === 0 ? (
          <p className="muted">{t("toolReview.noTools")}</p>
        ) : (
          <ToolReview name={name} tools={tools} state={state} onChange={setState} onMoved={(m) => toast.show(m)} />
        )}
      </DialogBody>
      <DialogFooter bar note={reviewNote(t, tools, state)}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={save.isPending}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { id: server.id, label: server.label, tools: reviewDecisions(tools, state.levels, state.decided) },
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

/**
 * Step 3: "Todos os agentes" on top (the main choice: it sets every agent), then one level per agent; "Liberar"
 * merges them into each agent's grants.
 */
function WhoStep({ item, onBack, onClose }: { item: ConnectedItem; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const access = useAgentsAccess(list);
  const resourceId = `connector:${item.id}`;
  const current = (agentId: string) => levelIn(access.byAgent.get(agentId), resourceId);
  const [who, setWho] = useState<Record<string, LevelState> | null>(null);
  const loaded = agents.isSuccess && !access.loading && !access.fetching;
  // Starts once from each agent's level, read fresh: a connection made a moment ago is already every agent's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the fresh trees arrive
  useEffect(() => {
    if (loaded && who === null) setWho(Object.fromEntries(list.map((a) => [a.id, current(a.id)])));
  }, [loaded]);
  const ready = who !== null;
  const picked = (agentId: string) => who?.[agentId] ?? "none";
  const levelLabel = (l: LevelState) => t(`access.level.${l}`);
  const options = (agentId: string) => [
    ...LEVELS.map((l) => ({ value: l as LevelState, label: levelLabel(l) })),
    // Granted tool by tool before: shown as is until a level is picked.
    ...(current(agentId) === "custom" ? [{ value: "custom" as LevelState, label: levelLabel("custom") }] : []),
  ];
  const asks = item.server
    ? item.server.tools.filter((x) => x.access === "approval").length
    : (item.def?.tools ?? []).filter((x) => x.sensitive).length;

  const grant = useMutation({
    mutationFn: async () => {
      const changed = list.filter((a) => {
        const level = picked(a.id);
        return level !== "custom" && level !== current(a.id);
      });
      for (const a of changed) {
        const saved = await saveLevels(api, org.id, a.id, { [resourceId]: picked(a.id) as Level });
        qc.setQueryData(keys.agentAccess(org.id, a.id), saved);
      }
      return changed.length;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.access(org.id) });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[4] === "scopes" });
      const count = list.filter((a) => picked(a.id) !== "none").length;
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
            {list.length > 1 && (
              <div className="cflow-agent cflow-agent--all">
                <span className="cflow-agent__all-icon" aria-hidden="true">
                  <Icon name="members" size={16} />
                </span>
                <span className="cflow-agent__name">
                  <span>{t("connectFlow.everyone")}</span>
                  <span className="small muted">{t("connectFlow.everyoneCount", { count: list.length })}</span>
                </span>
                <Segmented<LevelState | "">
                  size="sm"
                  label={t("connectFlow.everyoneLevel")}
                  value={sharedLevel(list.map((a) => picked(a.id))) ?? ""}
                  onValueChange={(l) => {
                    if (l) setWho(Object.fromEntries(list.map((a) => [a.id, l])));
                  }}
                  options={LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))}
                />
              </div>
            )}
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
                    value={picked(a.id)}
                    onValueChange={(l) => setWho((w) => ({ ...w, [a.id]: l }))}
                    options={options(a.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="small muted cflow__asks">
          <Icon name="lock" />
          {asks > 0 ? t("connectFlow.asksCount", { count: asks }) : t("connectFlow.asksDefault")}
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
