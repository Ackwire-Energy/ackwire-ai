import type { WikiFolderAudience, WikiPage } from "@agenteschat/client";
import { useRoles, useSetWikiFolderAudience, useWikiAction, useWikiFolderAudience } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  OPEN_WIKI_ACCESS,
  type WikiAccess,
  type WikiAccessDraft,
  type WikiLevel,
  wikiAccessDraft,
  wikiAccessLimited,
  wikiAccessOf,
  wikiBaseLevels,
  wikiRowCap,
} from "@agenteschat/client/lib/wiki";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  fold,
  RadioCard,
  RadioGroup,
  RoleMark,
  SearchField,
  Select,
} from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * "Quem vê" a wiki page or folder (ADR 0023 addenda): a level for everyone and one per role, person and agent, people
 * and agents apart. Owners always read and edit; the server refuses a choice that leaves out whoever makes it. A page's
 * dialog can also set the page's folder.
 */
export function WikiAudienceDialog({
  page,
  folder,
  onClose,
}: {
  page?: WikiPage;
  folder?: string;
  onClose: () => void;
}) {
  const { org } = useOrg();
  const [onFolder, setOnFolder] = useState(folder ?? null);
  const info = useWikiFolderAudience(org.id, onFolder ?? "", Boolean(onFolder));
  if (onFolder) {
    if (!info.data) return null;
    return (
      <FolderForm key={onFolder} folder={onFolder} own={info.data.own} above={info.data.above} onClose={onClose} />
    );
  }
  if (!page) return null;
  return <PageForm page={page} onFolder={setOnFolder} onClose={onClose} />;
}

