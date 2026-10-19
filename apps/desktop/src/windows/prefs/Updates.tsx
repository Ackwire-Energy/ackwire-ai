import { Button, Chip } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../../app";
import { noteLines } from "../../control/version";
import type { UpdateCheck } from "../../hooks";
import { useToast } from "../../ui/Toast";
import { clock } from "../../ui/time";
import { CardTitle, PrefCard, PrefHead } from "./shared";

/**
 * Updates (ADR 0036 §9): one click installs the signed update and reopens the app. When that can't
 * happen (a release without the updater bundle, a failed download) the manual steps come back.
 */
export function Updates({ update }: { update: UpdateCheck }) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const { latest, available, required } = update.state;
  const [installing, setInstalling] = useState(false);
  const [manual, setManual] = useState(false);

  const install = async () => {
    setInstalling(true);
    try {
      // true: the app is about to reopen as the new version; keep the button busy until then.
      if (await host.installUpdate()) return;
      setManual(true);
    } catch {
      toast(t("desktop.prefs.updates.installFailed"), "alert");
      setManual(true);
    }
    setInstalling(false);
  };

  const checkNow = async () => {
    const result = await update.check();
    if (!result) toast(t("desktop.prefs.updates.checkFailed"), "alert");
    else if (!result.available) toast(t("desktop.prefs.updates.latestAlready"));
  };

  return (
    <>
      <PrefHead title={t("desktop.prefs.updates.title")} lead={t("desktop.prefs.updates.lead")} />
      <PrefCard>
        <div className="dk-ver">
          <span className="dk-ver__big ac-num">{update.version ?? "…"}</span>
          <span className="dk-ver__text">
            <span>
              {required ? (
                <Chip icon="alert" tone="waiting">
                  {t("desktop.prefs.updates.required")}
                </Chip>
              ) : available && latest ? (
                <Chip icon="download" tone="waiting">
                  {t("desktop.prefs.updates.newer", { version: latest.version })}
                </Chip>
              ) : (
                <Chip icon="check" tone="done">
                  {t("desktop.prefs.updates.upToDate")}
                </Chip>
              )}
            </span>
            <small className="dk-help">
              {update.checkedAt
                ? t("desktop.prefs.updates.lastCheck", {
                    time: clock(new Date(update.checkedAt).toISOString(), i18n.language),
                  })
                : t("desktop.prefs.updates.neverChecked")}
            </small>
          </span>
          <Button size="sm" loading={update.checking} onClick={() => void checkNow()}>
            {t("desktop.prefs.updates.checkNow")}
          </Button>
        </div>
      </PrefCard>

      {available && latest && (
        <>
          {!manual && (
            <PrefCard padded>
              <div className="dk-ver__acts">
                <Button variant="primary" icon="download" loading={installing} onClick={() => void install()}>
                  {t("desktop.prefs.updates.install")}
                </Button>
                <span className="dk-help">{t("desktop.prefs.updates.keepNote")}</span>
              </div>
            </PrefCard>
          )}
          {manual && (
            <>
              <CardTitle>{t("desktop.prefs.updates.howTitle")}</CardTitle>
              <PrefCard padded>
                <ol className="dk-steps-list">
                  <li>{t("desktop.prefs.updates.step1")}</li>
                  <li>{t("desktop.prefs.updates.step2")}</li>
                  <li>{t("desktop.prefs.updates.step3")}</li>
                </ol>
                <div className="dk-ver__acts">
                  <Button variant="primary" icon="download" onClick={() => void host.openExternal(latest.url)}>
                    {t("desktop.prefs.updates.download", { version: latest.version })}
                  </Button>
                  <span className="dk-help">{t("desktop.prefs.updates.keepNote")}</span>
                </div>
              </PrefCard>
            </>
          )}
          {noteLines(latest.notes).length > 0 && (
            <>
              <CardTitle>{t("desktop.prefs.updates.whatsNew", { version: latest.version })}</CardTitle>
              <PrefCard padded>
                <ul className="dk-changes">
                  {noteLines(latest.notes).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </PrefCard>
            </>
          )}
        </>
      )}
    </>
  );
}
