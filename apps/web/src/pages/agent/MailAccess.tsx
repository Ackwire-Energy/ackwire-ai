import type { AgentMailbox, MailAccount, MailPolicy } from "@agenteschat/client";
import { ApiError, useAgentMail, useMailAccounts, useMailFolders, useSetAgentMail } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import {
  canSendWithoutAsking,
  choiceOf,
  defaultPolicy,
  isAddress,
  MAIL_ACTIONS,
  normalizePolicy,
} from "@agenteschat/client/lib/mail";
import { Alert, Button, Card, CheckboxPill, CountChip, Field, Icon, Input, Switch } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LevelRow } from "@/components/AccessLevels";
import { AddressList } from "@/components/AddressList";
import { MailIcon } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Email (ADR 0038): one row per mailbox of the
 * organization, the same level as the other connectors (Sem acesso · Ler ·
 * Ler e escrever), "Pode apagar emails" and the rules. Each mailbox saves on
 * its own ("Salvar"), outside the page's save bar.
 */
export function MailAccessCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, can } = useAgentEdit();
  const accounts = useMailAccounts(org.id);
  const mail = useAgentMail(org.id, agent.id, (accounts.data?.length ?? 0) > 0);
  const list = accounts.data ?? [];
  // A server without email, or none connected: nothing to show here.
  if (list.length === 0) return null;
  return (
    <Card as="section" className="agp-card" aria-labelledby="ac-mail">
      <CardHead
        id="ac-mail"
        icon="mail"
        title={t("mail.agent.title")}
        action={<span className="small muted">{t("mail.agent.help", { org: org.name })}</span>}
      />
      <ul className="level-list" aria-label={t("mail.agent.title")}>
        {list.map((account) => (
          <MailboxRow
            key={account.id}
            account={account}
            saved={mail.data?.find((m) => m.accountId === account.id) ?? null}
            loading={mail.isLoading}
            editable={can("levels")}
          />
        ))}
      </ul>
    </Card>
  );
}

const toLevel = (l: AgentMailbox["level"]): Level => (l === "read_write" ? "write" : l);
const toMail = (l: Level): AgentMailbox["level"] => (l === "write" ? "read_write" : l);

interface Draft {
  level: Level;
  canDelete: boolean;
  policy: MailPolicy;
}

const draftOf = (saved: AgentMailbox | null): Draft => ({
  level: saved ? toLevel(saved.level) : "none",
  canDelete: saved?.canDelete ?? false,
  policy: saved ? { ...defaultPolicy(), ...saved.policy } : defaultPolicy(),
});

/** How many rules narrow what the agent does (the "Regras" summary). */
export function rulesCount(p: MailPolicy) {
  return [
    p.folders.length > 0,
    p.senders.length > 0,
    p.windowDays !== null,
    p.allowedRecipients.length > 0,
    p.sendWithoutAsking,
    p.fromAddress !== null,
  ].filter(Boolean).length;
}

