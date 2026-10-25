import { Button, Card, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ObsidianMark } from "./ObsidianMark";
import { type useVaultReader, VaultDropZone, VaultLines, VaultReading, VaultStats, vaultMapping } from "./WikiImport";

/**
 * Onboarding, step 2: an
 * Obsidian vault becomes the workspace's wiki. Read here; imported when the
 * person continues (the workspace exists by then).
 */
export function VaultCard({ reader }: { reader: ReturnType<typeof useVaultReader> }) {
  const { t, i18n } = useTranslation();
  const { state, report } = reader;
  return (
    <Card as="section" className="vault-card" aria-label={t("onboarding.vault.title")}>
      <div className="vault-card__head">
        <span className="vault-card__icon">
          <ObsidianMark size={22} />
        </span>
        <span className="vault-card__t">
          <b>{t("onboarding.vault.title")}</b>
          <span className="small muted">{t("onboarding.vault.text")}</span>
        </span>
        {state.step === "ready" ? (
          <span className="ac-chip ac-chip--ok">
            <Icon name="check" />
            {t("onboarding.vault.ready")}
          </span>
        ) : (
          <span className="ac-chip">
            <Icon name="dash" />
            {t("onboarding.vault.optional")}
          </span>
        )}
      </div>
      {state.step === "idle" && <VaultDropZone compact onFiles={(f, n) => void reader.read(f, n)} />}
      {state.step === "reading" && <VaultReading {...state} label={t("wiki.import.notesRead")} />}
      {state.step === "ready" && report && (
        <>
          <div className="vault-card__name">
            <b>{report.name}</b>
            <Button size="sm" variant="ghost" onClick={reader.reset}>
              {t("wiki.import.another")}
            </Button>
          </div>
          <VaultStats report={report} />
          <div className="vault-card__folders">
            {report.folders.map((f) => (
              <span key={f.name || "/"} className="ac-chip">
                <Icon name="drive" />
                {f.name || t("wiki.import.rootNotes")} · {f.count}
              </span>
            ))}
          </div>
          <VaultLines lines={vaultMapping(t, i18n.language, report).slice(0, 5)} />
          <p className="vault-notice">
            <Icon name="info" size={16} />
            <span>{t("onboarding.vault.when")}</span>
          </p>
        </>
      )}
    </Card>
  );
}
