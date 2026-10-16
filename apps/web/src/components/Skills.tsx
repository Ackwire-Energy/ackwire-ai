import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Field,
  Icon,
  type IconName,
  Input,
  List,
  SearchInput,
  Sheet,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentSkills, useSkill, useSkillAction, useSkills, useSkillUsage } from "@/api/queries";
import type { Skill, SkillDetail, SkillFile } from "@/api/types";
import { EditDialog } from "@/components/EditDialog";
import { LoadingList, useStepText } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { joinNames, relativeTime } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { can } from "@/lib/permissions";
import { useToast } from "@/lib/toast";

/** How many skills the settings card lists before "Ver todas" (the search dialog). */
const INLINE = 6;

const SOURCE_ICON: Record<Skill["source"], IconName> = {
  url: "link",
  upload: "attach",
  manual: "edit",
};

/** "GitHub" for github.com links, "Link" for other URLs, "Enviada", "Criada aqui". */
const sourceKey = (s: Pick<Skill, "source" | "sourceUrl">) =>
  s.source === "url" ? (/github\.com/i.test(s.sourceUrl ?? "") ? "github" : "url") : s.source;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function searchSkills(skills: Skill[], query: string) {
  const q = fold(query.trim());
  return q ? skills.filter((s) => fold(`${s.name} ${s.description}`).includes(q)) : skills;
}

/** A .zip as base64 (writes are JSON only). */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function SourceChip({ skill }: { skill: Skill }) {
  const { t } = useTranslation();
  return <Chip icon={SOURCE_ICON[skill.source] ?? "document"}>{t(`skills.source.${sourceKey(skill)}`)}</Chip>;
}

function SkillRow({ skill, users, onOpen }: { skill: Skill; users: number | null; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ac-list__row skill-row">
      <span className="list-col" style={{ flex: "1 1 240px" }}>
        <button type="button" className="skill-row__name" onClick={onOpen}>
          {skill.name}
        </button>
        <span className="small muted">{skill.description}</span>
      </span>
      <SourceChip skill={skill} />
      {skill.defaultForNewAgents && <Chip icon="check">{t("skills.defaultChip")}</Chip>}
      <span className="small muted tabular">
        {t("skills.version", { version: skill.version })}
        {users !== null && <> · {t("skills.usedBy", { count: users })}</>}
      </span>
    </div>
  );
}

/** Configurações → Skills: the org library (admins manage it). */
export function SkillsSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org.role, "configure");
  const skills = useSkills(org.id, admin);
  const [installing, setInstalling] = useState(false);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = skills.data ?? [];
  const usage = useSkillUsage(org.id, admin && list.length > 0);
  if (!admin) return null;
  const unavailable = skills.isError && (skills.error as { status?: number }).status === 404;
  return (
    <Card aria-labelledby="sec-skills">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-4" style={{ flex: "1 1 280px", gap: 2 }}>
          <h2 id="sec-skills" className="ac-card__title">
            {t("skills.title")}
          </h2>
          <span className="small muted">{t("skills.subtitle")}</span>
        </div>
        {!unavailable && (
          <Button size="sm" icon="plus" onClick={() => setInstalling(true)}>
            {t("skills.install")}
          </Button>
        )}
      </div>
      {unavailable && <p className="small muted">{t("skills.unavailable")}</p>}
      {skills.isLoading && <LoadingList count={3} avatar={false} trailing />}
      {skills.isSuccess && list.length === 0 && <p className="small muted">{t("skills.empty")}</p>}
      {list.length > 0 && (
        <List aria-label={t("skills.title")}>
          {list.slice(0, INLINE).map((s) => (
            <SkillRow key={s.id} skill={s} users={usage.get(s.id)?.length ?? 0} onOpen={() => setOpen(s.id)} />
          ))}
        </List>
      )}
      {list.length > INLINE && (
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t("skills.seeAll", { count: list.length })}
          </Button>
        </div>
      )}
      <Dialog open={all} onOpenChange={setAll} title={t("skills.title")} closeLabel={t("common.close")}>
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("skills.search")}
          searchPlaceholder={t("skills.search")}
          isEmpty={searchSkills(list, q).length === 0}
          emptyText={t("skills.noResults", { q })}
        >
          {searchSkills(list, q).map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              users={usage.get(s.id)?.length ?? 0}
              onOpen={() => {
                setAll(false);
                setOpen(s.id);
              }}
            />
          ))}
        </DialogSearchList>
        <DialogFooter />
      </Dialog>
      <InstallSkillDialog open={installing} onOpenChange={setInstalling} onInstalled={(id) => setOpen(id)} />
      {open && <SkillSheet id={open} users={usage.get(open) ?? []} onClose={() => setOpen(null)} />}
    </Card>
  );
}

type InstallTab = "github" | "zip" | "write";

