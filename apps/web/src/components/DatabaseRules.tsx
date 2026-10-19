import type { DatabasePolicy } from "@agenteschat/client";
import { useDatabaseTables } from "@agenteschat/client";
import { DATABASE_TIMEOUTS, splitColumns } from "@agenteschat/client/lib/databases";
import { CheckboxPill, Field, Input, Segmented } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";

/**
 * The rules for one database (ADR 0039), in the email rules' shape: tables
 * (none = all), hidden columns, a daily cap and the time limit per query.
 */
export function DatabaseRulesPanel({
  connectionId,
  policy,
  onChange,
  disabled,
}: {
  connectionId: string;
  policy: DatabasePolicy;
  onChange: (policy: DatabasePolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const tables = useDatabaseTables(org.id, connectionId);
  const set = (next: Partial<DatabasePolicy>) => onChange({ ...policy, ...next });
  const id = (name: string) => `db-${name}-${connectionId}`;
  const numberOrNull = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    <div className="mail-rules__body">
      <section className="mail-rules__part" aria-labelledby={id("read-h")}>
        <h4 id={id("read-h")} className="mail-rules__h">
          {t("database.rulesRead")}
        </h4>
        <fieldset className="mail-rules__group">
          <legend className="ac-field__label">{t("database.rule.tables")}</legend>
          {tables.isLoading ? (
            <span className="small muted">{t("database.rule.tablesLoading")}</span>
          ) : tables.isError ? (
            <span className="small muted">{t("database.rule.tablesError")}</span>
          ) : (
            <div className="newag__pills">
              {(tables.data ?? []).map((table) => {
                const name = `${table.schema}.${table.name}`.toLowerCase();
                return (
                  <CheckboxPill
                    key={name}
                    id={id(`table-${name}`)}
                    disabled={disabled}
                    checked={policy.tables.includes(name)}
                    onCheckedChange={(on) =>
                      set({ tables: on ? [...policy.tables, name] : policy.tables.filter((x) => x !== name) })
                    }
                  >
                    {table.schema === "public" ? table.name : name}
                  </CheckboxPill>
                );
              })}
            </div>
          )}
          <span className="small muted">{t("database.rule.tablesHelp")}</span>
        </fieldset>
        <AddressList
          id={id("hidden")}
          label={t("database.rule.hidden")}
          help={t("database.rule.hiddenHelp")}
          values={policy.hiddenColumns}
          onChange={(hiddenColumns) => set({ hiddenColumns })}
          disabled={disabled}
          split={splitColumns}
          inputMode="text"
          placeholder={t("database.rule.hiddenPlaceholder")}
          invalidText={t("database.rule.hiddenInvalid")}
        />
      </section>
      <section className="mail-rules__part" aria-labelledby={id("limits-h")}>
        <h4 id={id("limits-h")} className="mail-rules__h">
          {t("database.rulesLimits")}
        </h4>
        <Field label={t("database.rule.cap")} id={id("cap")} help={t("database.rule.capHelp")}>
          <Input
            className="ac-num mail-rules__cap"
            type="number"
            min={1}
            inputMode="numeric"
            disabled={disabled}
            value={policy.dailyQueryCap ?? ""}
            onChange={(e) => set({ dailyQueryCap: numberOrNull(e.target.value) })}
          />
        </Field>
        <div className="ac-field">
          <span className="ac-field__label" id={id("timeout")}>
            {t("database.rule.timeout")}
          </span>
          <Segmented
            size="sm"
            label={t("database.rule.timeout")}
            value={String(policy.timeoutSeconds)}
            onValueChange={(v) => !disabled && set({ timeoutSeconds: Number(v) })}
            options={DATABASE_TIMEOUTS.map((s) => ({
              value: String(s),
              label: t("database.rule.seconds", { count: s }),
            }))}
          />
          <span className="ac-field__help">{t("database.rule.timeoutHelp")}</span>
        </div>
      </section>
    </div>
  );
}
