import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Field,
  Input,
  Select,
  type SelectOption,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useAgents, useCustomServerAction } from "@/api/queries";
import type { CustomServer, ToolAccess } from "@/api/types";
import { useStepText } from "@/components/Loading";
import { modelFrom, toInput, treeFromAccess } from "@/lib/access";
import {
  draftFrom,
  exposedTools,
  isHttpsUrl,
  searchDrafts,
  suggestion,
  type ToolDraft,
  toolsToReview,
} from "@/lib/custom-tools";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";
import { useOrg } from "./org-context";

/** "Conectar outro servidor MCP": URL → OAuth (discovery/DCR) or API key → classification. */
export function ConnectCustomDialog({
  open,
  onOpenChange,
  onConnected,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (server: CustomServer) => void;
  /** From the catalog: an official remote MCP server that asked for a key. */
  initial?: { url: string; label: string; needsKey: boolean } | null;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { connect } = useCustomServerAction(org.id);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const [touched, setTouched] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time it opens
  useEffect(() => {
    if (!open) return;
    setUrl(initial?.url ?? "");
    setLabel(initial?.label ?? "");
    setApiKey("");
    setNeedsKey(initial?.needsKey ?? false);
    setTouched(false);
  }, [open]);

  const connectStep = useStepText(connect.isPending, [
    t("customMcp.step.reaching"),
    t("customMcp.step.tools"),
    t("customMcp.step.almost"),
  ]);
  const urlError = touched && !isHttpsUrl(url) ? t("customMcp.urlInvalid") : undefined;
  const keyError = touched && needsKey && apiKey.trim().length < 8 ? t("customMcp.apiKeyInvalid") : undefined;

  const submit = () => {
    setTouched(true);
    if (!isHttpsUrl(url) || (needsKey && apiKey.trim().length < 8)) return;
    connect.mutate(
      {
        serverUrl: url.trim(),
        label: label.trim() || undefined,
        apiKey: needsKey ? apiKey.trim() : undefined,
        // Back from OAuth, the classification opens by itself.
        returnTo: `/org/${org.id}/settings?review=1`,
      },
      {
        onSuccess: (result) => {
          if (result.status === "needs_key") {
            setNeedsKey(true);
            setTouched(false);
          } else if (result.status === "oauth") {
            navigateAway(result.authorizeUrl);
          } else {
            onConnected(result.server);
          }
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? t("connectors.connectTitle", { name: initial.label }) : t("customMcp.connectTitle")}
      description={initial ? t("connectors.remoteText") : t("customMcp.connectText")}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogBody>
          <Field label={t("customMcp.url")} id="mcp-url" help={t("customMcp.urlHelp")} error={urlError}>
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setNeedsKey(false);
              }}
              placeholder="https://"
              inputMode="url"
              autoFocus
            />
          </Field>
          <Field label={t("customMcp.label")} id="mcp-label">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("customMcp.labelPlaceholder")}
            />
          </Field>
          {needsKey && (
            <>
              <Alert tone="neutral">{t("customMcp.needsKey")}</Alert>
              <Field label={t("customMcp.apiKey")} id="mcp-key" help={t("connectors.apiKeyHelp")} error={keyError}>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter note={connectStep}>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={connect.isPending} loading={connect.isPending}>
            {needsKey ? t("customMcp.connectKey") : t("customMcp.continue")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Classification: each tool gets Leitura, Escrita or "Sempre pede aprovação" and a pt-BR label. */
export function ReviewToolsDialog({
  server,
  onClose,
  onSaved,
}: {
  server: CustomServer | null;
  onClose: () => void;
  /** After saving: e.g. "Quais agentes podem usar …?". */
  onSaved?: (server: CustomServer) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { save } = useCustomServerAction(org.id);
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<ToolDraft[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!server) return;
    setName(server.label);
    setDrafts(draftFrom(server));
    setQ("");
    setError(null);
  }, [server]);
  if (!server) return null;
  // Hidden when the backend sends no suggestion (older server).
  const suggested = suggestion(server);

  const options: SelectOption<ToolAccess>[] = (["read", "write", "approval"] as const).map((v) => ({
    value: v,
    label: t(`customMcp.access.${v}`),
    description: t(`customMcp.accessDesc.${v}`),
  }));
  const shown = searchDrafts(drafts, q);
  const update = (toolName: string, patch: Partial<ToolDraft>) =>
    setDrafts((list) => list.map((d) => (d.name === toolName ? { ...d, ...patch } : d)));

  const submit = () => {
    if (drafts.some((d) => !d.label.trim())) {
      setError(t("customMcp.labelRequired"));
      return;
    }
    const label = name.trim() || server.label;
    save.mutate(
      { id: server.id, label, tools: drafts.map((d) => ({ name: d.name, access: d.access, label: d.label.trim() })) },
      {
        onSuccess: (saved) => {
          toast.show(t("customMcp.saved", { name: label }));
          if (onSaved) onSaved(saved);
          else onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("customMcp.reviewTitle", { name: server.label })}
      description={t("customMcp.reviewText")}
      closeLabel={t("common.close")}
    >
      {suggested && (
        <div className="ac-dialog__tools mcp-suggest">
          <span className="small muted" style={{ flex: "1 1 240px" }}>
            {t("customMcp.suggestText")}
          </span>
          <Button
            size="sm"
            onClick={() => setDrafts((list) => list.map((d) => ({ ...d, access: suggested[d.name] ?? d.access })))}
          >
            {t("customMcp.acceptSuggestion")}
          </Button>
        </div>
      )}
      <div className="ac-dialog__tools">
        <Field label={t("customMcp.serverName")} id={`mcp-name-${server.id}`} style={{ flex: "1 1 100%" }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <DialogSearchList
        query={q}
        onQueryChange={setQ}
        searchLabel={t("customMcp.search")}
        searchPlaceholder={t("customMcp.searchPlaceholder")}
        isEmpty={shown.length === 0}
        emptyText={drafts.length === 0 ? t("customMcp.noTools") : t("customMcp.empty", { q })}
      >
        {shown.map((d) => (
          <div key={d.name} className="tool-row">
            <div className="tool-row__head">
              <code className="tool-row__name">{d.name}</code>
              {d.isNew && (
                <Chip icon="waiting" tone="waiting">
                  {t("customMcp.newTool")}
                </Chip>
              )}
            </div>
            {d.description && <span className="small muted">{d.description}</span>}
            <div className="tool-row__controls">
              <Input
                aria-label={t("customMcp.toolLabel", { name: d.name })}
                value={d.label}
                invalid={error !== null && !d.label.trim()}
                onChange={(e) => update(d.name, { label: e.target.value })}
              />
              <Select
                aria-label={t("customMcp.toolAccess", { name: d.name })}
                value={d.access}
                onValueChange={(access) => update(d.name, { access })}
                options={options}
              />
            </div>
          </div>
        ))}
      </DialogSearchList>
      {error && (
        <div style={{ padding: "12px 20px 0" }}>
          <Alert>{error}</Alert>
        </div>
      )}
      <DialogFooter bar note={t("customMcp.saveNote")}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={save.isPending} loading={save.isPending} onClick={submit}>
          {t("customMcp.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** A custom server in the connectors list: what is available, or what waits for review. */
export function CustomServerRow({
  server,
  admin,
  onReview,
  onDisconnect,
}: {
  server: CustomServer;
  admin: boolean;
  onReview: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { refresh } = useCustomServerAction(org.id);
  const pending = toolsToReview(server);
  const exposed = exposedTools(server).length;
  const needsReview = !server.reviewedAt || pending > 0;
  return (
    <div className="ac-list__row">
      <span className="list-col">
        <span style={{ fontWeight: 600 }}>{server.label}</span>
        <span className="small muted" style={{ overflowWrap: "anywhere" }}>
          {t("customMcp.custom")} · {server.serverUrl} ·{" "}
          {server.authType === "oauth" ? t("connectors.viaOAuth") : t("connectors.viaKey")}
        </span>
      </span>
      {!server.reviewedAt ? (
        <Chip icon="waiting" tone="waiting">
          {t("customMcp.notReviewed")}
        </Chip>
      ) : pending > 0 ? (
        <Chip icon="waiting" tone="waiting">
          {t("customMcp.toReview", { count: pending })}
        </Chip>
      ) : (
        <Chip icon="check" tone="done">
          {t("customMcp.available", { count: exposed })}
        </Chip>
      )}
      {admin && needsReview && (
        <div className="mcp-cta">
          <span className="small muted">{t("customMcp.ctaText")}</span>
          <Button variant="primary" size="sm" onClick={onReview}>
            {t("customMcp.cta")}
          </Button>
        </div>
      )}
      {admin && (
        <div className="row" style={{ gap: 4 }}>
          {!needsReview && (
            <Button variant="ghost" size="sm" onClick={onReview}>
              {t("customMcp.review")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={refresh.isPending}
            loading={refresh.isPending}
            onClick={() => refresh.mutate(server.id)}
          >
            {t("customMcp.refresh")}
          </Button>
          <Button variant="ghost" size="sm" className="ac-btn--danger" onClick={onDisconnect}>
            {t("connectors.disconnect")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Right after a classification: "Quais agentes podem usar o himetrica?".
 * Each checked agent gets "todas deste conector" (also tools that appear later).
 */
export function GrantAgentsDialog({ server, onClose }: { server: CustomServer | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (server) setPicked(new Set());
  }, [server]);
  const grant = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!server) return;
      for (const agentId of ids) {
        const access = await api.access.get(org.id, agentId);
        const input = toInput(modelFrom(access), treeFromAccess(access));
        // "Todas deste conector", even if the tree doesn't list the server yet.
        input.connectors[server.id] = true;
        await api.access.set(org.id, agentId, input);
      }
    },
    onSuccess: (_v, ids) => {
      void qc.invalidateQueries({ queryKey: keys.access(org.id) });
      toast.show(t("customMcp.granted", { count: ids.length, name: server?.label ?? "" }));
      onClose();
    },
  });
  if (!server) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("customMcp.grantTitle", { name: server.label })}
      description={t("customMcp.grantText")}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        {(agents.data ?? []).length === 0 && <p className="small muted">{t("customMcp.grantNoAgents")}</p>}
        {(agents.data ?? []).map((a) => {
          const id = `grant-${a.id}`;
          return (
            <label key={a.id} htmlFor={id} className="scope-row">
              <Checkbox
                id={id}
                checked={picked.has(a.id)}
                onCheckedChange={(on) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (on) next.add(a.id);
                    else next.delete(a.id);
                    return next;
                  })
                }
              />
              <span className="scope-row__text">
                <span>{a.name}</span>
                <span className="small muted">{t("access.allOfConnector")}</span>
              </span>
            </label>
          );
        })}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("customMcp.grantLater")}</Button>
        <Button
          variant="primary"
          disabled={picked.size === 0 || grant.isPending}
          loading={grant.isPending}
          onClick={() => grant.mutate([...picked])}
        >
          {t("customMcp.grantSave")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
