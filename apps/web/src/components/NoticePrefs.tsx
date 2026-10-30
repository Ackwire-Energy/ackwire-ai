import { type NoticeCategory, useNoticePrefs, useSetNoticePref } from "@agenteschat/client";
import { Card, CardHeader, Chip, Icon, type IconName, Switch } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useBrowserNotices } from "@/components/WebPush";
import { inDesktopApp } from "@/lib/desktop";
import { useToast } from "@/lib/toast";

const ICONS: Record<NoticeCategory, IconName> = {
  waiting: "waiting",
  replies: "reply",
  mentions: "message",
  threads: "thread",
  tasks: "issues",
  routines: "routines",
  computers: "computer",
  reactions: "smile",
};

/**
 * Configurações › Notificações (ADR 0071 §8): where notifications reach me (this browser, my phone, the Mac app),
 * then one switch per kind for this workspace. The inbox keeps everything; these choose what becomes a push or a
 * banner.
 */
export function NoticePrefsSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const prefs = useNoticePrefs(org.id);
  const set = useSetNoticePref(org.id);
  const browser = useBrowserNotices();
  const phones = prefs.data?.phones ?? 0;

  return (
    <>
      <Card aria-labelledby="notice-where">
        <CardHeader id="notice-where" icon="bell" title={t("noticePrefs.whereTitle")} />
        <div className="settings-rows">
          {browser.shown && !inDesktopApp() && (
            <Row
              id="notice-browser"
              icon="globe"
              label={t("noticePrefs.browser")}
              help={browser.blocked ? t("shell.browserNoticesBlocked") : t("shell.browserNoticesHint")}
              control={
                <Switch
                  checked={browser.on}
                  onCheckedChange={browser.change}
                  disabled={browser.blocked || browser.busy}
                  aria-label={t("noticePrefs.browser")}
                  aria-describedby="notice-browser-help"
                />
              }
            />
          )}
          <Row
            id="notice-phone"
            icon="phone"
            label={t("noticePrefs.phone")}
            help={phones > 0 ? t("noticePrefs.phoneOn") : t("noticePrefs.phoneOff")}
            control={
              prefs.data &&
              (phones > 0 ? (
                <Chip icon="check" tone="done">
                  {t("noticePrefs.on")}
                </Chip>
              ) : (
                <Chip>{t("noticePrefs.off")}</Chip>
              ))
            }
          />
          <Row id="notice-mac" icon="computerMac" label={t("noticePrefs.mac")} help={t("noticePrefs.macHelp")} />
        </div>
      </Card>

      <Card aria-labelledby="notice-what">
        <CardHeader id="notice-what" icon="preference" title={t("noticePrefs.whatTitle")} />
        {prefs.data ? (
          <div className="settings-rows">
            {prefs.data.categories.map((c) => (
              <Row
                key={c.id}
                id={`notice-${c.id}`}
                icon={ICONS[c.id]}
                label={t(`noticePrefs.category.${c.id}.title`)}
                help={t(`noticePrefs.category.${c.id}.help`)}
                control={
                  <Switch
                    checked={c.on}
                    onCheckedChange={(on) =>
                      set.mutate(
                        { category: c.id, on },
                        { onError: () => toast.show(t("noticePrefs.failed"), "error") },
                      )
                    }
                    aria-label={t(`noticePrefs.category.${c.id}.title`)}
                    aria-describedby={`notice-${c.id}-help`}
                  />
                }
              />
            ))}
          </div>
        ) : prefs.isError ? (
          <p className="muted">{t("noticePrefs.loadFailed")}</p>
        ) : (
          <LoadingLine width={320} />
        )}
      </Card>
    </>
  );
}

/** One line: its icon, its name and what it covers, then its control (when it has one). */
function Row({
  id,
  icon,
  label,
  help,
  control,
}: {
  id: string;
  icon: IconName;
  label: string;
  help: string;
  control?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <span className="ac-card__key notice-prefs__icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        <span className="settings-row__help" id={`${id}-help`}>
          {help}
        </span>
      </div>
      {control ? <div className="notice-prefs__control">{control}</div> : null}
    </div>
  );
}
