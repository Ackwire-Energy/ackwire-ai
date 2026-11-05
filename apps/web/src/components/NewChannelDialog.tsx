import { keys, type OrgRole, useChannels, useRoles } from "@agenteschat/client";
import {
  accessInput,
  accessValid,
  type ChannelAccess,
  type ChannelAccessMode,
} from "@agenteschat/client/lib/channel-access";
import { can } from "@agenteschat/client/lib/permissions";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Locked,
  RoleMark,
  Select,
  Token,
  TokenList,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { CategorySelect } from "./ChannelCategoryDialogs";
import { memberOf, PeoplePicker, type PickKey } from "./MemberPicker";
import { useOrg } from "./org-context";
import { RoleChecklist } from "./roles/RoleChecklist";

const ACCESS_MODES: ChannelAccessMode[] = ["public", "private", "roles"];

/**
 * "Quem pode entrar": Público, Privado or Departamentos ou papéis (ADR 0125). The third shows the roles picked, each
 * removable, and "Escolher papéis", which ticks them in a dialog of their own (it opens by itself while none is
 * picked). Creating a channel and its details share it.
 */
export function ChannelAccessChoice({
  value,
  onChange,
  idPrefix,
  showError,
}: {
  value: ChannelAccess;
  onChange: (next: ChannelAccess) => void;
  idPrefix: string;
  /** Say that a role is missing (after a try to save). */
  showError?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const candidates = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const [choosing, setChoosing] = useState(false);
  const pickedRoles = candidates.filter((r) => value.roleIds.includes(r.id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* A dropdown, as "Categoria" above it: three cards side by side broke their words in a narrow dialog. */}
      <Field label={t("newChannel.visibility")} id={`${idPrefix}-vis`} help={t(`newChannel.${value.mode}Desc`)}>
        <Select
          value={value.mode}
          onValueChange={(mode) => {
            onChange({ ...value, mode });
            if (mode === "roles" && value.roleIds.length === 0) setChoosing(true);
          }}
          options={ACCESS_MODES.map((mode) => ({
            value: mode,
            label: t(`newChannel.${mode}`),
            description: t(`newChannel.${mode}Desc`),
          }))}
        />
      </Field>
      {value.mode === "roles" && pickedRoles.length > 0 && (
        <TokenList label={t("newChannel.rolesPick")}>
          {pickedRoles.map((r) => (
            <li key={r.id}>
              <Token
                leading={<RoleMark color={r.color} icon={r.icon} size={18} />}
                removeLabel={t("common.removeName", { name: r.name })}
                onRemove={() => onChange({ ...value, roleIds: value.roleIds.filter((id) => id !== r.id) })}
              >
                {r.name}
              </Token>
            </li>
          ))}
        </TokenList>
      )}
      {value.mode === "roles" && (
        <span>
          <Button
            size="sm"
            variant="ghost"
            icon={pickedRoles.length > 0 ? "edit" : "plus"}
            onClick={() => setChoosing(true)}
          >
            {pickedRoles.length > 0 ? t("newChannel.rolesChange") : t("newChannel.rolesChoose")}
          </Button>
        </span>
      )}
      {value.mode === "roles" && (
        <span className={`small ${showError && !accessValid(value) ? "ac-field__error" : "muted"}`}>
          {showError && !accessValid(value) ? t("newChannel.rolesNeeded") : t("newChannel.rolesLeave")}
        </span>
      )}
      {choosing && (
        <ChannelRolesDialog
          roles={candidates}
          loaded={roles.isSuccess}
          initial={value.roleIds}
          idPrefix={idPrefix}
          onPick={(roleIds) => onChange({ ...value, mode: "roles", roleIds })}
          onClose={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

/** The roles a channel opens to, ticked in a dialog of their own: "Pronto" puts them on the field. */
function ChannelRolesDialog({
  roles,
  loaded,
  initial,
  idPrefix,
  onPick,
  onClose,
}: {
  roles: readonly OrgRole[];
  loaded: boolean;
  initial: readonly string[];
  idPrefix: string;
  onPick: (roleIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(initial));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("newChannel.rolesPick")}
      description={t("newChannel.rolesDesc")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
        <div className="people-picker__results" role="region" aria-label={t("newChannel.rolesPick")}>
          {roles.length === 0 && loaded ? (
            <p className="small muted">{t("newChannel.rolesNone")}</p>
          ) : (
            <RoleChecklist
              roles={roles}
              picked={draft}
              idPrefix={`${idPrefix}-pick`}
              onToggle={(id, on) =>
                setDraft((d) => {
                  const next = new Set(d);
                  if (on) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
            />
          )}
        </div>
        <span className="small muted">{t("newChannel.rolesLeave")}</span>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          onClick={() => {
            onPick([...draft]);
            onClose();
          }}
        >
          {t("newChannel.rolesDone")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Same rule as the backend (CHANNEL_NAME_PATTERN): lower case, digits, - or _. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** What people type → a channel name ("Marketing Brasil" → "marketing-brasil"). */
export const toChannelName = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);

export function channelNameError(name: string, taken: Set<string>): "invalid" | "taken" | null {
  if (!CHANNEL_NAME.test(name)) return "invalid";
  if (taken.has(name)) return "taken";
  return null;
}

/**
 * "Criar canal", in one column: name, topic, sidebar category, who can join, then the initial members (people and
 * agents: search and a list that scrolls in its own box). The footer, with the count and Criar, stays in view.
 */
export function NewChannelDialog({
  open,
  onOpenChange,
  category = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened from a category's +: it starts chosen. */
  category?: string | null;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [access, setAccess] = useState<ChannelAccess>({ mode: "public", roleIds: [] });
  const [categoryId, setCategoryId] = useState<string | null>(category);
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName("");
    setTopic("");
    setAccess({ mode: "public", roleIds: [] });
    setCategoryId(category);
    setSelected(new Set());
    setTouched(false);
  }, [open, category]);
  const taken = new Set((channels.data ?? []).map((c) => c.name));
  const error = channelNameError(name, taken);
  const create = useMutation({
    mutationFn: async () => {
      const channel = await api.chat.createChannel(org.id, {
        name,
        topic: topic.trim() || undefined,
        ...accessInput(access),
        ...(categoryId ? { categoryId } : {}),
      });
      for (const key of selected) await api.chat.addMember(org.id, channel.id, memberOf(key));
      return channel;
    },
    onSuccess: async (channel) => {
      await qc.invalidateQueries({ queryKey: keys.channels(org.id) });
      void qc.invalidateQueries({ queryKey: keys.channelCategories(org.id) });
      onOpenChange(false);
      await navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: channel.id } });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("newChannel.title")} closeLabel={t("common.close")}>
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!error && accessValid(access)) create.mutate();
        }}
      >
        <Locked when={create.isPending}>
          <DialogBody>
            <Field
              label={t("newChannel.name")}
              id="ch-name"
              help={t("newChannel.nameHelp", { name: name || "canal" })}
              error={
                touched || (name && error === "taken")
                  ? error === "invalid"
                    ? t("newChannel.nameInvalid")
                    : error === "taken"
                      ? t("newChannel.nameTaken", { name })
                      : undefined
                  : undefined
              }
            >
              <Input
                value={name}
                onChange={(e) => setName(toChannelName(e.target.value))}
                placeholder={t("newChannel.namePlaceholder")}
                autoFocus
              />
            </Field>
            <Field label={t("newChannel.topic")} id="ch-topic">
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("newChannel.topicPlaceholder")}
              />
            </Field>
            <Field label={t("channelCategories.category")} id="ch-category" help={t("channelCategories.categoryHelp")}>
              <CategorySelect value={categoryId} onChange={setCategoryId} canCreate={can(org, "manage_channels")} />
            </Field>
            <ChannelAccessChoice value={access} onChange={setAccess} idPrefix="ch" showError={touched} />
            <PeoplePicker
              label={t("newChannel.members")}
              searchLabel={t("newChannel.membersSearch")}
              emptyText={(q) => t("newChannel.membersEmpty", { q })}
              selected={selected}
              onChange={setSelected}
              channel
            />
          </DialogBody>
        </Locked>
        <DialogFooter bar note={t("newChannel.selected", { count: selected.size })}>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={create.isPending} loading={create.isPending}>
            {t("newChannel.create", { name: name || "canal" })}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
