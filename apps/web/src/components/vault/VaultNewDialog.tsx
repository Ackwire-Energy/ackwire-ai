import type { VaultAccess, VaultItem, VaultItemKind, VaultScope } from "@agenteschat/client";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  OptionList,
  Segmented,
  SettingNote,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useVaultItemActions } from "./data";
import { DEFAULT_MATCH, defaultAccess, hostOf, vaultOrigin } from "./lib";
import { AccessBlock } from "./VaultAccess";
import { cleanContact, draftErrors, type ItemDraft, ItemFields, VaultTile } from "./VaultItemDialog";
import "./vault.css";

/*
 * "New item" (ADR 0135): what to save (a login, a key, contact details), its fields, and who may use it. A personal
 * item starts usable by any of its owner's agents when the owner asks; a team one starts seen by everyone and used by
 * no agent until someone picks them.
 */

const EMPTY: ItemDraft = {
  title: "",
  description: "",
  website: "",
  match: DEFAULT_MATCH,
  username: "",
  keyName: "",
  contact: {},
};

export function VaultNewDialog({
  canManageTeam,
  scope: startScope,
  onClose,
  onCreated,
}: {
  canManageTeam: boolean;
  /** The tab it was opened from. */
  scope: VaultScope;
  onClose: () => void;
  onCreated: (item: VaultItem) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useVaultItemActions(org.id);
  const [kind, setKind] = useState<VaultItemKind>("login");
  const [draft, setDraft] = useState<ItemDraft>(EMPTY);
  const [secret, setSecret] = useState("");
  const [scope, setScope] = useState<VaultScope>(canManageTeam ? startScope : "personal");
  const [access, setAccess] = useState<VaultAccess>(() => defaultAccess(canManageTeam ? startScope : "personal"));
  const [tried, setTried] = useState(false);
  const check = () => draftErrors(t, kind, draft, secret, kind !== "contact");
  const errors = tried ? check() : {};

  const pickScope = (next: VaultScope) => {
    setScope(next);
    // Each scope's own starting access: what a team item means differs from a personal one.
    setAccess(defaultAccess(next));
  };
  const save = async () => {
    setTried(true);
    if (Object.keys(check()).length > 0) return;
    const title =
      draft.title.trim() ||
      (kind === "login" ? (hostOf(vaultOrigin(draft.website)) ?? "") : kind === "key" ? draft.keyName.trim() : "");
    const item = await actions.create({
      kind,
      scope,
      title,
      description: draft.description.trim() || undefined,
      ...(kind === "login"
        ? {
            website: vaultOrigin(draft.website) ?? draft.website.trim(),
            match: draft.match,
            username: draft.username.trim() || undefined,
            secret,
          }
        : kind === "key"
          ? { keyName: draft.keyName.trim(), secret }
          : { contact: cleanContact(draft.contact) }),
      access,
    });
    if (!item) return;
    toast.show(t("vault.new.saved"));
    onCreated(item);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.new.title")}
      description={t("vault.new.text")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        className="vlt-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DialogBody className="vlt-new">
          <OptionList<VaultItemKind>
            layout="cards"
            aria-label={t("vault.new.what")}
            value={kind}
            onValueChange={(k) => {
              setKind(k);
              setTried(false);
            }}
            options={(["login", "key", "contact"] as const).map((k) => ({
              value: k,
              leading: <VaultTile kind={k} />,
              title: t(`vault.kind.${k}`),
              description: t(`vault.kind.${k}Text`),
            }))}
          />
          <ItemFields
            kind={kind}
            draft={draft}
            onDraft={(p) => setDraft((d) => ({ ...d, ...p }))}
            readOnly={false}
            errors={errors}
            secret={
              kind === "contact" ? null : (
                <Field label={t(kind === "login" ? "vault.field.password" : "vault.field.value")} error={errors.secret}>
                  <Input
                    type="password"
                    value={secret}
                    autoComplete="new-password"
                    spellCheck={false}
                    onChange={(e) => setSecret(e.target.value)}
                    data-1p-ignore
                  />
                </Field>
              )
            }
          />
          <section className="vlt-new__who" aria-labelledby="vlt-new-who">
            <h3 id="vlt-new-who" className="vlt-new__title">
              {t("vault.new.who")}
            </h3>
            <Segmented<VaultScope>
              label={t("vault.new.who")}
              value={scope}
              disabled={!canManageTeam}
              onValueChange={pickScope}
              options={[
                { value: "personal", label: t("vault.scope.personal") },
                { value: "team", label: t("vault.scope.team") },
              ]}
            />
            {!canManageTeam && <SettingNote icon="lock">{t("vault.new.teamLocked")}</SettingNote>}
            <AccessBlock
              scope={scope}
              access={access}
              editable
              onChange={(next) => {
                setAccess(next);
                return true;
              }}
            />
          </section>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={actions.creating} disabled={actions.creating}>
            {t("vault.new.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
