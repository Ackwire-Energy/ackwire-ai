import { AvatarStack, Button, Card, Chip, Dialog, DialogFooter, List } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { keys } from "@/api/keys";
import {
  useAgents,
  useCatalog,
  useConnections,
  useCustomServerAction,
  useCustomServers,
  useDisconnect,
} from "@/api/queries";
import type { Agent } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectFlow, type FlowState, useAgentsAccess } from "@/components/ConnectFlow";
import { ConnectorCatalogDialog, ConnectorIcon } from "@/components/ConnectorCatalog";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { type ConnectedItem, connectedIds, connectedItems, itemName } from "@/lib/connected";
import { levelOf } from "@/lib/connector-access";
import { relativeTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import { useToast } from "@/lib/toast";

/**
 * Settings → Conectores: what the organization connected, one row per
 * service whatever its kind (state, account, who uses it), "Adicionar
 * conector" (the catalog) and the 3-step connect flow.
 *
 * Back from OAuth: `?connected=github` (or `custom:{id}`) reopens the flow at
 * "O que faz" for that connection; `?review=1` (older returns) opens the
 * newest server waiting for review.
 */
export function ConnectorsSection({ connected, review }: { connected?: string; review?: boolean }) {
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
  const defs = catalog.data?.connectors ?? [];
  const items = connectedItems(connections.data ?? [], servers.data ?? [], defs);
  const agentList = agents.data ?? [];
  const access = useAgentsAccess(agentList, items.length > 0);
  const using = (item: ConnectedItem) => agentList.filter((a) => levelOf(access.byAgent.get(a.id), item.id) !== "none");

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
      {connections.isSuccess && servers.isSuccess && items.length === 0 && (
        <p className="small muted">{t("connectors.none")}</p>
      )}
      {items.length > 0 && (
        <List aria-label={t("connectors.connectedList")}>
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
      />
      <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
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
        <span className="small muted">{meta.join(" · ")}</span>
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
