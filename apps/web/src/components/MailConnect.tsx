import type {
  Agent,
  MailAccount,
  MailActionName,
  MailConnectError,
  MailPolicy,
  MailProviders,
} from "@agenteschat/client";
import { keys, useAgentMail, useAgents, useMailAction, useMailProviders } from "@agenteschat/client";
import { LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  CUSTOM_PRESET,
  choiceOf,
  defaultPolicy,
  isAddress,
  MAIL_ACTIONS,
  type MailChoice,
  mailErrorOf,
  normalizePolicy,
  toMailLevel,
} from "@agenteschat/client/lib/mail";
import {
  Alert,
  AvatarStack,
  Button,
  Chip,
  CountChip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Segmented,
  Select,
  Switch,
  ToolLevelSwatch,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { LoadingList, useStepText } from "@/components/Loading";
import { MailRulesPanel, rulesCount } from "@/components/MailRules";
import { useOrg } from "@/components/org-context";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * People's mailboxes for agents (ADR 0038), in the connectors' own shapes:
 * catalog cards (Gmail, Outlook, iCloud, Outro email), the same 3-step
 * connect flow (conectar → o que faz → quem pode usar), a connected row and
 * "Reconectar". Gmail/Outlook sign in on the provider's page; iCloud and
 * the rest take an app password.
 */

/** Brand masks (Simple Icons, CC0). Outlook was removed from Simple Icons at Microsoft's request: monogram, like Canva. */
const BRAND: Partial<Record<MailChoice, { iconUrl: string; brandColor: string }>> = {
  gmail: { iconUrl: "/connectors/gmail.svg", brandColor: "#EA4335" },
  icloud: { iconUrl: "/connectors/icloud.svg", brandColor: "#3693F3" },
};

export const mailChoiceName = (t: TFunction, choice: MailChoice) => t(`mail.choice.${choice}.name`);

/** The catalog cards this server can connect (Gmail/Outlook need Composio; the rest IMAP). */
export function mailChoices(providers: MailProviders | undefined): MailChoice[] {
  if (!providers) return [];
  return [
    ...(providers.composio ? (["gmail", "outlook"] as const) : []),
    ...(providers.imap && providers.presets.some((p) => p.id === "icloud") ? (["icloud"] as const) : []),
    ...(providers.imap ? (["other"] as const) : []),
  ];
}

export function MailIcon({ choice, size = "md" }: { choice: MailChoice; size?: "md" | "lg" }) {
  const { t } = useTranslation();
  if (choice === "other") {
    return (
      <span
        className={`connector-icon${size === "lg" ? " connector-icon--lg" : ""} connector-icon--mono`}
        aria-hidden="true"
      >
        <Icon name="mail" />
      </span>
    );
  }
  return <ConnectorIcon def={BRAND[choice] ?? null} label={mailChoiceName(t, choice)} size={size} />;
}

/** How a mailbox connects, for the card's one tag. */
export const mailAuthKind = (choice: MailChoice) =>
  choice === "gmail" || choice === "outlook" ? "oneClick" : "appPassword";

export type MailFlowState = { step: 0; choice: MailChoice } | { step: 1 | 2; account: MailAccount };

/** The connect flow for a mailbox: the same dialog, steps and footer as the other connectors. */
export function MailConnectFlow({
  flow,
  onChange,
  onClose,
}: {
  flow: MailFlowState | null;
  onChange: (flow: MailFlowState) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!flow) return null;
  const choice = flow.step === 0 ? flow.choice : choiceOf(flow.account);
  const name = flow.step === 0 ? mailChoiceName(t, choice) : flow.account.address;
  const title =
    flow.step === 0
      ? t("connectFlow.connectTitle", { name })
      : flow.step === 1
        ? t("connectFlow.toolsTitle", { name })
        : t("connectFlow.whoTitle", { name });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="cflow__title">
          <MailIcon choice={choice} size="lg" />
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
      {flow.step === 0 &&
        (choice === "gmail" || choice === "outlook" ? (
          <OAuthStep provider={choice} onClose={onClose} />
        ) : (
          <ImapStep choice={choice} onConnected={(account) => onChange({ step: 1, account })} onClose={onClose} />
        ))}
      {flow.step === 1 && (
        <ActionsStep
          account={flow.account}
          onNext={() => onChange({ step: 2, account: flow.account })}
          onClose={onClose}
        />
      )}
      {flow.step === 2 && (
        <WhoStep
          key={flow.account.id}
          account={flow.account}
          onBack={() => onChange({ step: 1, account: flow.account })}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** Step 1, Gmail/Outlook: one sentence and "Conectar com Google"; the provider sends the person back. */
function OAuthStep({ provider, onClose }: { provider: "gmail" | "outlook"; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { connectComposio } = useMailAction(org.id);
  const company = t(`mail.company.${provider}`);
  return (
    <>
      <DialogBody className="cflow__body">
        <p className="muted cflow__text">
          {t(`mail.choice.${provider}.text`)} {t("mail.oauthText", { company })}
        </p>
        <Button
          variant="primary"
          block
          className="cflow__oauth"
          disabled={connectComposio.isPending}
          loading={connectComposio.isPending}
          onClick={() =>
            connectComposio.mutate({ provider }, { onSuccess: (started) => navigateAway(started.redirectUrl) })
          }
        >
          {t("mail.continueWith", { company })}
        </Button>
      </DialogBody>
      <DialogFooter bar note={t("connectFlow.nothingYet")}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
      </DialogFooter>
    </>
  );
}

/** "O que é uma senha de app?": what it is, three steps and the provider's page. */
export function AppPasswordHelp({ url, name }: { url: string | null; name: string }) {
  const { t } = useTranslation();
  return (
    <div className="mail-howto">
      <b>{t("mail.whatIs")}</b>
      <span className="small muted">{t("mail.whatIsText")}</span>
      <ol className="mail-howto__steps small">
        {(["1", "2", "3"] as const).map((n) => (
          <li key={n}>{t(`mail.step.${n}`)}</li>
        ))}
      </ol>
      {url && /^https:\/\//.test(url) && (
        <a className="ac-link small mail-howto__link" href={url} target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={14} />
          {t("mail.openPage", { name })}
        </a>
      )}
    </div>
  );
}

/**
 * Step 1, iCloud and "Outro email": the address and an app password (with
 * what that is and where to make one), then "Conectar" tests the login and
 * both servers. Hosts only under "Avançado" (and only for "Outro servidor").
 */
export function ImapStep({
  choice,
  onConnected,
  onClose,
}: {
  choice: Exclude<MailChoice, "gmail" | "outlook">;
  onConnected: (account: MailAccount) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const providers = useMailProviders(org.id);
  const { connectImap } = useMailAction(org.id);
  const presets = providers.data?.presets ?? [];
  const others = presets.filter((p) => p.id !== "icloud");
  const [picked, setPicked] = useState<string | null>(null);
  const preset = choice === "icloud" ? "icloud" : (picked ?? others[0]?.id ?? CUSTOM_PRESET);
  const current = presets.find((p) => p.id === preset) ?? null;
  const custom = preset === CUSTOM_PRESET;
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<MailConnectError | null>(null);
  const testing = useStepText(connectImap.isPending, [
    t("mail.testing.login"),
    t("mail.testing.send"),
    t("mail.testing.almost"),
  ]);
  const addressError = touched && !isAddress(address) ? t("mail.addressInvalid") : undefined;
  const passwordError = touched && !password.trim() ? t("mail.passwordInvalid") : undefined;
  const hostsMissing = custom && (!imapHost.trim() || !smtpHost.trim());
  const port = (v: string, fallback: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
  };

  const submit = () => {
    setTouched(true);
    setError(null);
    if (hostsMissing) setAdvanced(true);
    if (!isAddress(address) || !password.trim() || hostsMissing) return;
    connectImap.mutate(
      {
        preset,
        address: address.trim(),
        password: password.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(custom
          ? {
              imapHost: imapHost.trim(),
              imapPort: port(imapPort, 993),
              smtpHost: smtpHost.trim(),
              smtpPort: port(smtpPort, 587),
            }
          : {}),
      },
      {
        onSuccess: (account) => {
          toast.show(t("mail.connectedToast", { address: account.address }));
          onConnected(account);
        },
        onError: (e) => setError(mailErrorOf(e)),
      },
    );
  };

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <DialogBody className="cflow__body">
        <p className="muted cflow__text">{t(`mail.imapText.${choice}`)}</p>
        {choice === "other" && (
          <Field label={t("mail.provider")} id="mail-preset">
            <Select
              value={preset}
              onValueChange={(v) => {
                setPicked(v);
                setError(null);
              }}
              options={[
                ...others.map((p) => ({ value: p.id, label: p.label })),
                { value: CUSTOM_PRESET, label: t("mail.providerCustom") },
              ]}
            />
          </Field>
        )}
        <Field label={t("mail.address")} id="mail-address" error={addressError}>
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            value={address}
            placeholder={t("mail.addressPlaceholder")}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <Field label={t("mail.password")} id="mail-password" help={t("mail.passwordHelp")} error={passwordError}>
          <Input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <AppPasswordHelp url={current?.appPasswordUrl ?? null} name={current?.label ?? mailChoiceName(t, choice)} />
        <p className="small muted mail-hint">
          <Icon name="info" size={14} />
          <span>{t("mail.dedicated")}</span>
        </p>
        {choice === "other" && (
          <details
            className="cflow__more"
            open={advanced || custom}
            onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>{t("mail.advanced")}</summary>
            <div className="cflow__key">
              <Field label={t("mail.username")} id="mail-username" help={t("mail.usernameHelp")}>
                <Input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              {custom && (
                <>
                  <div className="mail-host">
                    <Field label={t("mail.imapHost")} id="mail-imap-host">
                      <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
                    </Field>
                    <Field label={t("mail.port")} id="mail-imap-port">
                      <Input inputMode="numeric" value={imapPort} onChange={(e) => setImapPort(e.target.value)} />
                    </Field>
                  </div>
                  <div className="mail-host">
                    <Field label={t("mail.smtpHost")} id="mail-smtp-host">
                      <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                    </Field>
                    <Field label={t("mail.port")} id="mail-smtp-port">
                      <Input inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
                    </Field>
                  </div>
                  {touched && hostsMissing && <Alert>{t("mail.hostsRequired")}</Alert>}
                </>
              )}
            </div>
          </details>
        )}
        {error && <Alert>{t(`mail.error.${error}`)}</Alert>}
      </DialogBody>
      <DialogFooter bar note={testing ?? t("connectFlow.nothingYet")}>
        <Button type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={connectImap.isPending} loading={connectImap.isPending}>
          {t("mail.connect")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Step 2: what agents may do in this mailbox; each action turns on or off for every agent. */
function ActionsStep({ account, onNext, onClose }: { account: MailAccount; onNext: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { update } = useMailAction(org.id);
  const [off, setOff] = useState<Set<MailActionName>>(() => new Set(account.offActions ?? []));
  const changed = off.size !== (account.offActions ?? []).length || (account.offActions ?? []).some((a) => !off.has(a));
  const next = () => {
    if (!changed) return onNext();
    update.mutate({ accountId: account.id, offActions: [...off] }, { onSuccess: onNext });
  };
  return (
    <>
      <DialogBody className="cflow__body">
        <p className="muted cflow__text">{t("mail.toolsLead", { name: account.address })}</p>
        <MailActionsList
          off={off}
          onToggle={(action, on) =>
            setOff((prev) => {
              const s = new Set(prev);
              if (on) s.delete(action);
              else s.add(action);
              return s;
            })
          }
        />
        {update.isError && <Alert>{t("mail.actionsError")}</Alert>}
      </DialogBody>
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={update.isPending} loading={update.isPending} onClick={next}>
          {t("connectFlow.next")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function MailActionsList({
  off,
  onToggle,
}: {
  off: Set<MailActionName>;
  onToggle: (action: MailActionName, on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mail-actions">
      {(["read", "write", "approval", "off"] as const).map((level) => (
        <section key={level} aria-label={t(`mail.group.${level}`)}>
          <h3 className="cflow-group__title">
            <ToolLevelSwatch level={level} />
            {t(`mail.group.${level}`)}
            <CountChip size="sm">{MAIL_ACTIONS[level].length}</CountChip>
          </h3>
          <ul className="cflow-tools">
            {MAIL_ACTIONS[level].map((a) => (
              <li key={a} className="cflow-tool" data-off={off.has(a) || undefined}>
                <span className="cflow-tool__text">
                  <span className="cflow-tool__name">{t(`mail.action.${a}.name`)}</span>
                  <span className="cflow-tool__desc">
                    {off.has(a) ? t("mail.actionOff") : t(`mail.action.${a}.text`)}
                  </span>
                </span>
                <Switch
                  checked={!off.has(a)}
                  onCheckedChange={(on) => onToggle(a, on)}
                  aria-label={t("mail.actionToggle", { name: t(`mail.action.${a}.name`) })}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const toLevel = (l: "none" | "read" | "read_write" | undefined): Level =>
  l === "read_write" ? "write" : l === "read" ? "read" : "none";

/** "Regras" under an agent with access: which folders it reads, from whom, to whom it sends. */
function AgentMailRules({
  agentId,
  account,
  policy,
  onChange,
}: {
  agentId: string;
  account: MailAccount;
  policy: MailPolicy | undefined;
  onChange: (policy: MailPolicy) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const saved = useAgentMail(org.id, agentId).data?.find((m) => m.accountId === account.id);
  const shown = policy ?? (saved ? { ...defaultPolicy(), ...saved.policy } : defaultPolicy());
  const count = rulesCount(shown);
  return (
    <details className="mail-rules cflow-agent__rules">
      <summary aria-label={t("mail.agent.rulesOf", { address: account.address })}>
        <Icon name="filter" size={14} />
        <span>{t("mail.agent.rules")}</span>
        {count > 0 ? (
          <CountChip size="sm">{count}</CountChip>
        ) : (
          <span className="small muted">{t("mail.agent.noRules")}</span>
        )}
      </summary>
      <MailRulesPanel accountId={account.id} address={account.address} policy={shown} onChange={onChange} />
    </details>
  );
}

/** Step 3: one level per agent; each saves that agent's access to this mailbox (rules kept). */
function WhoStep({ account, onBack, onClose }: { account: MailAccount; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const current = (agentId: string) => toLevel(account.agents.find((a) => a.agentId === agentId)?.level);
  const [who, setWho] = useState<Record<string, Level>>({});
  // Rules edited here (which folders, senders…); untouched agents keep what they have.
  const [rules, setRules] = useState<Record<string, MailPolicy>>({});
  const levelOf = (agentId: string) => who[agentId] ?? current(agentId);
  const levelLabel = (l: Level) => t(`access.level.${l}`);

  const grant = useMutation({
    mutationFn: async () => {
      const changed = list.filter((a) => levelOf(a.id) !== current(a.id) || rules[a.id] !== undefined);
      for (const a of changed) {
        // Keep the agent's rules for this mailbox; only the level changes here.
        const saved = (await api.mail.agent(org.id, a.id)).find((m) => m.accountId === account.id);
        await api.mail.setAgent(org.id, a.id, account.id, {
          level: toMailLevel(levelOf(a.id)),
          canDelete: saved?.canDelete ?? false,
          policy: normalizePolicy(rules[a.id] ?? saved?.policy ?? defaultPolicy()),
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.mail(org.id) });
      const count = list.filter((a) => levelOf(a.id) !== "none").length;
      toast.show(t("connectFlow.saved", { count, name: account.address }));
      onClose();
    },
  });

  return (
    <>
      <DialogBody className="cflow__body">
        {agents.isLoading ? (
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
                    value={levelOf(a.id)}
                    onValueChange={(l) => setWho((w) => ({ ...w, [a.id]: l }))}
                    options={LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))}
                  />
                  {levelOf(a.id) !== "none" && (
                    <AgentMailRules
                      agentId={a.id}
                      account={account}
                      policy={rules[a.id]}
                      onChange={(policy) => setRules((r) => ({ ...r, [a.id]: policy }))}
                    />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="small muted cflow__asks">
          <Icon name="lock" />
          {t("connectFlow.asksCount", { count: MAIL_ACTIONS.approval.length })}
        </p>
        <p className="small muted cflow__text">{t("mail.whoLead")}</p>
      </DialogBody>
      <DialogFooter bar>
        <Button onClick={onBack}>{t("connectFlow.back")}</Button>
        <Button
          variant="primary"
          disabled={!agents.isSuccess || grant.isPending}
          loading={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {t("connectFlow.grant")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One connected mailbox in "Conectados": the same row as the other connectors. */
export function MailRow({
  account,
  agents,
  admin,
  onTools,
  onWho,
  onReconnect,
  onDisconnect,
}: {
  account: MailAccount;
  agents: Agent[];
  admin: boolean;
  onTools: () => void;
  onWho: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const choice = choiceOf(account);
  const using = agents.filter((a) => account.agents.some((x) => x.agentId === a.id));
  const name = account.address;
  const meta = [
    t("connectors.connectedAs", { account: account.address }),
    relativeTime(t, i18n.language, account.createdAt),
  ];
  return (
    <div className="ac-list__row connected-row">
      <MailIcon choice={choice} size="lg" />
      <span className="list-col connected-row__text">
        <span className="connected-row__name">
          <span>{mailChoiceName(t, choice)}</span>
          {account.status === "needs_reconnect" ? (
            <Chip icon="alert" tone="waiting">
              {t("mail.status.needs_reconnect")}
            </Chip>
          ) : account.status === "pending" ? (
            <Chip icon="waiting" tone="waiting">
              {t("mail.status.pending")}
            </Chip>
          ) : (
            <Chip icon="check" tone="done">
              {t("mail.status.active")}
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
        {using.length > 0
          ? t("connectors.usedBy", { count: using.length, total: agents.length })
          : t("connectors.usedByNone")}
      </span>
      {admin && (
        <div className="connected-row__actions">
          {account.status === "needs_reconnect" && (
            <Button size="sm" variant="primary" aria-label={t("mail.reconnectName", { name })} onClick={onReconnect}>
              {t("mail.reconnect")}
            </Button>
          )}
          <Button size="sm" aria-label={t("connectors.whoName", { name })} onClick={onWho}>
            {t("connectors.who")}
          </Button>
          <Button size="sm" variant="ghost" aria-label={t("connectors.toolsName", { name })} onClick={onTools}>
            {t("connectors.tools")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("connectors.disconnectName", { name })}
            onClick={onDisconnect}
          >
            {t("connectors.disconnect")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Reconectar" for an IMAP mailbox: a new app password (Gmail/Outlook sign in again instead). */
export function MailReconnectDialog({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const providers = useMailProviders(org.id, account !== null);
  const { update } = useMailAction(org.id);
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<MailConnectError | null>(null);
  const preset = providers.data?.presets.find((p) => p.id === account?.preset) ?? null;
  const close = () => {
    setPassword("");
    setTouched(false);
    setError(null);
    onClose();
  };
  const submit = () => {
    setTouched(true);
    setError(null);
    if (!account || !password.trim()) return;
    update.mutate(
      { accountId: account.id, password: password.trim() },
      {
        onSuccess: (saved) => {
          toast.show(t("mail.reconnected", { address: saved.address }));
          close();
        },
        onError: (e) => setError(mailErrorOf(e)),
      },
    );
  };
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(o) => !o && close()}
      title={t("mail.reconnectTitle", { address: account?.address ?? "" })}
      description={t("mail.reconnectText")}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogBody className="cflow__body">
          <Field
            label={t("mail.password")}
            id="mail-reconnect-password"
            help={t("mail.passwordHelp")}
            error={touched && !password.trim() ? t("mail.passwordInvalid") : undefined}
          >
            <Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <AppPasswordHelp
            url={preset?.appPasswordUrl ?? null}
            name={preset?.label ?? (account ? mailChoiceName(t, choiceOf(account)) : "")}
          />
          {error && <Alert>{t(`mail.error.${error}`)}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={update.isPending} loading={update.isPending}>
            {t("mail.reconnect")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Desconectar ana@empresa.com?": always confirmed. */
export function MailDisconnectDialog({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { disconnect } = useMailAction(org.id);
  const name = account?.address ?? "";
  const using = account?.agents.length ?? 0;
  return (
    <Dialog
      open={account !== null}
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
          disabled={disconnect.isPending}
          loading={disconnect.isPending}
          onClick={() =>
            account &&
            disconnect.mutate(account.id, {
              onSuccess: () => {
                toast.show(t("connectors.disconnected", { name }));
                onClose();
              },
            })
          }
        >
          {t("connectors.disconnect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
