import { keys, useChannels } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Field,
  Input,
  RadioCard,
  RadioGroup,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { CategorySelect } from "./ChannelCategoryDialogs";
import { MemberPickerRows, memberOf, type PickKey, useMemberRows } from "./MemberPicker";
import { useOrg } from "./org-context";

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

/** "Criar canal": name, topic, sidebar category, public/private and initial members (people and agents). */
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
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [categoryId, setCategoryId] = useState<string | null>(category);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName("");
    setTopic("");
    setVisibility("public");
    setCategoryId(category);
    setQ("");
    setSelected(new Set());
    setTouched(false);
  }, [open, category]);
  const rows = useMemberRows(q);
  const taken = new Set((channels.data ?? []).map((c) => c.name));
  const error = channelNameError(name, taken);
  const create = useMutation({
    mutationFn: async () => {
      const channel = await api.chat.createChannel(org.id, {
        name,
        topic: topic.trim() || undefined,
        visibility,
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
          if (!error) create.mutate();
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
          <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend className="ac-field__label" style={{ padding: 0, marginBottom: 8 }} id="ch-vis">
              {t("newChannel.visibility")}
            </legend>
            <RadioGroup
              value={visibility}
              onValueChange={setVisibility}
              aria-labelledby="ch-vis"
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
            >
              <RadioCard
                value="public"
                id="ch-public"
                checked={visibility === "public"}
                title={t("newChannel.public")}
                description={t("newChannel.publicDesc")}
              />
              <RadioCard
                value="private"
                id="ch-private"
                checked={visibility === "private"}
                title={t("newChannel.private")}
                description={t("newChannel.privateDesc")}
              />
            </RadioGroup>
          </fieldset>
          <span className="ac-field__label">{t("newChannel.members")}</span>
        </DialogBody>
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("newChannel.membersSearch")}
          searchPlaceholder={t("newChannel.membersSearch")}
          isEmpty={rows.length === 0}
          emptyText={t("newChannel.membersEmpty", { q })}
        >
          <MemberPickerRows
            rows={rows}
            selected={selected}
            onToggle={(key, on) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (on) next.add(key);
                else next.delete(key);
                return next;
              })
            }
          />
        </DialogSearchList>
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
