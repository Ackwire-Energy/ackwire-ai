import type { CustomServer, Routine, RoutineConnectorTrigger } from "@agenteschat/client";
import { useCustomServers } from "@agenteschat/client";
import { Field, Input, Select } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";

/**
 * "Quando chegar um email no MillionSend" (ADR 0130): the connection, the inbox's address (any inbox when empty) and
 * the same optional filters as a mailbox's (de, assunto contém).
 */
export interface ConnectorTriggerDraft {
  connectionId: string;
  filter: RoutineConnectorTrigger["filter"];
}

export const MILLIONSEND_EMAIL: RoutineConnectorTrigger["event"] = "millionsend.email.received";

/** The workspace's connections whose received email can start a routine. */
export function useEmailEventConnections(orgId: string): CustomServer[] {
  const servers = useCustomServers(orgId);
  return (servers.data ?? []).filter((s) => s.events?.includes(MILLIONSEND_EMAIL));
}

/** Only the filters that say something. */
export const cleanConnectorFilter = (f: RoutineConnectorTrigger["filter"]): RoutineConnectorTrigger["filter"] => ({
  ...(f.to?.trim() ? { to: f.to.trim().toLowerCase() } : {}),
  ...(f.from?.length ? { from: f.from } : {}),
  ...(f.subject?.trim() ? { subject: f.subject.trim() } : {}),
});

export function ConnectorTriggerFields({
  value,
  onChange,
}: {
  value: ConnectorTriggerDraft;
  onChange: (value: ConnectorTriggerDraft) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const list = useEmailEventConnections(org.id);
  useEffect(() => {
    if (!value.connectionId && list[0]) onChange({ ...value, connectionId: list[0].id });
  }, [value, list, onChange]);
  const setFilter = (filter: RoutineConnectorTrigger["filter"]) => onChange({ ...value, filter });
  return (
    <div className="routine-email">
      <div className="grid-fields">
        {list.length > 1 && (
          <Field label={t("routines.form.kind.connector")} id="nr-connection">
            <Select
              value={value.connectionId || undefined}
              onValueChange={(connectionId) => onChange({ ...value, connectionId })}
              options={list.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Field>
        )}
        <Field label={t("mail.routine.inboxAddress")} id="nr-inbox" help={t("mail.routine.inboxAddressHelp")}>
          <Input
            type="email"
            value={value.filter.to ?? ""}
            onChange={(e) => setFilter({ ...value.filter, to: e.target.value })}
          />
        </Field>
      </div>
      <span className="ac-eyebrow">{t("mail.routine.filters")}</span>
      <AddressList
        id="nr-ms-from"
        label={t("mail.routine.from")}
        help={t("mail.routine.fromHelp")}
        values={value.filter.from ?? []}
        onChange={(from) => setFilter({ ...value.filter, from })}
      />
      <Field label={t("mail.routine.subject")} id="nr-ms-subject">
        <Input
          value={value.filter.subject ?? ""}
          onChange={(e) => setFilter({ ...value.filter, subject: e.target.value })}
        />
      </Field>
    </div>
  );
}

/** "Quando chegar um email em vendas@loja.com", or in any MillionSend inbox. */
export function connectorWhen(t: TFunction, routine: Routine) {
  if (routine.trigger.type !== "connector") return "";
  const to = routine.trigger.filter.to;
  return to ? t("mail.routine.when", { address: to }) : t("mail.routine.whenMillionSend");
}