export function InstallSkillDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id);
  const installStep = useStepText(action.isPending, [
    t("skills.installStep.fetching"),
    t("skills.installStep.reading"),
    t("skills.installStep.saving"),
  ]);
  const [tab, setTab] = useState<InstallTab>("github");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setFile(null);
    setForm({ name: "", description: "", body: "" });
    setError(null);
  }, [open]);
  const githubOk = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url.trim());
  const writeOk = form.name.trim() && form.description.trim() && form.body.trim();
  const done = (skill: unknown) => {
    const s = skill as SkillDetail;
    toast.show(t("skills.installed", { name: s.name }));
    onOpenChange(false);
    onInstalled(s.id);
  };
  const submit = async () => {
    setError(null);
    const onError = (e: Error) => setError(e.message || t("common.unknownError"));
    if (tab === "github") {
      if (!githubOk) return setError(t("skills.githubInvalid"));
      action.mutate({ type: "import", input: { url: url.trim() } }, { onSuccess: done, onError });
    } else if (tab === "zip") {
      if (!file) return setError(t("skills.zipMissing"));
      const zipBase64 = await fileToBase64(file);
      action.mutate({ type: "import", input: { zipBase64 } }, { onSuccess: done, onError });
    } else {
      if (!writeOk) return setError(t("skills.writeMissing"));
      action.mutate(
        {
          type: "create",
          input: { name: form.name.trim(), description: form.description.trim(), body: form.body },
        },
        { onSuccess: done, onError },
      );
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("skills.install")} closeLabel={t("common.close")}>
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogBody>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v);
              setError(null);
            }}
            label={t("skills.installHow")}
            items={[
              { value: "github", label: t("skills.tab.github") },
              { value: "zip", label: t("skills.tab.zip") },
              { value: "write", label: t("skills.tab.write") },
            ]}
          >
            <TabPanel value="github">
              <Field label={t("skills.githubUrl")} id="skill-url" help={t("skills.githubHelp")}>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/…"
                  inputMode="url"
                />
              </Field>
            </TabPanel>
            <TabPanel value="zip">
              <span className="small muted">{t("skills.zipHelp")}</span>
              {/* Our button over a hidden file input: never the native control look. */}
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                className="ac-visually-hidden"
                aria-label={t("skills.zipPick")}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <Button type="button" icon="attach" onClick={() => fileInput.current?.click()}>
                  {t("skills.zipPick")}
                </Button>
                <span className="small muted">{file ? file.name : t("skills.zipNone")}</span>
              </div>
            </TabPanel>
            <TabPanel value="write">
              <Field label={t("skills.name")} id="skill-name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={t("skills.description")} id="skill-desc" help={t("skills.descriptionHelp")}>
                <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <Field label={t("skills.body")} id="skill-body" help={t("skills.bodyHelp")}>
                <Textarea rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
              </Field>
            </TabPanel>
          </Tabs>
          {error && <Alert>{error}</Alert>}
        </DialogBody>
        <DialogFooter note={installStep}>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending} loading={action.isPending}>
            {t("skills.installSubmit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Skill detail: rendered SKILL.md, its files (text opens in a viewer; scripts need a sandbox), actions. */
export function SkillSheet({
  id,
  users,
  onClose,
}: {
  id: string;
  /** Agents that use it (named in the removal confirmation). */
  users: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const skill = useSkill(org.id, id);
  const action = useSkillAction(org.id);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const s = skill.data;
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("common.close")}
      title={s?.name ?? t("common.loading")}
      icon={<Icon name="document" />}
      subtitle={
        s
          ? [
              t(`skills.source.${sourceKey(s)}`),
              t("skills.version", { version: s.version }),
              t("skills.updated", { when: relativeTime(t, i18n.language, s.updatedAt) }),
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      actions={
        s && (
          <>
            {s.source === "url" && s.sourceUrl && (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.isPending}
                loading={action.isPending && action.variables?.type === "reimport"}
                onClick={() =>
                  action.mutate(
                    { type: "reimport", id: s.id },
                    { onSuccess: () => toast.show(t("skills.refreshed", { name: s.name })) },
                  )
                }
              >
                {t("skills.refresh")}
              </Button>
            )}
            {!editing && (
              <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>
                {t("skills.edit")}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="ac-btn--danger" onClick={() => setRemoving(true)}>
              {t("skills.remove")}
            </Button>
          </>
        )
      }
    >
      {s && (
        <div className="skill-sheet">
          <div className="skill-sheet__main">
            <p className="muted">{s.description}</p>
            {editing ? <EditSkill skill={s} onDone={() => setEditing(false)} /> : <Markdown source={s.body} />}
          </div>
          <nav className="skill-sheet__files" aria-label={t("skills.files")}>
            <h3 className="ac-eyebrow">{t("skills.files")}</h3>
            <ul>
              {s.files.map((f) => (
                <li key={f.path}>
                  <FileEntry file={f} />
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}
      {s && (
        <Dialog
          open={removing}
          onOpenChange={setRemoving}
          title={t("skills.removeTitle", { name: s.name })}
          description={
            users.length > 0
              ? t("skills.removeAgents", {
                  count: users.length,
                  names: joinNames(
                    users.map((a) => a.name),
                    t("newAgent.and"),
                  ),
                })
              : t("skills.removeNone")
          }
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              disabled={action.isPending}
              loading={action.isPending && action.variables?.type === "remove"}
              onClick={() =>
                action.mutate(
                  { type: "remove", id: s.id },
                  {
                    onSuccess: () => {
                      toast.show(t("skills.removed", { name: s.name }));
                      onClose();
                    },
                  },
                )
              }
            >
              {t("skills.remove")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </Sheet>
  );
}

/** A file of the skill. Scripts run on the agent's PC; old imports kept them as `ignored` (reinstall). */
function FileEntry({ file }: { file: SkillFile }) {
  const { t } = useTranslation();
  return (
    <span className="skill-file" data-status={file.status}>
      <code>{file.path}</code>
      {file.status === "script" ? (
        <Chip icon="code">{t("skills.runsOnPc")}</Chip>
      ) : file.status === "ignored" ? (
        <>
          <Chip icon="block">{t("skills.needsSandbox")}</Chip>
          <span className="small muted">{t("skills.reinstall")}</span>
        </>
      ) : (
        <span className="small muted">{file.mime}</span>
      )}
    </span>
  );
}

function EditSkill({ skill, onDone }: { skill: SkillDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useSkillAction(org.id);
  const [form, setForm] = useState({
    description: skill.description,
    body: skill.body,
    defaultForNewAgents: skill.defaultForNewAgents,
  });
  return (
    <form
      className="stack-4"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        action.mutate(
          { type: "update", id: skill.id, patch: form },
          {
            onSuccess: () => {
              toast.show(t("skills.saved", { name: skill.name }));
              onDone();
            },
          },
        );
      }}
    >
      {skill.source === "url" && <Alert tone="neutral">{t("skills.editLinkNote")}</Alert>}
      <Field label={t("skills.description")} id="edit-skill-desc">
        <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <Field label={t("skills.body")} id="edit-skill-body" help={t("skills.newVersion")}>
        <Textarea rows={14} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      </Field>
      <span className="row" style={{ gap: 10, alignItems: "center" }}>
        <Switch
          id="edit-skill-default"
          checked={form.defaultForNewAgents}
          onCheckedChange={(on) => setForm({ ...form, defaultForNewAgents: on })}
        />
        <label htmlFor="edit-skill-default">{t("skills.defaultForNew")}</label>
      </span>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!form.description.trim() || action.isPending}
          loading={action.isPending}
        >
          {t("skills.save")}
        </Button>
      </div>
    </form>
  );
}

/** Our checkboxes over the library, with search (the agent profile's dialog). */
export function SkillPicker({
  skills,
  selected,
  onChange,
}: {
  skills: Skill[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const shown = searchSkills(skills, q);
  return (
    <div className="stack-4" style={{ gap: 8 }}>
      <SearchInput
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("skills.search")}
        aria-label={t("skills.search")}
      />
      <span className="small muted tabular" role="status">
        {t("skills.selected", { count: selected.size, total: skills.length })}
      </span>
      {shown.length === 0 && <p className="small muted">{t("skills.noResults", { q })}</p>}
      <div className="skill-picker">
        {shown.map((s) => {
          const id = `skill-pick-${s.id}`;
          return (
            <label key={s.id} htmlFor={id} className="scope-row">
              <Checkbox
                id={id}
                checked={selected.has(s.id)}
                onCheckedChange={(on) => {
                  const next = new Set(selected);
                  if (on) next.add(s.id);
                  else next.delete(s.id);
                  onChange(next);
                }}
              />
              <span className="scope-row__text">
                <span>{s.name}</span>
                <span className="small muted">{s.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Agent profile → Skills → "Gerenciar skills": our checkboxes over the library, saved explicitly. */
export function ManageSkillsDialog({
  agentId,
  agentName,
  open,
  onClose,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const skills = useAgentSkills(org.id, agentId);
  const action = useSkillAction(org.id);
  const list = skills.data ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState("");
  useEffect(() => {
    if (!open || !skills.data) return;
    const on = skills.data.filter((s) => s.enabled).map((s) => s.id);
    setPicked(new Set(on));
    setInitial([...on].sort().join(","));
  }, [open, skills.data]);
  const dirty = [...picked].sort().join(",") !== initial;
  return (
    <EditDialog
      open={open}
      onClose={onClose}
      title={t("skills.manageTitle", { name: agentName })}
      dirty={dirty}
      saving={action.isPending}
      onSave={() =>
        action.mutate(
          { type: "assign", agentId, skills: list.map((s) => ({ skillId: s.id, enabled: picked.has(s.id) })) },
          {
            onSuccess: () => {
              toast.show(t("skills.assigned", { name: agentName }));
              onClose();
            },
          },
        )
      }
    >
      {list.length === 0 ? (
        <p className="small muted">{t("skills.empty")}</p>
      ) : (
        <SkillPicker skills={list} selected={picked} onChange={setPicked} />
      )}
    </EditDialog>
  );
}
