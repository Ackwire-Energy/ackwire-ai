import type { WikiAudience, WikiFolderAudience, WikiPage } from "@agenteschat/client";
import { useRoles, useSetWikiFolderAudience, useWikiAction, useWikiFolderAudience } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
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
} from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

type Choice = { audience: WikiAudience | null; agentIds: string[] | null };

/**
 * "Quem vê" a wiki page or folder (ADR 0023 addendum): people and agents are chosen apart. Owners always read it; the
 * server refuses an audience that leaves out whoever sets it. A page's dialog can also set the page's folder.
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
      initial={{ audience: page.audience ?? null, agentIds: page.agentIds ?? null }}
      above={page.folderAudience ?? null}
      saving={action.isPending}
      extra={
        page.folder ? (
          <Button onClick={() => onFolder(page.folder)}>{t("wiki.audienceUseFolder", { folder: page.folder })}</Button>
        ) : null
      }
      onClose={onClose}
      onSave={(choice) =>
        action.mutate(
          { type: "audience", slug: page.slug, ...choice },
          {
            onSuccess: (x) => {
              toast.show(x.audience || x.agentIds ? t("wiki.audienceSaved") : t("wiki.audienceOpened"));
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
      initial={own ?? above ?? { audience: null, agentIds: null }}
      above={above}
      saving={save.isPending}
      onClose={onClose}
      onSave={(choice) =>
        save.mutate(
          { folder, ...choice },
          {
            onSuccess: () => {
              toast.show(
                choice.audience || choice.agentIds ? t("wiki.audienceFolderSaved") : t("wiki.audienceFolderOpened"),
              );
              onClose();
            },
            onError: (e) => toast.show(errorText(t, e), "error"),
          },
        )
      }
    />
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
  initial: Choice;
  /** The limited folder this sits in: here it can only be narrower. */
  above: WikiFolderAudience | null;
  saving: boolean;
  extra?: ReactNode;
  onSave: (choice: Choice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const dir = useDirectory(org.id);
  const [limited, setLimited] = useState(Boolean(initial.audience ?? above?.audience));
  const [value, setValue] = useState<WikiAudience>(
    initial.audience ?? above?.audience ?? { roleIds: [], userIds: [] },
  );
  const [agentsLimited, setAgentsLimited] = useState(Boolean(initial.agentIds ?? above?.agentIds));
  const [agentIds, setAgentIds] = useState<string[]>(initial.agentIds ?? above?.agentIds ?? []);
  const [query, setQuery] = useState("");
  const custom = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).filter(
    (r) => !above?.audience || above.audience.roleIds.includes(r.id),
  );
  const q = fold(query.trim());
  const people = dir.members.filter((m) => !q || fold(`${m.name} ${m.email}`).includes(q));
  const agents = dir.agents.filter((a) => !a.archivedAt && (!above?.agentIds || above.agentIds.includes(a.id)));
  const toggle = (key: keyof WikiAudience, id: string, on: boolean) =>
    setValue((v) => ({ ...v, [key]: on ? [...new Set([...v[key], id])] : v[key].filter((x) => x !== id) }));
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
          value={limited ? "limited" : "everyone"}
          onValueChange={(v) => setLimited(v === "limited")}
          aria-label={t("wiki.audience")}
          className="stack-4"
          style={{ gap: 8 }}
        >
          <RadioCard
            value="everyone"
            id="wiki-audience-everyone"
            checked={!limited}
            disabled={Boolean(above?.audience)}
            title={t("wiki.audienceEveryone")}
            description={t("wiki.audienceEveryoneText")}
          />
          <RadioCard
            value="limited"
            id="wiki-audience-limited"
            checked={limited}
            title={t("wiki.audienceLimited")}
            description={t("wiki.audienceLimitedText")}
          />
        </RadioGroup>
        {limited && (
          <div className="people-picker">
            <span className="ac-field__label">{t("wiki.audienceRoles")}</span>
            {custom.map((r) => (
              <label key={r.id} htmlFor={`wiki-audience-r-${r.id}`} className="scope-row">
                <Checkbox
                  id={`wiki-audience-r-${r.id}`}
                  checked={value.roleIds.includes(r.id)}
                  onCheckedChange={(on) => toggle("roleIds", r.id, on)}
                />
                <RoleMark color={r.color} icon={r.icon} size={18} />
                <span className="scope-row__text">{r.name}</span>
              </label>
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
                people.map((m) => {
                  const id = `wiki-audience-p-${m.userId.replace(/[^a-zA-Z0-9]/g, "-")}`;
                  return (
                    <label key={m.userId} htmlFor={id} className="scope-row">
                      <Checkbox
                        id={id}
                        checked={value.userIds.includes(m.userId)}
                        onCheckedChange={(on) => toggle("userIds", m.userId, on)}
                      />
                      <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                      <span className="scope-row__text">
                        <span>{m.name}</span>
                        <span className="small muted">{m.email}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}
        <span className="ac-field__label">{t("wiki.audienceAgents")}</span>
        <RadioGroup
          value={agentsLimited ? "only" : "all"}
          onValueChange={(v) => setAgentsLimited(v === "only")}
          aria-label={t("wiki.audienceAgents")}
          className="stack-4"
          style={{ gap: 8 }}
        >
          <RadioCard
            value="all"
            id="wiki-audience-agents-all"
            checked={!agentsLimited}
            disabled={Boolean(above?.agentIds)}
            title={t("wiki.audienceAgentsAll")}
            description={t("wiki.audienceAgentsAllText")}
          />
          <RadioCard
            value="only"
            id="wiki-audience-agents-only"
            checked={agentsLimited}
            title={t("wiki.audienceAgentsOnly")}
            description={t("wiki.audienceAgentsOnlyText")}
          />
        </RadioGroup>
        {agentsLimited && (
          <div className="people-picker">
            {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
            <div className="people-picker__results" role="region" aria-label={t("wiki.audienceAgents")}>
              {agents.map((a) => (
                <label key={a.id} htmlFor={`wiki-audience-a-${a.id}`} className="scope-row">
                  <Checkbox
                    id={`wiki-audience-a-${a.id}`}
                    checked={agentIds.includes(a.id)}
                    onCheckedChange={(on) =>
                      setAgentIds((ids) => (on ? [...new Set([...ids, a.id])] : ids.filter((x) => x !== a.id)))
                    }
                  />
                  <AgentAvatar agent={a} size="sm" name={a.name} />
                  <span className="scope-row__text">{a.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        {extra}
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={saving}
          onClick={() => onSave({ audience: limited ? value : null, agentIds: agentsLimited ? agentIds : null })}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
