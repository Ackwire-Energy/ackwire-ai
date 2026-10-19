import type { Agent, ScopeGrant } from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  keys,
  useAgentBrowserSettings,
  useAgentScopes,
  useApi,
  useUpdateAgentBrowserSettings,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Card, Icon, Input, OptionList, SettingRow, Switch } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import "./browser.css";

/** `example.com` or `*.example.com` (the server checks again). */
const SITE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** "https://www.Example.com/x" → "www.example.com"; "*.example.com" stays. */
export function cleanSite(input: string): string {
  const s = input.trim().toLowerCase();
  const m = /^(?:[a-z]+:\/\/)?([^/?#\s]+)/.exec(s);
  return (m?.[1] ?? s).replace(/:\d+$/, "");
}

/**
 * The agent's browser on its page (ADR 0040, telas/NavegadorAgente.html
 * "Agente"): one question (may it use the browser?), the sites it may open,
 * and the line about staying signed in. When its computer can't serve the
 * browser yet, the switch stays closed and says what to do on the computer.
 */
export function AgentBrowserCard({
  agent,
  admin,
  canSites,
}: {
  agent: Agent;
  /** Turns the browser on or off (the scope: admins). */
  admin: boolean;
  /** Changes the sites (its owner or admins). */
  canSites: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const g = agentGrammar(t, agent.name);
  const settings = useAgentBrowserSettings(org.id, agent.id);
  const scopes = useAgentScopes(org.id, agent.id);
  const saveSites = useUpdateAgentBrowserSettings(org.id, agent.id);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"any" | "only" | null>(null);
  const switchId = useId();
  const granted = (scopes.data ?? []).some((s) => s.connectionId === null && s.scope === BROWSER_TOOL_SCOPE);
  const toggle = useMutation({
    meta: { silent: true },
    mutationFn: async (on: boolean) => {
      const current = await api.scopes.get(org.id, agent.id);
      const rest = current.filter((s) => !(s.connectionId === null && s.scope === BROWSER_TOOL_SCOPE));
      const next: ScopeGrant[] = on ? [...rest, { connectionId: null, scope: BROWSER_TOOL_SCOPE }] : rest;
      return api.scopes.set(org.id, agent.id, next);
    },
    onSuccess: (saved) => {
      qc.setQueryData(keys.scopes(org.id, agent.id), saved);
      void qc.invalidateQueries({ queryKey: keys.agentAccess(org.id, agent.id) });
    },
    onError: () => setError(t("browser.agent.saveFailed")),
  });
  const view = settings.data;
  if (!view) return null;
  const available = view.available;
  const on = available && granted;
  const domains = view.allowedDomains ?? [];
  const shownMode = mode ?? (domains.length > 0 ? "only" : "any");
  const save = (next: string[] | null) =>
    saveSites.mutate(next, {
      onSuccess: () => setError(null),
      onError: () => setError(t("browser.agent.saveFailed")),
    });
  const add = () => {
    const site = cleanSite(draft);
    if (!site) return;
    if (!SITE.test(site)) return setError(t("browser.agent.badSite"));
    setDraft("");
    if (!domains.includes(site)) save([...domains, site]);
  };
  const machine = view.machine?.name ?? "";
  const reason = view.reason;
  return (
    <Card as="section" id="agp-sec-browser" className="agp-card agp-sec" aria-labelledby="agp-h-browser">
      <div className="agp-ch">
        <h2 id="agp-h-browser">
          <Icon name="globe" size={16} />
          {t("browser.title")}
        </h2>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {t("browser.agent.description", g)}
      </p>
      <SettingRow
        title={t("browser.agent.use")}
        htmlFor={switchId}
        description={
          !available
            ? t("browser.agent.useUnavailable")
            : admin
              ? t("browser.agent.useHelp", g)
              : t("browser.agent.useAdmins")
        }
      >
        <Switch
          id={switchId}
          checked={on}
          disabled={!available || !admin || toggle.isPending}
          onCheckedChange={(next) => toggle.mutate(next)}
        />
      </SettingRow>
      {!available && reason && (
        <div className="brw-note">
          <Icon name={reason === "switched_off" || reason === "not_reported" ? "computer" : "alert"} size={16} />
          <div>
            <Trans i18nKey={`browser.agent.reason.${reason}`} values={{ ...g, machine }} components={{ b: <b /> }} />
            {view.detail && <div style={{ marginTop: 6 }}>{view.detail}</div>}
          </div>
        </div>
      )}
      <div className={on ? undefined : "brw-off"} aria-disabled={!on || undefined}>
        <SettingRow title={t("browser.agent.sites")} description={t("browser.agent.sitesHelp", g)} />
        <OptionList
          aria-label={t("browser.agent.sites")}
          value={shownMode}
          disabled={!on || !canSites}
          onValueChange={(v) => {
            setMode(v);
            if (v === "any" && domains.length > 0) save(null);
          }}
          options={[
            { value: "any", title: t("browser.agent.any"), description: t("browser.agent.anyHelp") },
            {
              value: "only",
              title: t("browser.agent.only"),
              description: t("browser.agent.onlyHelp"),
              children: (
                <div className="brw-sites">
                  {domains.map((d) => (
                    <span key={d} className="brw-site">
                      <Icon name="globe" size={14} />
                      {d}
                      {canSites && (
                        <button
                          type="button"
                          aria-label={t("browser.agent.removeSite", { site: d })}
                          onClick={() => {
                            const next = domains.filter((x) => x !== d);
                            save(next.length > 0 ? next : null);
                          }}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      )}
                    </span>
                  ))}
                  {canSites && (
                    <Input
                      className="brw-sites__add"
                      value={draft}
                      placeholder={t("browser.agent.addSite")}
                      aria-label={t("browser.agent.addSite")}
                      title={t("browser.agent.addSiteHint")}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          add();
                        }
                      }}
                      onBlur={add}
                    />
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
      {error && (
        <p className="small" role="alert" style={{ margin: 0, color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <div className={on ? "brw-note" : "brw-note brw-note--off"}>
        <Icon name="lock" size={16} />
        <div>{t("browser.agent.signedIn", g)}</div>
      </div>
    </Card>
  );
}
