import type { MailAccount, MailFolder, Routine, RoutineEmailFilter } from "@agenteschat/client";
import { useMailAccounts, useMailFolders } from "@agenteschat/client";
import { Field, Icon, Input, Select } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";

/**
 * "Quando chegar um email" (ADR 0038): which mailbox, which folder (the inbox
 * by default) and optional filters (de, assunto contém, texto contém).
 */
export interface EmailTriggerDraft {
  accountId: string;
  folder: string;
  filter: RoutineEmailFilter;
}

export const INBOX = "INBOX";

/** The inbox among a mailbox's folders (by role, then by name), or the IMAP name. */
export const inboxOf = (folders: MailFolder[] | undefined) =>
  folders?.find((f) => f.role === "inbox")?.id ?? folders?.find((f) => f.id.toUpperCase() === INBOX)?.id ?? INBOX;

export const isInbox = (folder: string) => folder.toUpperCase() === INBOX;

/** Only the filters that say something (empty ones are left out of the trigger). */
export function cleanFilter(filter: RoutineEmailFilter): RoutineEmailFilter {
  return {
    ...(filter.from && filter.from.length > 0 ? { from: filter.from } : {}),
    ...(filter.subject?.trim() ? { subject: filter.subject.trim() } : {}),
    ...(filter.text?.trim() ? { text: filter.text.trim() } : {}),
  };
}

export function EmailTriggerFields({
  value,
  onChange,
}: {
  value: EmailTriggerDraft;
  onChange: (value: EmailTriggerDraft) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const accounts = useMailAccounts(org.id);
  const list = accounts.data ?? [];
  const folders = useMailFolders(org.id, value.accountId || null);
  // The first mailbox, and its inbox, until the person picks.
  useEffect(() => {
    if (!value.accountId && list[0]) onChange({ ...value, accountId: list[0].id, folder: "" });
  }, [value, list, onChange]);
  useEffect(() => {
    if (value.accountId && !value.folder && (folders.data || folders.isError))
      onChange({ ...value, folder: inboxOf(folders.data) });
  }, [value, folders.data, folders.isError, onChange]);
  if (accounts.isSuccess && list.length === 0) {
    return (
      <p className="newag__note">
        <Icon name="mail" size={16} />
        <span>
          {t("mail.routine.noMailbox")}{" "}
          <Link
            className="ac-link"
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "connectors" }}
          >
            {t("mail.routine.openConnectors")}
          </Link>
        </span>
      </p>
    );
  }
  const folderOptions = folders.data?.length
    ? folders.data.map((f) => ({
        value: f.id,
        label: isInbox(f.id) || f.role === "inbox" ? t("mail.routine.inbox") : f.name,
      }))
    : [
        {
          value: value.folder || INBOX,
          label: isInbox(value.folder || INBOX) ? t("mail.routine.inbox") : value.folder,
        },
      ];
  const setFilter = (filter: RoutineEmailFilter) => onChange({ ...value, filter });
  return (
    <div className="routine-email">
      <div className="grid-fields">
        <Field label={t("mail.routine.mailbox")} id="nr-mailbox">
          <Select
            value={value.accountId || undefined}
            onValueChange={(accountId) => onChange({ ...value, accountId, folder: "" })}
            options={list.map((a) => ({ value: a.id, label: a.address }))}
          />
        </Field>
        <Field label={t("mail.routine.folder")} id="nr-folder">
          <Select
            value={value.folder || undefined}
            onValueChange={(folder) => onChange({ ...value, folder })}
            options={folderOptions}
          />
        </Field>
      </div>
      <span className="ac-eyebrow">{t("mail.routine.filters")}</span>
      <AddressList
        id="nr-mail-from"
        label={t("mail.routine.from")}
        help={t("mail.routine.fromHelp")}
        values={value.filter.from ?? []}
        onChange={(from) => setFilter({ ...value.filter, from })}
      />
      <div className="grid-fields">
        <Field label={t("mail.routine.subject")} id="nr-mail-subject">
          <Input
            value={value.filter.subject ?? ""}
            onChange={(e) => setFilter({ ...value.filter, subject: e.target.value })}
          />
        </Field>
        <Field label={t("mail.routine.text")} id="nr-mail-text">
          <Input
            value={value.filter.text ?? ""}
            onChange={(e) => setFilter({ ...value.filter, text: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

/** "Quando chegar um email em ana@empresa.com (Clientes)": the folder only when it isn't the inbox. */
export function emailWhen(t: TFunction, routine: Routine, accounts: MailAccount[] | undefined) {
  if (routine.trigger.type !== "email") return "";
  const { accountId, folder } = routine.trigger;
  const address = accounts?.find((a) => a.id === accountId)?.address ?? t("mail.routine.unknownMailbox");
  return folder && !isInbox(folder)
    ? t("mail.routine.whenFolder", { address, folder })
    : t("mail.routine.when", { address });
}