function PageForm({
  page,
  onFolder,
  onClose,
}: {
  page: WikiPage;
  onFolder: (folder: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useWikiAction(org.id);
  return (
    <AudienceForm
      title={t("wiki.audienceTitle", { title: page.title })}
      description={t("wiki.audienceText")}
      initial={{
        audience: page.audience ?? null,
        agentIds: page.agentIds ?? null,
        editors: page.editors ?? null,
        agentEditorIds: page.agentEditorIds ?? null,
      }}
      above={page.folderAudience ?? null}
      saving={action.isPending}
      extra={
        page.folder ? (
          <Button onClick={() => onFolder(page.folder)}>{t("wiki.audienceUseFolder", { folder: page.folder })}</Button>
        ) : null
      }
      onClose={onClose}
      onSave={(access) =>
        action.mutate(
          { type: "audience", slug: page.slug, access },
          {
            onSuccess: () => {
              toast.show(wikiAccessLimited(access) ? t("wiki.audienceSaved") : t("wiki.audienceOpened"));
              onClose();
            },
            onError: (e) => toast.show(errorText(t, e), "error"),
          },
        )
      }
    />
  );
}

function FolderForm({
  folder,
  own,
  above,
  onClose,
}: {
  folder: string;
  own: WikiFolderAudience | null;
  above: WikiFolderAudience | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSetWikiFolderAudience(org.id);
  return (
    <AudienceForm
      title={t("wiki.audienceFolderTitle", { folder })}
      description={t("wiki.audienceFolderText")}
      initial={own ?? above ?? OPEN_WIKI_ACCESS}
      above={above}
      saving={save.isPending}
      onClose={onClose}
      onSave={(access) =>
        save.mutate(
          { folder, access },
          {
            onSuccess: () => {
              toast.show(wikiAccessLimited(access) ? t("wiki.audienceFolderSaved") : t("wiki.audienceFolderOpened"));
              onClose();
            },
            onError: (e) => toast.show(errorText(t, e), "error"),
          },
        )
      }
    />
  );
}

/** One role, person or agent: on or off, with its level when "everyone" gives none. */
function AccessRow({
  id,
  name,
  base,
  level,
  cap,
  onChange,
  children,
}: {
  id: string;
  name: string;
  base: WikiLevel;
  level: WikiLevel;
  cap: WikiLevel;
  onChange: (level: WikiLevel) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const on = base === "view" ? level === "edit" : level !== "none";
  const most = cap === "edit" ? "edit" : "view";
  return (
    <div className="wiki-access-row">
      <label htmlFor={id} className="scope-row">
        <Checkbox id={id} checked={on} onCheckedChange={(next) => onChange(next ? most : "none")} />
        {children}
      </label>
      {base === "none" && on && (
        <Select
          size="sm"
          aria-label={t("wiki.audienceLevel", { name })}
          value={level === "edit" ? "edit" : "view"}
          onValueChange={onChange}
          options={[
            { value: "view" as const, label: t("wiki.audienceLevelView") },
            ...(cap === "edit" ? [{ value: "edit" as const, label: t("wiki.audienceLevelEdit") }] : []),
          ]}
        />
      )}
    </div>
  );
}

function AudienceForm({
  title,
  description,
  initial,
  above,
  saving,
  extra,
  onSave,
  onClose,
}: {
  title: string;
  description: string;
  initial: WikiAccess;
  /** The limited folder this sits in: here it can only be narrower. */
  above: WikiFolderAudience | null;
  saving: boolean;
  extra?: ReactNode;
  onSave: (access: WikiAccess) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const dir = useDirectory(org.id);
  const [draft, setDraft] = useState<WikiAccessDraft>(() => wikiAccessDraft(initial));
  const [query, setQuery] = useState("");
  const cap = wikiAccessDraft(above ?? OPEN_WIKI_ACCESS);
  const peopleBases = wikiBaseLevels(cap.people);
  const agentBases = wikiBaseLevels(cap.agents);
  const custom = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).filter(
    (r) => wikiRowCap(cap.people, cap.roles[r.id]) !== "none",
  );
  const q = fold(query.trim());
  const people = dir.members.filter((m) => !q || fold(`${m.name} ${m.email}`).includes(q));
  const agents = dir.agents.filter((a) => wikiRowCap(cap.agents, cap.agentRows[a.id]) !== "none");
  const setRow = (group: "roles" | "users" | "agentRows", id: string, level: WikiLevel) =>
    setDraft((d) => ({ ...d, [group]: { ...d[group], [id]: level } }));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      closeLabel={t("common.close")}
      width={600}
    >
      <div className="stack-4" style={{ gap: 12 }}>
        {above && <p className="small muted">{t("wiki.audienceInFolder", { folder: above.folder })}</p>}
        <span className="ac-field__label">{t("wiki.audiencePeople")}</span>
        <RadioGroup
          value={draft.people}
          onValueChange={(v) => setDraft((d) => ({ ...d, people: v as WikiLevel }))}
          aria-label={t("wiki.audiencePeople")}
          className="stack-4"
          style={{ gap: 8 }}
        >
          <RadioCard
            value="edit"
            id="wiki-audience-everyone"
            checked={draft.people === "edit"}
            disabled={!peopleBases.includes("edit")}
            title={t("wiki.audienceEveryone")}
            description={t("wiki.audienceEveryoneText")}
          />
          <RadioCard
            value="view"
            id="wiki-audience-everyone-view"
            checked={draft.people === "view"}
            disabled={!peopleBases.includes("view")}
            title={t("wiki.audienceEveryoneView")}
            description={t("wiki.audienceEveryoneViewText")}
          />
          <RadioCard
            value="none"
            id="wiki-audience-limited"
            checked={draft.people === "none"}
            title={t("wiki.audienceLimited")}
            description={t("wiki.audienceLimitedText")}
          />
        </RadioGroup>
        {draft.people !== "edit" && (
          <div className="people-picker">
            {draft.people === "view" && <span className="ac-field__label">{t("wiki.audienceEditors")}</span>}
            <span className="ac-field__label">{t("wiki.audienceRoles")}</span>
            {custom.map((r) => (
              <AccessRow
                key={r.id}
                id={`wiki-audience-r-${r.id}`}
                name={r.name}
                base={draft.people}
                level={draft.roles[r.id] ?? "none"}
                cap={wikiRowCap(cap.people, cap.roles[r.id])}
                onChange={(level) => setRow("roles", r.id, level)}
              >
                <RoleMark color={r.color} icon={r.icon} size={18} />
                <span className="scope-row__text">{r.name}</span>
              </AccessRow>
            ))}
            <span className="ac-field__label">{t("wiki.audiencePeople")}</span>
            <SearchField
              size="sm"
              aria-label={t("wiki.audienceSearch")}
              placeholder={t("wiki.audienceSearch")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              clearLabel={t("filters.clearSearch")}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
            <div className="people-picker__results" role="region" aria-label={t("wiki.audiencePeople")}>
              {people.length === 0 ? (
                <p className="small muted">{t("wiki.audienceNoMatch")}</p>
              ) : (
                people.map((m) => (
                  <AccessRow
                    key={m.userId}
                    id={`wiki-audience-p-${m.userId.replace(/[^a-zA-Z0-9]/g, "-")}`}
                    name={m.name}
                    base={draft.people}
                    level={draft.users[m.userId] ?? "none"}
                    cap="edit"
                    onChange={(level) => setRow("users", m.userId, level)}
                  >
                    <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                    <span className="scope-row__text">
                      <span>{m.name}</span>
                      <span className="small muted">{m.email}</span>
                    </span>
                  </AccessRow>
                ))
              )}
            </div>
          </div>
        )}
        <span className="ac-field__label">{t("wiki.audienceAgents")}</span>
        <RadioGroup
          value={draft.agents}
          onValueChange={(v) => setDraft((d) => ({ ...d, agents: v as WikiLevel }))}
          aria-label={t("wiki.audienceAgents")}
          className="stack-4"
          style={{ gap: 8 }}
        >
          <RadioCard
            value="edit"
            id="wiki-audience-agents-all"
            checked={draft.agents === "edit"}
            disabled={!agentBases.includes("edit")}
            title={t("wiki.audienceAgentsAll")}
            description={t("wiki.audienceAgentsAllText")}
          />
          <RadioCard
            value="view"
            id="wiki-audience-agents-view"
            checked={draft.agents === "view"}
            disabled={!agentBases.includes("view")}
            title={t("wiki.audienceAgentsView")}
            description={t("wiki.audienceAgentsViewText")}
          />
          <RadioCard
            value="none"
            id="wiki-audience-agents-only"
            checked={draft.agents === "none"}
            title={t("wiki.audienceAgentsOnly")}
            description={t("wiki.audienceAgentsOnlyText")}
          />
        </RadioGroup>
        {draft.agents !== "edit" && (
          <div className="people-picker">
            {draft.agents === "view" && <span className="ac-field__label">{t("wiki.audienceEditors")}</span>}
            {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
            <div className="people-picker__results" role="region" aria-label={t("wiki.audienceAgents")}>
              {agents.map((a) => (
                <AccessRow
                  key={a.id}
                  id={`wiki-audience-a-${a.id}`}
                  name={a.name}
                  base={draft.agents}
                  level={draft.agentRows[a.id] ?? "none"}
                  cap={wikiRowCap(cap.agents, cap.agentRows[a.id])}
                  onChange={(level) => setRow("agentRows", a.id, level)}
                >
                  <AgentAvatar agent={a} size="sm" name={a.name} />
                  <span className="scope-row__text">{a.name}</span>
                </AccessRow>
              ))}
            </div>
          </div>
        )}
        <p className="small muted">{t("wiki.audienceEditNote")}</p>
      </div>
      <DialogFooter>
        {extra}
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={saving} disabled={saving} onClick={() => onSave(wikiAccessOf(draft))}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