function MailboxRow({
  account,
  saved,
  loading,
  editable,
}: {
  account: MailAccount;
  saved: AgentMailbox | null;
  loading: boolean;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const set = useSetAgentMail(org.id);
  const base = JSON.stringify(draftOf(saved));
  const [edit, setEdit] = useState<{ from: string; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Remounts the rules (their typed-but-invalid text) after "Cancelar" or a save.
  const [round, setRound] = useState(0);
  const reset = () => {
    setEdit(null);
    setError(null);
    setRound((n) => n + 1);
  };
  // Edits stay until saved; a new server answer resets them.
  const draft = edit && edit.from === base ? edit.draft : draftOf(saved);
  const change = (next: Partial<Draft>) => {
    setError(null);
    setEdit({ from: base, draft: { ...draft, ...next } });
  };
  const dirty = JSON.stringify(draft) !== base;
  const asks =
    draft.level === "write" && !draft.policy.sendWithoutAsking
      ? MAIL_ACTIONS.approval.map((a) => t(`mail.action.${a}.name`))
      : [];
  const save = () =>
    set.mutate(
      {
        agentId: agent.id,
        accountId: account.id,
        input: { level: toMail(draft.level), canDelete: draft.canDelete, policy: normalizePolicy(draft.policy) },
      },
      {
        onSuccess: () => {
          reset();
          toast.show(t("mail.agent.saved", { name: agent.name }));
        },
        onError: (e) =>
          setError(
            e instanceof ApiError && e.code === "send_without_recipients"
              ? t("mail.agent.saveError.send_without_recipients")
              : e instanceof ApiError && e.status === 422 && e.message
                ? e.message
                : t("mail.agent.saveError.unknown"),
          ),
      },
    );
  const count = rulesCount(draft.policy);
  return (
    <LevelRow
      icon={<MailIcon choice={choiceOf(account)} />}
      name={account.address}
      description={draft.level === "none" ? t("access.noneText") : t(`mail.agent.levelText.${draft.level}`)}
      asks={asks}
      levels={["none", "read", "write"]}
      value={draft.level}
      onChange={editable && !loading ? (level) => change({ level }) : undefined}
      changed={dirty}
      below={
        draft.level !== "none" || dirty ? (
          <div className="mail-agent">
            {draft.level !== "none" && (
              <>
                <label className="routine-active" htmlFor={`mail-del-${account.id}`}>
                  <Switch
                    id={`mail-del-${account.id}`}
                    checked={draft.canDelete}
                    disabled={!editable}
                    onCheckedChange={(canDelete) => change({ canDelete })}
                    aria-describedby={`mail-del-${account.id}-help`}
                  />
                  <span>
                    {t("mail.agent.canDelete")}
                    <span id={`mail-del-${account.id}-help`} className="small muted mail-agent__help">
                      {t("mail.agent.canDeleteHelp")}
                    </span>
                  </span>
                </label>
                <details className="mail-rules">
                  <summary aria-label={t("mail.agent.rulesOf", { address: account.address })}>
                    <Icon name="filter" size={14} />
                    <span>{t("mail.agent.rules")}</span>
                    {count > 0 ? (
                      <CountChip size="sm">{count}</CountChip>
                    ) : (
                      <span className="small muted">{t("mail.agent.noRules")}</span>
                    )}
                  </summary>
                  <MailRulesPanel
                    key={round}
                    accountId={account.id}
                    address={account.address}
                    policy={draft.policy}
                    onChange={(policy) => change({ policy })}
                    disabled={!editable}
                  />
                </details>
              </>
            )}
            {error && <Alert>{error}</Alert>}
            {dirty && editable && (
              <div className="mail-agent__save">
                <span className="small muted">{t("mail.agent.unsaved")}</span>
                <Button size="sm" onClick={reset}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="primary" disabled={set.isPending} loading={set.isPending} onClick={save}>
                  {t("mail.agent.save")}
                </Button>
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * The rules for one mailbox: folders (none = all), senders, a time window,
 * recipients, the daily send cap, "Enviar sem pedir aprovação" (only with
 * recipients) and the From alias.
 */
export function MailRulesPanel({
  accountId,
  address,
  policy,
  onChange,
  disabled,
}: {
  accountId: string;
  address: string;
  policy: MailPolicy;
  onChange: (policy: MailPolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const folders = useMailFolders(org.id, accountId);
  const set = (next: Partial<MailPolicy>) => onChange(normalizePolicy({ ...policy, ...next }));
  const id = (name: string) => `mail-${name}-${accountId}`;
  const [from, setFrom] = useState(policy.fromAddress ?? "");
  const fromInvalid = from.trim() !== "" && !isAddress(from);
  const unlocked = canSendWithoutAsking(policy);
  const numberOrNull = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    <div className="mail-rules__body">
      <fieldset className="mail-rules__group">
        <legend className="ac-field__label">{t("mail.rule.folders")}</legend>
        {folders.isLoading ? (
          <span className="small muted">{t("mail.rule.foldersLoading")}</span>
        ) : folders.isError ? (
          <span className="small muted">{t("mail.rule.foldersError")}</span>
        ) : (
          <div className="newag__pills">
            {(folders.data ?? []).map((f) => (
              <CheckboxPill
                key={f.id}
                id={id(`folder-${f.id}`)}
                disabled={disabled}
                checked={policy.folders.includes(f.id)}
                onCheckedChange={(on) =>
                  set({ folders: on ? [...policy.folders, f.id] : policy.folders.filter((x) => x !== f.id) })
                }
              >
                {f.role === "inbox" ? t("mail.routine.inbox") : f.name}
              </CheckboxPill>
            ))}
          </div>
        )}
        <span className="small muted">{t("mail.rule.foldersHelp")}</span>
      </fieldset>
      <AddressList
        id={id("senders")}
        label={t("mail.rule.senders")}
        help={t("mail.rule.sendersHelp")}
        values={policy.senders}
        onChange={(senders) => set({ senders })}
        disabled={disabled}
      />
      <Field label={t("mail.rule.window")} id={id("window")} help={t("mail.rule.windowHelp")}>
        <span className="mail-rules__unit">
          <Input
            className="ac-num"
            type="number"
            min={1}
            inputMode="numeric"
            disabled={disabled}
            value={policy.windowDays ?? ""}
            onChange={(e) => set({ windowDays: numberOrNull(e.target.value) })}
          />
          <span className="small muted">{t("mail.rule.windowUnit")}</span>
        </span>
      </Field>
      <AddressList
        id={id("recipients")}
        label={t("mail.rule.recipients")}
        help={t("mail.rule.recipientsHelp")}
        values={policy.allowedRecipients}
        onChange={(allowedRecipients) => set({ allowedRecipients })}
        disabled={disabled}
      />
      <Field label={t("mail.rule.cap")} id={id("cap")}>
        <Input
          className="ac-num mail-rules__cap"
          type="number"
          min={0}
          inputMode="numeric"
          disabled={disabled}
          value={policy.dailySendCap}
          onChange={(e) => set({ dailySendCap: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
        />
      </Field>
      <label className="routine-active" htmlFor={id("auto")}>
        <Switch
          id={id("auto")}
          checked={policy.sendWithoutAsking}
          disabled={disabled || !unlocked}
          onCheckedChange={(sendWithoutAsking) => set({ sendWithoutAsking })}
          aria-describedby={id("auto-help")}
        />
        <span>
          {t("mail.rule.sendWithoutAsking")}
          <span id={id("auto-help")} className="small muted mail-agent__help">
            {unlocked ? t("mail.rule.sendWithoutAskingHelp") : t("mail.rule.sendWithoutAskingLocked")}
          </span>
        </span>
      </label>
      {policy.sendWithoutAsking && policy.senders.length === 0 && (
        <p className="sandbox-warning small" role="note">
          <Icon name="alert" size={16} />
          {t("mail.agent.warning")}
        </p>
      )}
      <Field
        label={t("mail.rule.from")}
        id={id("from")}
        help={t("mail.rule.fromHelp", { address })}
        error={fromInvalid ? t("mail.rule.fromInvalid") : undefined}
      >
        <Input
          type="email"
          inputMode="email"
          disabled={disabled}
          value={from}
          placeholder={address}
          onChange={(e) => {
            setFrom(e.target.value);
            const v = e.target.value.trim();
            if (v === "" || isAddress(v)) set({ fromAddress: v === "" ? null : v.toLowerCase() });
          }}
        />
      </Field>
    </div>
  );
}
