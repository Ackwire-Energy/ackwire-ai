import { keys, type Me, useApi } from "@agenteschat/client";
import { authErrorText, errorText } from "@agenteschat/client/lib/errors";
import { WORK_AREAS, type WorkArea, type WorkAreaAnswer } from "@agenteschat/client/lib/work-area";
import { Avatar, Button, Field, Icon, type IconName, Input, Locked, recipeOfUrl } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuthResult } from "@/auth/client";
import { useAuth } from "@/auth/context";
import { AvatarBuilderDialog } from "@/components/AvatarBuilder";
import { useOrg } from "@/components/org-context";
import { ProfilePhotoDialog } from "@/components/ProfilePhoto";

const isArea = (v: string | null | undefined): v is WorkArea => (WORK_AREAS as readonly string[]).includes(v ?? "");

/** A name the account refused (too long, empty after trimming on the server). */
class NameRefused extends Error {
  constructor(readonly result: Extract<AuthResult, { ok: false }>) {
    super(result.code);
  }
}

/**
 * "Agora, sobre você" (ADR 0162, amended 2026-11-12): the person, before the team. Their face large with its two ways
 * in, as Trocar foto offers them (the avatar builder, or a photo of theirs), each saved by its own dialog; their name
 * as the account has it, to write properly; and their own area, optional, one chip at a time. Continuar saves the name
 * (a name refused stays on the step, said under the field) and the area, an area left unpicked as `skipped`; the area's
 * save never holds the onboarding. Once per account: a person who answered it before finds it answered.
 */
export function YouStep({ me, onDone }: { me: Me; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const saved = me.user.workArea ?? null;
  const [name, setName] = useState(me.user.name);
  const [area, setArea] = useState<WorkArea | null>(isArea(saved) ? saved : null);
  const [building, setBuilding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const image = me.user.image ?? null;
  // A drawn portrait is edited where it was made; anything else (initials, a photo) starts one.
  const drawn = recipeOfUrl(image) !== null;
  // The photo and the name go everywhere the account shows: the rail's corner and the preview read `/me`.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.members(org.id) });
    void qc.invalidateQueries({ queryKey: keys.people(org.id) });
  };
  const go = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const typed = name.trim();
      if (typed !== me.user.name) {
        const result = await auth.updateName(typed);
        if (!result.ok) throw new NameRefused(result);
      }
      // Left unpicked, it was asked: never again on another workspace.
      const answer: WorkAreaAnswer = area ?? "skipped";
      if (answer !== saved) await api.account.setWorkArea(answer).catch(() => undefined);
      const now = qc.getQueryData<Me>(keys.me);
      // Kept as answered here: a save that failed asks again on another visit, never now.
      if (now) qc.setQueryData<Me>(keys.me, { ...now, user: { ...now.user, name: typed, workArea: answer } });
      void qc.invalidateQueries({ queryKey: keys.members(org.id) });
      void qc.invalidateQueries({ queryKey: keys.people(org.id) });
    },
    onSuccess: onDone,
    onError: (e) => setRefused(e instanceof NameRefused ? authErrorText(t, e.result) : errorText(t, e)),
  });
  const areaLabel = t("onboarding.flow.you.area");
  return (
    <>
      <Locked when={go.isPending}>
        <div className="onb__answer">
          <div className="onb-you">
            <Avatar
              kind="person"
              name={name.trim() || me.user.name}
              imageUrl={image ?? undefined}
              className="onb-you__face"
            />
            <div className="onb-you__side">
              <span className="ac-field__label ac-captop">{t("onboarding.flow.you.photo")}</span>
              <span className="onb-you__acts">
                <Button icon="smile" onClick={() => setBuilding(true)}>
                  {t(drawn ? "onboarding.flow.you.edit" : "onboarding.flow.you.build")}
                </Button>
                <Button icon="image" onClick={() => setUploading(true)}>
                  {t("onboarding.flow.you.upload")}
                </Button>
              </span>
            </div>
          </div>
          <Field label={t("auth.yourName")} id="onb-you-name" error={refused ?? undefined}>
            <Input
              className="onb__big"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setRefused(null);
              }}
              autoComplete="name"
              spellCheck={false}
              autoFocus
            />
          </Field>
        </div>
        <div className="onb__answer">
          <Field
            label={areaLabel}
            group
            hint={{ name: t("common.about", { label: areaLabel }), text: t("onboarding.flow.you.areaHint") }}
          >
            <div className="tp-chips__row">
              {WORK_AREAS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className="tp-chip"
                  aria-pressed={a === area}
                  // One at a time; pressed again, none: it is optional.
                  onClick={() => setArea(a === area ? null : a)}
                >
                  <Icon name={AREA_ICONS[a]} size={14} />
                  <span>{t(`onboarding.flow.area.options.${a}`)}</span>
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Locked>
      <div className="onb__actions">
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={!name.trim()}
          loading={go.isPending}
          onClick={() => go.mutate()}
        >
          {t("onboarding.actions.continue")}
        </Button>
      </div>
      <AvatarBuilderDialog
        open={building}
        onClose={() => {
          setBuilding(false);
          refresh();
        }}
        onUploadPhoto={() => {
          setBuilding(false);
          setUploading(true);
        }}
      />
      <ProfilePhotoDialog
        open={uploading}
        onClose={() => {
          setUploading(false);
          refresh();
        }}
      />
    </>
  );
}

/** Each area's chip leads with its icon, chosen or not (the chip darkens when chosen). */
const AREA_ICONS: Record<WorkArea, IconName> = {
  dev: "code",
  marketing: "bulb",
  sales: "chart",
  finance: "wallet",
  ops: "cog",
  support: "message",
  other: "more",
};
