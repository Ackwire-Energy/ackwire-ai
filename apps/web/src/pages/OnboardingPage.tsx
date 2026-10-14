import {
  AffixInput,
  Avatar,
  Button,
  Card,
  Field,
  Input,
  OptionCard,
  RadioCard,
  RadioGroup,
  Select,
  Steps,
  Textarea,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import type { Role } from "@/api/types";
import { CenteredLayout } from "@/components/AuthLayout";
import { handleFrom, isEmail, slugify } from "@/lib/text";
import { useToast } from "@/lib/toast";

export const PRESETS = ["theo", "ada", "lia", "atlas"] as const;
export type Preset = (typeof PRESETS)[number];

/** Instructions each onboarding preset starts with (same as the roles of "Criar agente"). */
const PRESET_ROLE: Record<Preset, "pm" | "dev" | "ops" | null> = { theo: "pm", ada: "dev", lia: null, atlas: "ops" };
const FEMININE: Record<Preset, boolean> = { theo: false, ada: true, lia: true, atlas: false };

export interface InviteDraft {
  email: string;
  role: Role;
}

/** Label of the last step's primary button. */
export function finishLabel(t: TFunction, invites: number, orgName: string) {
  return invites > 0
    ? t("onboarding.finishWithInvites", { count: invites })
    : t("onboarding.finishNoInvites", { org: orgName });
}

/** Adds an invite draft if the email is valid and new. Returns null when nothing changes. */
export function addInvite(list: InviteDraft[], email: string, role: Role): InviteDraft[] | null {
  const clean = email.trim().toLowerCase();
  if (!isEmail(clean) || list.some((i) => i.email === clean)) return null;
  return [...list, { email: clean, role }];
}

/** telas/Onboarding.dc.html — 4 steps: organization, context, first agent, invitations. */
export function OnboardingPage() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const [step, setStep] = useState(1);
  const [org, setOrg] = useState("");
  const [size, setSize] = useState("small");
  const [context, setContext] = useState("");
  const [preset, setPreset] = useState<Preset>("theo");
  const [key, setKey] = useState<"platform" | "own">("platform");
  const [apiKey, setApiKey] = useState("");
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [draft, setDraft] = useState("");
  const [draftRole, setDraftRole] = useState<Role>("member");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  const [agentCreated, setAgentCreated] = useState(false);
  const [platform, setPlatform] = useState(true);

  const orgName = org.trim() || t("onboarding.yourCompany");
  const presetInfo = (p: Preset) => ({
    name: t(`onboarding.presets.${p}.name`),
    role: t(`onboarding.presets.${p}.role`),
    desc: t(`onboarding.presets.${p}.desc`),
  });
  const chosen = presetInfo(preset);
  const NAMES = [
    t("onboarding.stepNames.org"),
    t("onboarding.stepNames.context"),
    t("onboarding.stepNames.agent"),
    t("onboarding.stepNames.invites"),
  ];

  const saveOrg = useMutation({
    mutationFn: async () => {
      if (created) {
        await api.orgs.updateSettings(created.orgId, { name: org.trim(), context });
        return created;
      }
      const res = await api.orgs.create({ name: org.trim(), context });
      const next = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
      setCreated(next);
      // The platform key is only offered where the server has one (Cloud).
      const available = await api.agents.platformKeyAvailable(next.orgId).catch(() => false);
      setPlatform(available);
      if (!available) setKey("own");
      await qc.invalidateQueries({ queryKey: keys.me });
      return next;
    },
  });

  const saveAgent = useMutation({
    mutationFn: async () => {
      if (!created || agentCreated) return;
      let credentialId: string | null = null;
      if (key === "own") {
        const cred = await api.agents.addCredential(created.orgId, {
          provider: "anthropic",
          label: "Anthropic",
          apiKey: apiKey.trim(),
        });
        credentialId = cred.id;
      }
      const role = PRESET_ROLE[preset];
      const agent = await api.agents.create(created.orgId, {
        name: chosen.name,
        handle: handleFrom(chosen.name),
        role: chosen.role,
        instructions: role ? t(`newAgent.roles.${role}.instructions`) : chosen.desc,
        credentialId,
      });
      await api.chat.addMember(created.orgId, created.generalChannelId, { agentId: agent.id });
      setAgentCreated(true);
    },
  });

  const finish = useMutation({
    mutationFn: async (send: boolean) => {
      if (!created) return;
      if (send) {
        for (const invite of invites) await api.orgs.invite(created.orgId, invite);
      }
      await qc.invalidateQueries({ queryKey: keys.me });
      await navigate({
        to: "/org/$orgId/c/$channelId",
        params: { orgId: created.orgId, channelId: created.generalChannelId },
      });
    },
  });

  const next = async () => {
    if (step === 2) await saveOrg.mutateAsync();
    if (step === 3) await saveAgent.mutateAsync();
    setStep((s) => Math.min(4, s + 1));
  };

  const add = () => {
    const list = addInvite(invites, draft, draftRole);
    if (!list) {
      if (draft.trim()) setDraftError(t("onboarding.invalidEmail"));
      return;
    }
    setInvites(list);
    setDraft("");
    setDraftError(null);
  };

  const copyLink = async () => {
    if (!created) return;
    const link = await api.invites.createLink(created.orgId);
    try {
      await navigator.clipboard.writeText(link.url);
    } catch {
      toast.show(link.url);
    }
    setCopied(true);
  };

  const busy = saveOrg.isPending || saveAgent.isPending || finish.isPending;
  const blocked = (step === 1 && !org.trim()) || (step === 3 && key === "own" && apiKey.trim().length < 8);
  const roleOptions = [
    { value: "member" as Role, label: t("roles.member"), description: t("roles.memberDesc") },
    { value: "admin" as Role, label: t("roles.admin"), description: t("roles.adminDesc") },
  ];

  return (
    <CenteredLayout>
      <Card padded as="div">
        <Steps current={step} total={4} label={t("onboarding.step", { n: step, name: NAMES[step - 1] })} />

        {step === 1 && (
          <>
            <div className="stack-4">
              <h1 className="page-title">{t("onboarding.orgTitle")}</h1>
              <p className="page-sub">{t("onboarding.orgSubtitle")}</p>
            </div>
            <Field label={t("onboarding.orgName")} id="org-name">
              <Input
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                placeholder={t("onboarding.orgNamePlaceholder")}
                autoFocus
              />
            </Field>
            <Field label={t("onboarding.address")} id="org-slug">
              <AffixInput prefix="agentes.chat/" value={slugify(org) || "seu-time"} readOnly />
            </Field>
            <Field label={t("onboarding.teamSize")} id="org-size">
              <Select
                value={size}
                onValueChange={setSize}
                options={[
                  { value: "solo", label: t("onboarding.sizes.solo") },
                  { value: "small", label: t("onboarding.sizes.small") },
                  { value: "medium", label: t("onboarding.sizes.medium") },
                  { value: "large", label: t("onboarding.sizes.large") },
                ]}
              />
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <div className="stack-4">
              <h1 className="page-title">{t("onboarding.contextTitle", { org: orgName })}</h1>
              <p className="page-sub">{t("onboarding.contextSubtitle")}</p>
            </div>
            <Field label={t("onboarding.contextLabel")} id="org-ctx" help={t("onboarding.contextHelp")}>
              <Textarea
                rows={7}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={t("onboarding.contextExample", { org: orgName })}
              />
            </Field>
          </>
        )}

        {step === 3 && (
          <>
            <div className="stack-4">
              <h1 className="page-title">{t("onboarding.agentTitle")}</h1>
              <p className="page-sub">{t("onboarding.agentSubtitle")}</p>
            </div>
            <div className="grid-options">
              {PRESETS.map((p) => {
                const info = presetInfo(p);
                return (
                  <OptionCard key={p} pressed={preset === p} onClick={() => setPreset(p)}>
                    <Avatar kind="agent" name={info.name} initials={p === "atlas" ? "At" : undefined} />
                    <span className="ac-option__text">
                      <span className="ac-option__title">
                        {info.name} · {info.role}
                      </span>
                      <span className="ac-option__desc">{info.desc}</span>
                    </span>
                  </OptionCard>
                );
              })}
            </div>
            <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <legend className="ac-field__label" style={{ padding: 0, marginBottom: 8 }} id="key-legend">
                {t("onboarding.keyQuestion")}
              </legend>
              <RadioGroup
                value={key}
                onValueChange={setKey}
                aria-labelledby="key-legend"
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                {platform && (
                  <RadioCard
                    value="platform"
                    id="key-platform"
                    checked={key === "platform"}
                    title={t("onboarding.platformKey")}
                    description={t("onboarding.platformKeyDesc")}
                  />
                )}
                <RadioCard
                  value="own"
                  id="key-own"
                  checked={key === "own"}
                  title={t("onboarding.ownKey", { org: orgName })}
                  description={t("onboarding.ownKeyDesc")}
                />
              </RadioGroup>
              {key === "own" && (
                <Field label={t("onboarding.apiKey")} id="key-value">
                  <Input
                    type="password"
                    placeholder="sk-ant-…"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </Field>
              )}
            </fieldset>
          </>
        )}

        {step === 4 && (
          <>
            <div className="stack-4">
              <h1 className="page-title">{t("onboarding.invitesTitle")}</h1>
              <p className="page-sub">
                {t("onboarding.invitesSubtitle", {
                  agent: chosen.name,
                  channel: "general",
                  pronoun: FEMININE[preset] ? t("onboarding.pronounShe") : t("onboarding.pronounHe"),
                })}
              </p>
            </div>
            {invites.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {invites.map((i) => (
                  <div key={i.email} className="invite-row">
                    <Avatar name={i.email} initials={i.email[0]?.toUpperCase()} size="sm" />
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{i.email}</span>
                    <span className="small muted">{t(`roles.${i.role}`)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="close"
                      aria-label={t("onboarding.removeInvite", { email: i.email })}
                      onClick={() => setInvites(invites.filter((x) => x.email !== i.email))}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="row row--end">
              <Field label={t("onboarding.email")} id="inv-new" style={{ flex: "1 1 240px" }} error={draftError}>
                <Input
                  type="email"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDraftError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add();
                    }
                  }}
                  placeholder={t("onboarding.emailPlaceholder")}
                />
              </Field>
              <Field label={t("onboarding.role")} id="inv-role" style={{ flex: "0 1 140px" }}>
                <Select value={draftRole} onValueChange={setDraftRole} options={roleOptions} />
              </Field>
              <Button onClick={add} style={draftError ? { marginBottom: 22 } : undefined}>
                {t("onboarding.add")}
              </Button>
            </div>
            <div className="soft-box">
              <span className="small muted" style={{ flex: "1 1 240px", minWidth: 0 }}>
                {t("onboarding.linkHint")}
              </span>
              <Button size="sm" onClick={() => void copyLink()}>
                {copied ? t("onboarding.linkCopied") : t("onboarding.copyLink")}
              </Button>
            </div>
          </>
        )}

        <div className="row" style={{ paddingTop: 4 }}>
          {step > 1 && (
            <Button onClick={() => setStep((s) => s - 1)} disabled={busy}>
              {t("common.back")}
            </Button>
          )}
          <span className="spacer" />
          {step === 4 && (
            <button
              type="button"
              className="ac-link ac-link--muted"
              style={{
                background: "none",
                border: 0,
                cursor: "pointer",
                fontSize: 14,
                marginRight: 8,
                textDecoration: "underline",
              }}
              onClick={() => finish.mutate(false)}
              disabled={busy}
            >
              {t("onboarding.skip")}
            </button>
          )}
          {step < 4 ? (
            <Button variant="primary" onClick={() => void next().catch(() => {})} disabled={blocked || busy}>
              {t("common.continue")}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => finish.mutate(true)} disabled={busy}>
              {finishLabel(t, invites.length, orgName)}
            </Button>
          )}
        </div>
      </Card>
    </CenteredLayout>
  );
}
