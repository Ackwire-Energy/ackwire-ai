import { useGitHubApp, useInstallGitHubApp, useRemoveGitHubApp } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, InfoHint, List } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * Settings → Conectores: the GitHub accounts where the organization installed
 * our GitHub App (repository access for agents' git and pull requests). Only
 * installations made from here count for this organization (ADR 0033).
 * Hidden when the server has no GitHub App and nothing is installed.
 */
export function GitHubAppPanel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  const toast = useToast();
  const info = useGitHubApp(org.id);
  const install = useInstallGitHubApp(org.id);
  const remove = useRemoveGitHubApp(org.id);

  // Back from GitHub: `?github_app=installed`.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github_app") !== "installed") return;
    toast.show(t("githubApp.installed"));
    window.history.replaceState(null, "", window.location.pathname);
  }, [toast, t]);

  const installations = info.data?.installations ?? [];
  if (!info.data || (!info.data.installable && installations.length === 0)) return null;
  return (
    <section className="stack-4" aria-labelledby="sec-github-app" style={{ marginTop: 16 }}>
      <div className="row" style={{ gap: 12 }}>
        <div className="ac-hintline" style={{ flex: "1 1 280px" }}>
          <h3 id="sec-github-app" className="ac-card__title">
            {t("githubApp.title")}
          </h3>
          <InfoHint name={t("common.about", { label: t("githubApp.title") })}>
            {t("githubApp.text", { org: org.name })}
          </InfoHint>
        </div>
        {admin && info.data.installable && (
          <Button
            size="sm"
            icon="plus"
            loading={install.isPending}
            disabled={install.isPending}
            onClick={() =>
              install.mutate(`/org/${org.id}/settings/connectors`, { onSuccess: (url) => navigateAway(url) })
            }
          >
            {t("githubApp.install")}
          </Button>
        )}
      </div>
      {installations.length === 0 ? (
        <p className="small muted">{t("githubApp.none")}</p>
      ) : (
        <List aria-label={t("githubApp.title")}>
          {installations.map((i) => (
            <div key={i.id} className="ac-list__row connected-row">
              <span className="list-col connected-row__text">
                <span className="connected-row__name">
                  <span>{i.accountLogin}</span>
                  {i.suspended ? (
                    <Chip icon="waiting" tone="waiting">
                      {t("githubApp.suspended")}
                    </Chip>
                  ) : (
                    <Chip icon="check" tone="done">
                      {i.repositorySelection === "all" ? t("githubApp.allRepos") : t("githubApp.someRepos")}
                    </Chip>
                  )}
                </span>
              </span>
              {admin && (
                <div className="connected-row__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("githubApp.removeName", { account: i.accountLogin })}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(i.id, {
                        onSuccess: () => toast.show(t("githubApp.removed", { account: i.accountLogin })),
                      })
                    }
                  >
                    {t("githubApp.remove")}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </List>
      )}
    </section>
  );
}
