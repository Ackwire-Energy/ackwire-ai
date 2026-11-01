import type { WikiAudience, WikiPage } from "@agenteschat/client";
import { useRoles, useWikiAction } from "@agenteschat/client";
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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * "Quem vê" a wiki page (ADR 0023 addendum): every member, or only agents and the roles and people picked. Owners
 * and agents always read it; the server refuses an audience that leaves out whoever sets it.
 */
export function WikiAudienceDialog({ page, onClose }: { page: WikiPage; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useWikiAction(org.id);
  const roles = useRoles(org.id);
  const dir = useDirectory(org.id);
  const [limited, setLimited] = useState(Boolean(page.audience));
  const [value, setValue] = useState<WikiAudience>(page.audience ?? { roleIds: [], userIds: [] });
  const [query, setQuery] = useState("");
  const custom = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const q = fold(query.trim());
  const people = dir.members.filter((m) => !q || fold(`${m.name} ${m.email}`).includes(q));
  const toggle = (key: keyof WikiAudience, id: string, on: boolean) =>
    setValue((v) => ({ ...v, [key]: on ? [...new Set([...v[key], id])] : v[key].filter((x) => x !== id) }));
  const save = () =>
    action.mutate(
      { type: "audience", slug: page.slug, audience: limited ? value : null },
      {
        onSuccess: (x) => {
          toast.show(x.audience ? t("wiki.audienceSaved") : t("wiki.audienceOpened"));
          onClose();
        },
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.audienceTitle", { title: page.title })}
      description={t("wiki.audienceText")}
      closeLabel={t("common.close")}
      width={600}
    >
      <div className="stack-4" style={{ gap: 12 }}>
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
      </div>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={action.isPending} disabled={action.isPending} onClick={save}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
