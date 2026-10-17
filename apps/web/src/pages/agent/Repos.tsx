import type { GitHubRepositories } from "@agenteschat/client";
import { useGitHubApp, useGitHubRepos, useInstallGitHubApp } from "@agenteschat/client";
import { can as orgCan } from "@agenteschat/client/lib/permissions";
import {
  applyPick,
  covers,
  isAccount,
  makeFirst,
  type RepoChoice,
  repoExists,
  repoName,
  toggleRepo,
} from "@agenteschat/client/lib/repos";
import {
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogFooter,
  DialogSearchList,
  Icon,
  type IconName,
  Menu,
  MenuItem,
  Segmented,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { navigateAway } from "@/lib/navigate";
import { ChangedTag, useAgentEdit, WasLine } from "./context";

/*
 * Which GitHub repositories the agent may use (RepositoriosAgente.html):
 * under the GitHub row of Ferramentas e acesso, the chips and "Mudar"; the
 * choice happens in a dialog. Changes go to the page's draft (save bar).
 */

const entryIcon = (entry: string, first: boolean): IconName => (first ? "pin" : isAccount(entry) ? "members" : "repo");

/** One repository of the list: a chip; for editors a menu (start here, remove). */
function RepoEntry({
  entry,
  first,
  gone,
  editable,
  onFirst,
  onRemove,
}: {
  entry: string;
  first: boolean;
  gone: boolean;
  editable: boolean;
  onFirst: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const name = repoName(t, entry);
  const text = gone ? t("repos.gone", { repo: name }) : name;
  if (!editable) {
    return (
      <Chip icon={gone ? "alert" : entryIcon(entry, first)} tone={gone ? "waiting" : "neutral"}>
        {text}
      </Chip>
    );
  }
  return (
    <Menu
      label={t("repos.options", { repo: name })}
      trigger={
        <button
          type="button"
          className={gone ? "ac-chip ac-chip--waiting agp-chipbtn" : "ac-chip agp-chipbtn"}
          title={gone ? t("repos.goneHelp") : first ? t("repos.startsHere") : undefined}
          aria-label={`${text} · ${t("repos.options", { repo: name })}`}
        >
          <Icon name={gone ? "alert" : entryIcon(entry, first)} size={14} />
          {text}
        </button>
      }
    >
      {!first && !gone && (
        <MenuItem icon="pin" description={t("repos.makeFirstHelp")} onSelect={onFirst}>
          {t("repos.makeFirst")}
        </MenuItem>
      )}
      <MenuItem icon="close" onSelect={onRemove}>
        {t("repos.remove")}
      </MenuItem>
    </Menu>
  );
}

/** Under the GitHub row: "Em quais repositórios", the chips, "Mudar". */
export function ReposBlock() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { g, draft, set, can, changeOf, errors, pickRepos } = useAgentEdit();
  const listing = useGitHubRepos(org.id);
  const r = draft.repos;
  if (!r) return <LoadingLine width={180} />;
  const editable = can("repos");
  const exists = (e: string) => repoExists(listing.data, e);
  const start = r.list.find(exists);
  return (
    <div className="agp-repos">
      <span className="agp-repos__label">
        {t("repos.label")}
        {changeOf("repos") && <ChangedTag changeKey="repos" />}
      </span>
      <span className="agp-chips">
        {r.mode === "all" ? (
          <>
            <Chip icon="globe">{t("repos.all")}</Chip>
            <span className="small muted">{t("repos.allHelp", g)}</span>
          </>
        ) : r.list.length === 0 ? (
          <span className="small muted">{t("repos.noneChosen")}</span>
        ) : (
          r.list.map((e, i) => (
            <RepoEntry
              key={e}
              entry={e}
              first={i === 0}
              gone={!exists(e)}
              editable={editable}
              onFirst={() => set("repos", { mode: "some", list: makeFirst(r.list, e) })}
              onRemove={() => set("repos", { mode: "some", list: r.list.filter((x) => x !== e) })}
            />
          ))
        )}
        {editable && (
          <Button size="sm" variant="ghost" icon="edit" onClick={() => pickRepos()}>
            {r.mode === "all" ? t("repos.choose") : t("repos.change")}
          </Button>
        )}
      </span>
      {r.mode === "some" && r.list.length > 1 && start && (
        <span className="small muted agp-repos__start">
          <Icon name="pin" size={14} />
          {t("repos.startsAt", { repo: repoName(t, start) })}
        </span>
      )}
      {errors.repos && (
        <span className="newag__err" role="alert">
          <Icon name="info" size={14} />
          {errors.repos}
        </span>
      )}
      <WasLine changeKey="repos" />
    </div>
  );
}

/** The rows of the picker for one account: "Toda a conta X" (no search), then its repositories. */
function AccountRows({
  account,
  query,
  list,
  onToggle,
}: {
  account: GitHubRepositories["accounts"][number];
  query: string;
  list: string[];
  onToggle: (entry: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const whole = `${account.login}/*`;
  const wholeOn = list.some((e) => e.toLowerCase() === whole.toLowerCase());
  const repos = account.repositories.filter((r) => !query || r.fullName.toLowerCase().includes(query));
  if (repos.length === 0 && query) return null;
  const id = (s: string) => `repo-${s.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <section className="agp-repogroup" aria-label={account.login}>
      <p className="ac-eyebrow">{account.login}</p>
      {!query && (
        <label htmlFor={id(whole)} className="scope-row">
          <Checkbox id={id(whole)} checked={wholeOn} onCheckedChange={(on) => onToggle(whole, on)} />
          <Icon name="members" size={16} />
          <span className="scope-row__text">
            <b>{t("repos.wholeAccount", { owner: account.login })}</b>
            <span className="small muted">{t("repos.wholeAccountHelp", { count: account.repositories.length })}</span>
          </span>
        </label>
      )}
      {repos.map((r) => (
        <label key={r.fullName} htmlFor={id(r.fullName)} className="scope-row" data-off={wholeOn || undefined}>
          <Checkbox
            id={id(r.fullName)}
            checked={covers(list, r.fullName)}
            disabled={wholeOn}
            onCheckedChange={(on) => onToggle(r.fullName, on)}
          />
          <Icon name={r.private ? "lock" : "globe"} size={16} />
          <span className="scope-row__text">
            <b>{r.fullName}</b>
            <span className="small muted">{r.private ? t("repos.private") : t("repos.public")}</span>
          </span>
        </label>
      ))}
    </section>
  );
}

/**
 * "Repositórios da Ada": Todos / Só alguns, search, the organization's
 * repositories by account. "Usar estes" puts the choice in the draft.
 * `add` ("Liberar") starts with that repository checked.
 */
export function RepoDialog({
  add,
  onClose,
  onUse,
}: {
  add?: string;
  onClose: () => void;
  onUse: (next: RepoChoice) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g, draft } = useAgentEdit();
  const listing = useGitHubRepos(org.id);
  const app = useGitHubApp(org.id);
  const install = useInstallGitHubApp(org.id);
  const current = draft.repos ?? { mode: "all", list: [] };
  const [pick, setPick] = useState<RepoChoice>(() =>
    add && !covers(current.list, add) ? { mode: "some", list: [...current.list, add] } : current,
  );
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const accounts = listing.data?.accounts ?? [];
  const matches = accounts.some((a) => a.repositories.some((r) => !query || r.fullName.toLowerCase().includes(query)));
  const canInstall = orgCan(org.role, "configure") && app.data?.installable === true;
  const exists = (e: string) => repoExists(listing.data, e);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("repos.dialogTitle", g)}
      closeLabel={t("common.close")}
      className="agp-repodialog"
    >
      <div className="ac-dialog__tools">
        <Segmented
          size="sm"
          label={t("repos.label")}
          value={pick.mode}
          onValueChange={(mode) => setPick((p) => ({ ...p, mode }))}
          options={[
            { value: "all" as const, label: t("repos.allShort") },
            { value: "some" as const, label: t("repos.some") },
          ]}
        />
      </div>
      {pick.mode === "all" ? (
        <p className="newag__note agp-repodialog__note">
          <Icon name="globe" size={16} />
          <span>{t("repos.allNote", { ...g, org: org.name })}</span>
        </p>
      ) : listing.isLoading ? (
        <div className="ac-dialog__body">
          <LoadingLine width={220} />
        </div>
      ) : listing.isError ? (
        <p className="ac-dialog__empty">{t("repos.unavailable")}</p>
      ) : (
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("repos.search")}
          searchPlaceholder={t("repos.search")}
          listLabel={t("repos.label")}
          isEmpty={!matches}
          emptyText={
            <span className="agp-repodialog__empty">
              <b>{query ? t("repos.noMatch", { q }) : t("repos.none")}</b>
              <span className="small muted">{t("repos.noMatchHelp")}</span>
              {canInstall && (
                <Button
                  size="sm"
                  icon="plus"
                  loading={install.isPending}
                  onClick={() =>
                    install.mutate(`/org/${org.id}/agents/${agent.id}?tab=access`, {
                      onSuccess: (url) => navigateAway(url),
                    })
                  }
                >
                  {t("repos.installOther")}
                </Button>
              )}
            </span>
          }
        >
          {accounts.map((a) => (
            <AccountRows
              key={a.login}
              account={a}
              query={query}
              list={pick.list}
              onToggle={(entry, on) => setPick((p) => ({ mode: "some", list: toggleRepo(p.list, entry, on) }))}
            />
          ))}
          {listing.data?.truncated && <p className="small muted">{t("repos.truncated")}</p>}
        </DialogSearchList>
      )}
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => onUse(applyPick(current.list, pick, exists))}>
          {t("repos.use")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The header chip: where the agent works on GitHub ("acme/loja +1", "Todos os repositórios"); opens its access. */
export function RepoHeaderChip() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { saved, resources, goTo } = useAgentEdit();
  const listing = useGitHubRepos(org.id);
  const github = resources.find((r) => r.kind === "connector" && r.connector === "github");
  const r = saved.repos;
  if (!github || !r || (saved.levels?.[github.id] ?? "none") === "none") return null;
  const ok = r.list.filter((e) => repoExists(listing.data, e));
  const first = ok[0];
  if (r.mode === "some" && !first) return null;
  return (
    <button
      type="button"
      className="ac-chip agp-chipbtn"
      title={t("repos.headerTitle", {
        list: r.mode === "all" ? t("repos.all") : ok.map((e) => repoName(t, e)).join(", "),
      })}
      onClick={() => goTo("access")}
    >
      <Icon name={r.mode === "all" || !first ? "globe" : entryIcon(first, false)} size={14} />
      {r.mode === "all" || !first ? t("repos.all") : repoName(t, first)}
      {ok.length > 1 && <span className="muted">+{ok.length - 1}</span>}
    </button>
  );
}

/** "· 2 repositórios" / "· todos os repositórios" after GitHub's level in Visão geral. */
export function useRepoSuffix() {
  const { t } = useTranslation();
  const { saved } = useAgentEdit();
  const r = saved.repos;
  if (!r) return "";
  return ` · ${r.mode === "all" ? t("repos.allLower") : t("repos.count", { count: r.list.length })}`;
}
