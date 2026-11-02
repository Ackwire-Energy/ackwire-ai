import { keys, useChannels, useRoles } from "@agenteschat/client";
import {
  accessInput,
  accessValid,
  type ChannelAccess,
  type ChannelAccessMode,
} from "@agenteschat/client/lib/channel-access";
import { can } from "@agenteschat/client/lib/permissions";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { Button, Dialog, DialogBody, DialogFooter, Field, Input, RadioCard, RadioGroup } from "@agenteschat/ui";
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
 * "Quem pode entrar": Público, Privado or Departamentos ou papéis (ADR 0125), with the workspace's roles to tick
 * under the third. Creating a channel and its details share it.
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
  const picked = new Set(value.roleIds);
  const legend = `${idPrefix}-vis`;
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      <legend className="ac-field__label" style={{ padding: 0, marginBottom: 8 }} id={legend}>
        {t("newChannel.visibility")}
      </legend>
      <RadioGroup
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode: mode as ChannelAccessMode })}
        aria-labelledby={legend}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}
      >
        {ACCESS_MODES.map((mode) => (
          <RadioCard
            key={mode}
            value={mode}
            id={`${idPrefix}-${mode}`}
            checked={value.mode === mode}
            title={t(`newChannel.${mode}`)}
            description={t(`newChannel.${mode}Desc`)}
          />
        ))}
      </RadioGroup>
      {value.mode === "roles" && (
        // biome-ignore lint/a11y/useSemanticElements: a scroll region inside the fieldset
        <div className="people-picker__results" role="region" aria-label={t("newChannel.rolesPick")}>
          {candidates.length === 0 && roles.isSuccess ? (
            <p className="small muted">{t("newChannel.rolesNone")}</p>
          ) : (
            <RoleChecklist
              roles={candidates}
              picked={picked}
              idPrefix={idPrefix}
              onToggle={(id, on) =>
                onChange({
                  ...value,
                  roleIds: on ? [...new Set([...value.roleIds, id])] : value.roleIds.filter((r) => r !== id),
                })
              }
            />
          )}
        </div>
      )}
      {value.mode === "roles" && (
        <span className={`small ${showError && !accessValid(value) ? "ac-field__error" : "muted"}`}>
          {showError && !accessValid(value) ? t("newChannel.rolesNeeded") : t("newChannel.rolesLeave")}
        </span>
      )}
    </fieldset>
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
          />
        </DialogBody>
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
