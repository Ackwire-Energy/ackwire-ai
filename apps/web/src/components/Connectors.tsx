import type { Agent, DatabaseConnection, MailAccount } from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useConnections,
  useCustomServerAction,
  useCustomServers,
  useDatabases,
  useDisconnect,
  useMailAccounts,
  useMailAction,
  useMailProviders,
} from "@agenteschat/client";
import { levelIn } from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, connectedIds, connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { relativeTime } from "@agenteschat/client/lib/format";
import { choiceOf, newestAccount } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { AvatarStack, Button, Card, Chip, Dialog, DialogFooter, List } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorCatalogDialog, ConnectorIcon } from "@/components/ConnectorCatalog";
import {
  DatabaseConnectFlow,
  DatabaseDisconnectDialog,
  type DatabaseFlowState,
  DatabaseReconnectDialog,
  DatabaseRow,
} from "@/components/DatabaseConnect";
import { GitHubAppPanel } from "@/components/GitHubAppPanel";
import { LoadingList } from "@/components/Loading";
import {
  MailAddressesDialog,
  MailConnectFlow,
  MailDisconnectDialog,
  type MailFlowState,
  MailReconnectDialog,
  MailRow,
  mailChoices,
} from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * Settings → Conectores: what the organization connected, one row per
 * service whatever its kind (state, account, who uses it), "Adicionar
 * conector" (the catalog) and the 3-step connect flow.
 *
 * Back from OAuth: `?connected=github` (or `custom:{id}`) reopens the flow at
 * "O que faz" for that connection; `?review=1` (older returns) opens the
 * newest server waiting for review. Back from Gmail/Outlook: `?mail=connected`
 * opens "O que faz" for the newest mailbox; `?mail=failed` says it didn't work.
 * Mailboxes (ADR 0038) are rows of the same list.
 */
