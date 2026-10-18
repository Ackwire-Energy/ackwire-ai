import type { MailPolicy } from "@agenteschat/client";
import { useMailFolders } from "@agenteschat/client";
import { canSendWithoutAsking, isAddress, normalizePolicy } from "@agenteschat/client/lib/mail";
import { CheckboxPill, Field, Icon, Input, Switch } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";

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
