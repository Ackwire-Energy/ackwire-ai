import type { BrowserHandoff, Machine, ScopeGrant } from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  isActiveStatus,
  isBrowserTool,
  isOpenHandoff,
  keys,
  useApi,
  useBrowserHandoffMutations,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Card, CardHeader, Chip, Icon } from "@agenteschat/ui";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import { AgentAvatar } from "../AgentAvatar";
import { CommandBlock } from "../Machines";
import { useOrg } from "../org-context";
import "./browser.css";

/** The first command in the runner's own words ("…run `agentes-runner browser install --with-deps`"). */
function commandIn(reason: string | null | undefined): string | null {
  const m = reason ? /`([^`]+)`/.exec(reason) : null;
  return m?.[1] ?? null;
}

/**
 * "Navegador" on a computer's page (ADR 0040, telas/NavegadorAgente.html
 * "Computador"): whether the browser is ready here, which agents are in it
 * now (Ver, Parar), and which agents may use it. Turning it on happens on
 * the computer; the owner can only turn it off here.
 */
export function MachineBrowserCard({ machine: m, onTurnOff }: { machine: Machine; onTurnOff: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const actions = useBrowserHandoffMutations(org.id);
  const [confirming, setConfirming] = useState<string | null>(null);
  const agentIds = m.agents.map((a) => a.id);
  const handoffs = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.agentBrowserHandoff(org.id, id),
      queryFn: () => api.browser.agentHandoff(org.id, id),
      retry: false,
    })),
  });
  const scopes = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.scopes(org.id, id),
      queryFn: () => api.scopes.get(org.id, id),
      retry: false,
      enabled: m.canManage,
    })),
  });
  const settings = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.agentBrowser(org.id, id),
      queryFn: () => api.browser.settings(org.id, id),
      retry: false,
    })),
  });
  // Agents whose run is in the browser right now (its current tool), from the live store.
  const busy = useStreams((s) =>
    Object.values(s.runs)
      .filter((r) => agentIds.includes(r.agentId) && isActiveStatus(r.status) && isBrowserTool(r.tool))
      .map((r) => r.agentId)
      .sort()
      .join(","),
  );
  const access = m.access;
  if (!access && !m.browser) return null;
  const switchedOn = access?.tools.browser === true;
  const ready = switchedOn && m.browser?.available === true;
  const command = commandIn(m.browser?.reason);
  const uses = m.agents.flatMap((a, i) => {
    const h = handoffs[i]?.data as BrowserHandoff | null | undefined;
    const open = h && isOpenHandoff(h) ? h : null;
    const running = busy.split(",").includes(a.id);
    return open || running ? [{ agent: a, open, running }] : [];
  });
  const allowed = m.agents.flatMap((a, i) => {
    const grants = scopes[i]?.data as ScopeGrant[] | undefined;
    if (!grants?.some((g) => g.connectionId === null && g.scope === BROWSER_TOOL_SCOPE)) return [];
    const domains = settings[i]?.data?.allowedDomains ?? null;
    return [{ agent: a, domains }];
  });
  const stop = (agentId: string, name: string) =>
    actions.stop.mutate(agentId, {
      onSuccess: () => {
        setConfirming(null);
        toast.show(t("browser.machine.stopped", agentGrammar(t, name)));
      },
      onError: () => toast.show(t("browser.live.actionFailed"), "error"),
    });
  return (
    <Card aria-labelledby="sec-machine-browser">
      <CardHeader
        id="sec-machine-browser"
        icon="globe"
        title={t("browser.title")}
        subtitle={t("browser.machine.description")}
        action={
          switchedOn &&
          m.canManage && (
            <Button size="sm" variant="ghost" aria-label={t("browser.machine.turnOffLabel")} onClick={onTurnOff}>
              {t("browser.machine.turnOff")}
            </Button>
          )
        }
      />
      <div className="brw-status">
        {ready ? (
          <Chip icon="check" tone="done">
            {t("browser.machine.ready")}
          </Chip>
        ) : !switchedOn ? (
          <Chip icon="dash">{t("browser.machine.off")}</Chip>
        ) : command ? (
          <Chip icon="alert" tone="waiting">
            {t("browser.machine.needsCommand")}
          </Chip>
        ) : (
          <Chip icon="alert">{t("browser.machine.notReady")}</Chip>
        )}
        {ready && m.browser?.version && <span className="small muted">{m.browser.chrome ?? ""}</span>}
      </div>
      {!switchedOn && (
        <div className="brw-note">
          <Icon name="computer" size={16} />
          <div>{t("browser.machine.offHelp")}</div>
        </div>
      )}
      {switchedOn && !ready && m.browser?.reason && (
        <div className="brw-note">
          <Icon name="alert" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {m.browser.reason}
            {command && <CommandBlock command={command} />}
          </div>
        </div>
      )}
      {ready && (
        <>
          <h3 className="brw-gh">{t("browser.machine.inUse")}</h3>
          {uses.length === 0 ? (
            <div className="brw-note" style={{ marginTop: 8 }}>
              <Icon name="globe" size={16} />
              <div>{t("browser.machine.nobody")}</div>
            </div>
          ) : (
            <div className="brw-uses">
              {uses.map(({ agent, open }) => {
                const g = agentGrammar(t, agent.name);
                const waiting = open?.status === "pending";
                return (
                  <div key={agent.id} className="brw-use">
                    <AgentAvatar
                      agentId={agent.id}
                      size="md"
                      name={agent.name}
                      state={waiting ? "waiting" : "thinking"}
                    />
                    <span className="brw-use__t">
                      <b>
                        {waiting
                          ? t("browser.machine.waiting", g)
                          : open
                            ? t("browser.machine.helping", g)
                            : t("browser.watch.title")}
                      </b>
                      <small>
                        {open?.kind === "ask" && <span>{open.instructions}</span>}
                        {waiting && (
                          <Chip icon="waiting" tone="waiting">
                            {t("browser.machine.waitingChip")}
                          </Chip>
                        )}
                      </small>
                    </span>
                    <span className="brw-use__acts">
                      <Button
                        size="sm"
                        icon="external"
                        onClick={() =>
                          void navigate({
                            to: "/org/$orgId/browser/$agentId",
                            params: { orgId: org.id, agentId: agent.id },
                            search: open ? { h: open.id, ...(waiting ? {} : { watch: 1 as const }) } : { watch: 1 },
                          })
                        }
                      >
                        {t("browser.machine.see")}
                      </Button>
                      <Button size="sm" variant="ghost" icon="stop" onClick={() => setConfirming(agent.id)}>
                        {t("browser.machine.stop")}
                      </Button>
                    </span>
                    {confirming === agent.id && (
                      <div className="brw-confirm">
                        <span>{t("browser.machine.stopConfirm", g)}</span>
                        <span className="brw-grow" />
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                          {t("common.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={actions.stop.isPending}
                          onClick={() => stop(agent.id, agent.name)}
                        >
                          {t("browser.machine.stop")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {m.canManage && (
        <>
          <h3 className="brw-gh">{t("browser.machine.who")}</h3>
          <span className="small muted">{t("browser.machine.whoHelp")}</span>
          {allowed.length === 0 ? (
            <span className="small muted">{t("browser.machine.whoNone")}</span>
          ) : (
            <div className="brw-uses brw-uses--first">
              {allowed.map(({ agent, domains }) => (
                <div key={agent.id} className="brw-use">
                  <AgentAvatar agentId={agent.id} size="sm" name={agent.name} />
                  <span className="brw-use__t">
                    <b>{agent.name}</b>
                    <small>
                      {domains?.length
                        ? t("browser.machine.whoOnly", { sites: domains.join(", ") })
                        : t("browser.machine.whoAny")}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