export function ConnectorsSection({
  connected,
  review,
  mail,
}: {
  connected?: string;
  review?: boolean;
  mail?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org.role, "configure");
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  const agents = useAgents(org.id);
  const [adding, setAdding] = useState(false);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [removing, setRemoving] = useState<ConnectedItem | null>(null);
  const toast = useToast();
  const mailProviders = useMailProviders(org.id);
  const mailAccounts = useMailAccounts(org.id);
  const { connectComposio } = useMailAction(org.id);
  const accounts = mailAccounts.data ?? [];
  const [mailFlow, setMailFlow] = useState<MailFlowState | null>(null);
  const [reconnecting, setReconnecting] = useState<MailAccount | null>(null);
  const [addressesOf, setAddressesOf] = useState<MailAccount | null>(null);
  const [removingMail, setRemovingMail] = useState<MailAccount | null>(null);
  // People's Postgres databases (ADR 0039): rows of the same list, the same kind of flow.
  const databases = useDatabases(org.id);
  const dbList = databases.data ?? [];
  const [dbFlow, setDbFlow] = useState<DatabaseFlowState | null>(null);
  const [reconnectingDb, setReconnectingDb] = useState<DatabaseConnection | null>(null);
  const [removingDb, setRemovingDb] = useState<DatabaseConnection | null>(null);
  const reconnect = (account: MailAccount) => {
    // Gmail/Outlook sign in again on the provider's page; the rest take a new app password.
    if (account.via === "composio" && (account.provider === "gmail" || account.provider === "outlook")) {
      connectComposio.mutate(
        { provider: account.provider, label: account.label },
        { onSuccess: (started) => navigateAway(started.redirectUrl) },
      );
    } else setReconnecting(account);
  };
  // Back from Gmail/Outlook: "O que faz" for the mailbox that came in, or why it didn't.
  const mailReturned = useRef(false);
  useEffect(() => {
    if (mailReturned.current || !mail) return;
    if (mail === "connected" && !mailAccounts.data && !mailAccounts.isError) return;
    mailReturned.current = true;
    const newest = mail === "connected" ? newestAccount(mailAccounts.data ?? []) : null;
    if (newest && admin) {
      toast.show(t("mail.returned"));
      setMailFlow({ step: 1, account: newest });
    } else if (mail !== "connected") toast.show(t("mail.failed"), "error");
    window.history.replaceState(null, "", window.location.pathname);
  }, [mail, mailAccounts.data, mailAccounts.isError, admin, t, toast]);
  const defs = catalog.data?.connectors ?? [];
  const items = connectedItems(connections.data ?? [], servers.data ?? [], defs);
  const agentList = agents.data ?? [];
  const access = useAgentsAccess(agentList, items.length > 0);
  const using = (item: ConnectedItem) =>
    agentList.filter((a) => levelIn(access.byAgent.get(a.id), `connector:${item.id}`) !== "none");

  // Back from OAuth: open "O que faz" for the connection that just came in.
  const returned = useRef(false);
  useEffect(() => {
    if (returned.current || (!connected && !review) || !connections.data || !servers.data || !catalog.data) return;
    returned.current = true;
    const all = connectedItems(connections.data, servers.data, catalog.data.connectors);
    const latest = (list: ConnectedItem[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const item = connected?.startsWith("custom:")
      ? all.find((i) => i.custom && i.id === connected.slice("custom:".length))
      : connected
        ? latest(all.filter((i) => !i.custom && i.def?.id === connected))
        : latest(all.filter((i) => i.custom && i.needsReview));
    if (item && admin) setFlow({ step: 1, item });
    window.history.replaceState(null, "", window.location.pathname);
  }, [connected, review, connections.data, servers.data, catalog.data, admin]);

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
          <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
            {t("connectors.add")}
          </Button>
        )}
      </div>
      {(connections.isLoading || servers.isLoading) && <LoadingList count={2} trailing />}
      {connections.isSuccess &&
        servers.isSuccess &&
        items.length === 0 &&
        accounts.length === 0 &&
        dbList.length === 0 && <p className="small muted">{t("connectors.none")}</p>}
      {items.length + accounts.length + dbList.length > 0 && (
        <List className="connected-list" aria-label={t("connectors.connectedList")}>
          {accounts.map((account) => (
            <MailRow
              key={`mail-${account.id}`}
              account={account}
              agents={agentList}
              admin={admin}
              onTools={() => setMailFlow({ step: 1, account })}
              onWho={() => setMailFlow({ step: 2, account })}
              onAddresses={() => setAddressesOf(account)}
              onReconnect={() => reconnect(account)}
              onDisconnect={() => setRemovingMail(account)}
            />
          ))}
          {dbList.map((connection) => (
            <DatabaseRow
              key={`db-${connection.id}`}
              connection={connection}
              agents={agentList}
              admin={admin}
              onTools={() => setDbFlow({ step: 1, connection })}
              onWho={() => setDbFlow({ step: 2, connection })}
              onReconnect={() => setReconnectingDb(connection)}
              onDisconnect={() => setRemovingDb(connection)}
            />
          ))}
          {items.map((item) => (
            <ConnectedRow
              key={item.id}
              item={item}
              using={using(item)}
              total={agentList.length}
              admin={admin}
              onTools={() => setFlow({ step: 1, item })}
              onWho={() => setFlow({ step: 2, item })}
              onDisconnect={() => setRemoving(item)}
            />
          ))}
        </List>
      )}
      <GitHubAppPanel />

      <ConnectorCatalogDialog
        open={adding}
        onOpenChange={setAdding}
        connectors={defs}
        connected={connectedIds(items)}
        loading={catalog.isLoading}
        onPick={(def) => {
          setAdding(false);
          setFlow({ step: 0, def });
        }}
        onOther={() => {
          setAdding(false);
          setFlow({ step: 0, def: null });
        }}
        mail={{
          choices: mailChoices(mailProviders.data),
          connected: new Set(accounts.map(choiceOf)),
          onPick: (choice) => {
            setAdding(false);
            setMailFlow({ step: 0, choice });
          },
        }}
        database={{
          connected: dbList.length > 0,
          onPick: () => {
            setAdding(false);
            setDbFlow({ step: 0 });
          },
        }}
      />
      <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
      <MailConnectFlow flow={mailFlow} onChange={setMailFlow} onClose={() => setMailFlow(null)} />
      <MailReconnectDialog account={reconnecting} onClose={() => setReconnecting(null)} />
      <MailAddressesDialog account={addressesOf} onClose={() => setAddressesOf(null)} />
      <MailDisconnectDialog account={removingMail} onClose={() => setRemovingMail(null)} />
      <DatabaseConnectFlow flow={dbFlow} onChange={setDbFlow} onClose={() => setDbFlow(null)} />
      <DatabaseReconnectDialog connection={reconnectingDb} onClose={() => setReconnectingDb(null)} />
      <DatabaseDisconnectDialog connection={removingDb} onClose={() => setRemovingDb(null)} />
      <DisconnectDialog
        item={removing}
        using={removing ? using(removing).length : 0}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

/** One connected service: icon, name, state, account, who uses it, and what you can do. */
function ConnectedRow({
  item,
  using,
  total,
  admin,
  onTools,
  onWho,
  onDisconnect,
}: {
  item: ConnectedItem;
  using: Agent[];
  total: number;
  admin: boolean;
  onTools: () => void;
  onWho: () => void;
  onDisconnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const meta = [
    item.account ? t("connectors.connectedAs", { account: item.account }) : null,
    relativeTime(t, i18n.language, item.createdAt),
    t("connectors.toolsCount", { count: item.tools }),
  ].filter(Boolean);
  return (
    <div className="ac-list__row connected-row">
      <ConnectorIcon def={item.def} label={itemName(t, item)} size="lg" />
      <span className="list-col connected-row__text">
        <span className="connected-row__name">
          <span>{itemName(t, item)}</span>
          {item.pending > 0 && item.server?.reviewedAt ? (
            <Chip icon="waiting" tone="waiting">
              {t("connectors.toReview", { count: item.pending })}
            </Chip>
          ) : item.needsReview ? (
            <Chip icon="waiting" tone="waiting">
              {t("connectors.notReviewed")}
            </Chip>
          ) : (
            <Chip icon="check" tone="done">
              {t("connectors.active")}
            </Chip>
          )}
        </span>
        <span className="small muted" title={meta.join(" · ")}>
          {meta.join(" · ")}
        </span>
      </span>
      <span className="connected-row__who small muted">
        {using.length > 0 && (
          <AvatarStack>
            {using.slice(0, 5).map((a) => (
              <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
            ))}
          </AvatarStack>
        )}
        {using.length > 0 ? t("connectors.usedBy", { count: using.length, total }) : t("connectors.usedByNone")}
      </span>
      {admin && (
        <div className="connected-row__actions">
          {item.needsReview && (
            <Button
              size="sm"
              variant="primary"
              aria-label={t("connectors.reviewName", { name: itemName(t, item) })}
              onClick={onTools}
            >
              {t("connectors.review")}
            </Button>
          )}
          <Button size="sm" aria-label={t("connectors.whoName", { name: itemName(t, item) })} onClick={onWho}>
            {t("connectors.who")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("connectors.toolsName", { name: itemName(t, item) })}
            onClick={onTools}
          >
            {t("connectors.tools")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("connectors.disconnectName", { name: itemName(t, item) })}
            onClick={onDisconnect}
          >
            {t("connectors.disconnect")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Desconectar Linear?": always confirmed, whatever the kind. */
function DisconnectDialog({
  item,
  using,
  onClose,
}: {
  item: ConnectedItem | null;
  using: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const catalogDisconnect = useDisconnect(org.id);
  const { disconnect: customDisconnect } = useCustomServerAction(org.id);
  const pending = catalogDisconnect.isPending || customDisconnect.isPending;
  const name = item ? itemName(t, item) : "";
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.disconnectTitle", { name })}
      description={using > 0 ? t("connectors.disconnectText", { count: using }) : t("connectors.disconnectTextNone")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={pending}
          loading={pending}
          onClick={() => {
            if (!item) return;
            const done = {
              onSuccess: () => {
                // Agents lose the connection's grants.
                void qc.invalidateQueries({ queryKey: keys.access(org.id) });
                toast.show(t("connectors.disconnected", { name }));
                onClose();
              },
            };
            if (item.custom) customDisconnect.mutate(item.id, done);
            else catalogDisconnect.mutate(item.id, done);
          }}
        >
          {t("connectors.disconnect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
