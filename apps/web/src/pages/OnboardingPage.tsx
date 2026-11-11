import type { Agent } from "@agenteschat/client";
import { ApiError, keys, type Me, meQuery, useAuthConfig, type WorkspaceMode } from "@agenteschat/client";
import { accountOutOfReach } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { settingUp } from "@agenteschat/client/lib/guards";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { landingOf, type RailStep, railState } from "@agenteschat/client/lib/onboarding";
import { finishOnboarding, isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { browserTimezone, timezoneName } from "@agenteschat/client/lib/routines";
import { aboutOf, type BusinessType } from "@agenteschat/client/lib/team-plan";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  AgentSticker,
  Avatar,
  Button,
  Chip,
  Field,
  Icon,
  Input,
  Locked,
  Logo,
  Menu,
  MenuItem,
  OptionList,
  setGaze,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { DeleteAccountDialog } from "@/components/DeleteAccount";
import { DeleteWorkspaceDialog } from "@/components/DeleteWorkspace";
import { ErrorState } from "@/components/Loading";
import { COMPACT_QUERY, DESKTOP_QUERY, useMediaQuery } from "@/components/NavDrawer";
import { ImageCropDialog, OrgMark } from "@/components/ProfilePhoto";
import { PurposeScene } from "@/components/PurposeScene";
import { BootSplash, OnboardingHorizon, OnboardingProgress } from "@/components/Sky";
import { StepRail } from "@/components/StepRail";
import { ZonePicker } from "@/components/ZoneSelect";
import { ARRIVAL_PARAM } from "@/lib/arrival";
import { sendNewLink } from "@/lib/email-confirmation";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { usePlanOffer } from "@/lib/plan-offer";
import { returnPlace } from "@/lib/return-to";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { OnboardingPreview, type PreviewAgent } from "./onboarding/OnboardingPreview";
import { BusinessStep, PlanStep, TeamStep, useTemplate } from "./onboarding/steps";
import "./onboarding.css";

/**
 * The onboarding (ADR 0162): the blue rail with Lodi on its horizon, one step at a time, read from the workspace's own
 * data so a workspace left at any step resumes there. First what the workspace is for (ADR 0159): "For me" makes a
 * personal workspace at once and opens it in its right hand's DM, where its card holds the rest; a company or team
 * goes on with its name (which creates it), what it does, its team (a template, made in one click), and, where the
 * workspace waits for its first plan, the plan. On wide screens its sidebar fills in beside the question. A team's
 * opens in #general, or in its right hand's DM when the plan was left for later, on its arrival (ADR 0160).
 */
export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const phone = useMediaQuery(COMPACT_QUERY);
  const wide = useMediaQuery(DESKTOP_QUERY);

  // What it is for (ADR 0159), asked before the workspace exists; a company or team then goes on to its name.
  const [purpose, setPurpose] = useState<WorkspaceMode | null>(null);
  const [forTeam, setForTeam] = useState(false);
  const personal = purpose === "personal";
  const [org, setOrg] = useState("");
  // The zone the person picked here, if they did.
  const [zone, setZone] = useState<string | null>(null);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [logo, setLogo] = useState<{ imageBase64: string; contentType: string } | null>(null);
  const [logoDirty, setLogoDirty] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  // Made here; else the one this person is setting up (another tab, a visit cut short), which resumes.
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  // A done step the person went back to, else the step the data says.
  const [picked, setPicked] = useState<RailStep | null>(null);
  // What step 2 picked in this visit: step 3 starts on its template.
  const [business, setBusiness] = useState<BusinessType | null>(null);
  // "Apagar este workspace" (`?delete=1`, which the phone's onboarding opens) and "Apagar conta", kept in the address.
  const [deleting, setDeleting] = useOpenParam("delete");
  const [account, setAccount] = useOpenParam("account");
  const lodiRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const me = useQuery({ ...meQuery(api), refetchOnWindowFocus: "always" });
  const authConfig = useAuthConfig().data;
  const unfinished = me.data?.organizations.find(settingUp);
  const target =
    created ??
    (unfinished?.onboarding
      ? { orgId: unfinished.id, generalChannelId: unfinished.onboarding.generalChannelId }
      : null);
  const orgId = target?.orgId ?? null;
  const mine = me.data?.organizations.find((o) => o.id === orgId);
  // Asked again whenever the tab comes back, as `me` is: a step answered meanwhile in another tab or on the phone moves
  // this one on, so its button never makes a second team.
  const settings = useQuery({
    queryKey: keys.settings(orgId ?? ""),
    queryFn: () => api.orgs.settings(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const agents = useQuery({
    queryKey: keys.agents(orgId ?? ""),
    queryFn: () => api.agents.list(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const lodi = agents.data?.find(isRightHand);
  // In the order they were made (the server's), a template's team in its template's order: as every screen lists it.
  const team = (agents.data ?? []).filter((a) => !isRightHand(a));
  const context = settings.data?.context?.trim() ?? "";
  const { steps, at, reached, step, index } = railState({
    orgId,
    standing: mine?.standing,
    billingUrl: authConfig?.billingUrl,
    context,
    team: team.length,
    picked,
    // Made here as "For me", or one being set up that is.
    personal: isPersonal(mine) || (created !== null && personal),
  });
  // Before the workspace exists, what it is for comes first.
  const asking = orgId === null && !forTeam;
  // On that question the chosen answer's agents look at the pointer (`PurposeScene`, its `data-gaze`).
  useEffect(() => {
    if (!asking) return;
    const look = (e: PointerEvent) => setGaze({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", look);
    return () => {
      window.removeEventListener("pointermove", look);
      setGaze(null);
    };
  }, [asking]);
  // Read from the first step, so the plan step has it when it opens.
  const plans = usePlanOffer(i18n.language);
  const offer = plans.offer;
  // Read once is enough: a refetch that fails later keeps the step on screen with what it read. The plan step opens
  // whole, back from the billing page too: with its price, or with none once the list is late, never a line that changes.
  const known =
    (orgId === null || (settings.data !== undefined && agents.data !== undefined && mine !== undefined)) &&
    !(step === "plan" && plans.loading);
  const name = (mine?.name ?? org).trim();
  // Back on step 1, the workspace's own zone (saved on another visit, maybe another device), never this browser's.
  const zoneNow = zone ?? settings.data?.timezone ?? browserTimezone() ?? "UTC";
  const kind = business ?? aboutOf(t, context).business;
  const template = useTemplate(orgId, kind, step === "business" || step === "team");

  // On agentes.chat Cloud, while sign-up is by invitation, only accounts early access allowed make workspaces (ADR 0078).
  const inviteOnly = me.data?.user.canCreateWorkspace === false && orgId === null;
  const emails = sendsEmail(authConfig);
  const email = me.data?.user.email ?? "";
  // Their face in the first question's drawings: the account's photo (Google's), else their initials.
  const you = { name: me.data?.user.name || email, image: me.data?.user.image ?? null };
  // The address this tab's sign-up was emailed a link to confirm: the step says where it went. Read once and
  // forgotten once confirmed or set up, so a later onboarding (another workspace) says nothing of it.
  const [sentTo] = useState(() => sessionStore.get(STORAGE_KEYS.confirmationSent));
  const verified = me.data?.user.emailVerified === true;
  const confirmationSent = email !== "" && sentTo === email && !verified;
  // Early access counts only for a confirmed address (ADR 0078 §4): held here unconfirmed, a new link is the way on.
  const confirmFirst = inviteOnly && emails && email !== "" && !verified && !confirmationSent;
  useEffect(() => {
    if (verified) sessionStore.remove(STORAGE_KEYS.confirmationSent);
  }, [verified]);
  const resend = useMutation({ mutationFn: () => sendNewLink({ auth, t, show: toast.show }, email) });

  // Someone who already has a workspace can give up on a new one: back to the one they were in (or any other).
  const others = (me.data?.organizations ?? []).filter((o) => o.id !== orgId && !settingUp(o));
  const leaveTo = others.find((o) => o.id === storage.get(STORAGE_KEYS.lastOrg)) ?? others[0];

  const open = useMutation({
    mutationFn: async (how: "paid" | "done" | "skipped" | "import") => {
      if (!target) return;
      const done = await finishOnboarding(api, target.orgId);
      sessionStore.remove(STORAGE_KEYS.confirmationSent);
      // The answer that finished it says who the person is now: it opens without asking the server again.
      if (done.me) qc.setQueryData(keys.me, done.me);
      else await qc.invalidateQueries({ queryKey: keys.me });
      const params = { orgId: target.orgId };
      // Wherever it opens, on its arrival (ADR 0160): the beta notice, then Connect an AI.
      const search = { [ARRIVAL_PARAM]: 1 } as never;
      if (how === "import")
        await navigate({ to: "/org/$orgId/settings/$section", params: { ...params, section: "import" }, search });
      else if (landingOf(how, isPersonal(mine)) === "rightHand" && done.agentId)
        await navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { ...params, agentId: done.agentId }, search });
      else
        await navigate({
          to: "/org/$orgId/c/$channelId",
          params: { ...params, channelId: target.generalChannelId },
          search,
        });
    },
    // Opening by itself, a failure is the page's own (below); from a button, the step stays and a toast says it.
    onError: (e, how) => {
      if (how !== "done") toast.show(errorText(t, e), "error");
    },
  });

  const save = useMutation({
    // Owning a workspace that waits for its first plan is said in place, with the way to that plan.
    meta: { silent: true },
    onError: (e) => {
      if (errorCode(e) !== "org.create_unpaid") toast.show(errorText(t, e), "error");
    },
    mutationFn: async () => {
      let made: { orgId: string; generalChannelId: string } | null = null;
      // `/me` as the create answered it, while nothing after it changed it.
      let now: Me | undefined;
      if (!orgId) {
        const res = await api.orgs.create({
          // "For me": no name to ask, the word for it in the person's language (renamed in Settings like any other).
          name: personal ? t("onboarding.personal.name") : org.trim(),
          ...(personal ? { mode: "personal" as const } : {}),
          timezone: zoneNow,
          // The person's own zone, detected here: agents read the local time from it (the language is `useServerLocale`'s).
          memberTimezone: browserTimezone() ?? undefined,
        });
        made = { orgId: res.organization.id, generalChannelId: res.generalChannelId };
        now = res.me;
      } else {
        await api.orgs.updateSettings(orgId, { name: org.trim(), ...(zone ? { timezone: zone } : {}) });
      }
      const id = made?.orgId ?? orgId ?? "";
      // The logo needs the workspace: picked before it existed, sent now (a team's only: "For me" asks none).
      if (logoDirty && !personal) {
        if (logo) await api.orgs.setLogo(id, logo);
        else await api.orgs.removeLogo(id);
        setLogoDirty(false);
        now = undefined;
      }
      // The next step's data first, then the workspace among mine: it shows at once, with no splash between.
      await Promise.all([
        qc.prefetchQuery({ queryKey: keys.settings(id), queryFn: () => api.orgs.settings(id) }),
        qc.prefetchQuery({ queryKey: keys.agents(id), queryFn: () => api.agents.list(id) }),
      ]);
      if (now) qc.setQueryData(keys.me, now);
      else await qc.invalidateQueries({ queryKey: keys.me });
      if (made) setCreated(made);
      setPicked(null);
    },
  });

  // Everything answered, and no plan to wait for: it opens (back here from another tab, or paid meanwhile).
  const opening = useRef(false);
  useEffect(() => {
    if (!known || at !== "open" || opening.current || deleting !== null) return;
    opening.current = true;
    open.mutate("done");
  });

  // A new step replaces the old one's button under the focus: the focus goes to the new question, where Enter still
  // reaches the step's action.
  const shownStep = useRef<RailStep | null>(null);
  useEffect(() => {
    if (!known || shownStep.current === step) return;
    if (shownStep.current !== null) titleRef.current?.focus();
    shownStep.current = step;
  });

  const refused = save.error;
  const unpaidElsewhere =
    refused instanceof ApiError && refused.code === "org.create_unpaid" && typeof refused.params?.orgId === "string"
      ? refused.params.orgId
      : null;
  const busy = save.isPending || open.isPending;
  const savedLogo = logoDirty ? null : mine?.logo;
  const shownLogo = logo ? `data:${logo.contentType};base64,${logo.imageBase64}` : (savedLogo ?? null);
  const lodiName = lodi?.name ?? RIGHT_HAND_DEFAULT.name;

  // A read that failed, or a workspace that wouldn't open: said, with the way on, never a sky that waits for nothing.
  const failed =
    orgId === null
      ? null
      : ([settings, agents].find((q) => q.data === undefined && q.isError && !q.isFetching)?.error ??
        (at === "open" && open.isError ? open.error : null));
  if (failed)
    return (
      <div className="page page--mid">
        <ErrorState
          error={failed}
          onRetry={() => {
            opening.current = false;
            open.reset();
            if (settings.isError) void settings.refetch();
            if (agents.isError) void agents.refetch();
          }}
        />
      </div>
    );
  if (!me.data || !known || (at === "open" && deleting === null)) return <BootSplash />;

  const say = t(`onboarding.flow.lodi.${step}`, { first: firstName(me.data.user.name), ...agentGrammar(lodiName) });
  const answered = Math.min(reached, steps.length);
  const values: Partial<Record<RailStep, string>> = {
    name: name || undefined,
    business:
      kind && kind !== "other"
        ? t(`teamPlan.business.${kind}`)
        : context
          ? t("onboarding.railValue.context")
          : undefined,
    team: team.length
      ? joinNames(
          team.map((a) => a.name),
          t,
        )
      : undefined,
  };

  const preview: PreviewAgent[] = [
    { name: lodiName, role: t("rightHand.label"), look: lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance },
    ...(team.length > 0
      ? team.map((a: Agent) => ({ name: a.name, role: a.role, look: lookOf(a), asleep: step === "plan" }))
      : step === "team" && template.chosen
        ? // In the template's order, the team's once made: making it moves no row.
          template.chosen.team.agents.map((a) => ({ name: a.name, role: a.role, look: lookOf(a), fresh: true }))
        : []),
  ];

  return (
    <div className="onb onb--rail">
      <aside className="onb__rail">
        <div className="onb__top">
          <span className="onb__brand">
            <Logo size={22} />
          </span>
          <Menu
            align={phone ? "end" : "start"}
            label={t("onboarding.flow.account")}
            trigger={
              <button type="button" className="onb__me" aria-label={t("onboarding.flow.account")}>
                <Avatar kind="person" name={me.data.user.name} imageUrl={me.data.user.image} size="sm" />
              </button>
            }
          >
            {orgId && (
              <MenuItem icon="trash" danger onSelect={() => setDeleting(1)}>
                {t("onboarding.deleteLink")}
              </MenuItem>
            )}
            {accountOutOfReach(me.data.organizations) && (
              <MenuItem icon="trash" danger onSelect={() => setAccount("delete")}>
                {t("deleteAccount.menu")}
              </MenuItem>
            )}
            <MenuItem
              icon="arrowRight"
              danger
              onSelect={async () => {
                await auth.signOut();
                qc.clear();
                await navigate({ to: "/login" });
              }}
            >
              {t("auth.signOut")}
            </MenuItem>
          </Menu>
        </div>
        {!phone && (
          <div className="onb__progress">
            <span className="onb__progress-text">
              <span>{t("onboarding.progress.left", { count: steps.length - answered })}</span>
              <span>{t("agentSetup.count", { done: answered, total: steps.length })}</span>
            </span>
            <OnboardingProgress progress={answered / steps.length} />
          </div>
        )}
        <StepRail
          label={t("onboarding.stepsLabel")}
          current={index}
          onGo={(i) => {
            // Back on the name, its field holds the saved one, to change or clear.
            if (steps[i] === "name") setOrg(name);
            setPicked(steps[i] ?? null);
          }}
          doneLabel={t("onboarding.stepDone")}
          steps={steps.map((s, i) => ({
            id: s,
            name: t(`onboarding.flow.steps.${s}`),
            done: i < reached,
            disabled: i > reached || busy,
            value: values[s],
          }))}
        />
        {!phone && (
          <div className="onb__lodi" ref={lodiRef}>
            <p className="onb__say" key={step}>
              {say}
            </p>
            <span className="onb__lodi-who">
              <AgentSticker
                appearance={lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance}
                mood="wave"
                size={64}
                seed="lodi"
              />
              <Chip className="sky-chip">{lodiName}</Chip>
            </span>
          </div>
        )}
        {!phone && <OnboardingHorizon progress={answered / steps.length} clear={() => [lodiRef.current]} />}
        {orgId && (
          <DeleteWorkspaceDialog
            org={{ id: orgId, name }}
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            onDeleted={() => void navigate({ to: "/org/$orgId", params: { orgId } })}
          />
        )}
        <DeleteAccountDialog open={account === "delete"} onClose={() => setAccount(null)} />
      </aside>

      <main
        className="onb__main"
        onKeyDown={(e) => {
          // Enter presses the step's button that shows ↵ (the plan has none), except where Enter means something else
          // (Shift+Enter: a new line in the business's sentence).
          const el = e.target as HTMLElement;
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          // On an answer of the first question too: a radio takes no Enter of its own (it stops it, though).
          const answer = el.matches("[role='radio']");
          if (!answer && e.defaultPrevented) return;
          if (!answer && el.closest("button, a, [role='dialog'], [role='listbox'], [role='combobox']")) return;
          const go = e.currentTarget.querySelector<HTMLButtonElement>("button[data-enter]:not(:disabled)");
          if (!go) return;
          e.preventDefault();
          go.click();
        }}
      >
        <div className="onb__cols">
          {/* Outside the step, as the rail is on wide screens: the pixel agent walks on as a step is done. */}
          {phone && (
            <div className="onb__phone-top">
              <OnboardingProgress progress={answered / steps.length} />
              <div className="onb__lodi-row">
                <AgentAvatar name={lodiName} appearance={lookOf(lodi) ?? RIGHT_HAND_DEFAULT.appearance} size="sm" />
                <p className="onb__say" key={step}>
                  {say}
                </p>
              </div>
            </div>
          )}
          <div className="onb__body" key={asking ? "purpose" : step}>
            {step === "name" && orgId === null && forTeam ? (
              <button type="button" className="onb__back" onClick={() => setForTeam(false)} disabled={busy}>
                <Icon name="chevronLeft" size={16} />
                {t("onboarding.back")}
              </button>
            ) : (
              step === "name" &&
              leaveTo && (
                <button
                  type="button"
                  className="onb__back"
                  onClick={() => void navigate({ href: returnPlace(leaveTo.id) })}
                  disabled={busy}
                >
                  <Icon name="chevronLeft" size={16} />
                  {t("onboarding.leave", { name: leaveTo.name })}
                </button>
              )
            )}
            <header className="onb__head">
              {!asking && (
                <p className="onb__eyebrow">{t("onboarding.flow.stepOf", { n: index + 1, total: steps.length })}</p>
              )}
              <h1 className="onb__title" ref={titleRef} tabIndex={-1}>
                {asking
                  ? t("onboarding.purpose.title")
                  : step === "name"
                    ? t("onboarding.workspace.title")
                    : step === "business"
                      ? t("agentSetup.firstRun.about.title", { org: name })
                      : step === "team"
                        ? t("onboarding.flow.team.title")
                        : t("onboarding.flow.plan.title")}
              </h1>
              <p className="onb__lead">
                {asking
                  ? t("onboarding.purpose.lead")
                  : step === "name"
                    ? t("onboarding.workspace.lead")
                    : step === "business"
                      ? t("agentSetup.firstRun.about.desc")
                      : step === "team"
                        ? t("teamPlan.templates.heldLead")
                        : t("onboarding.flow.plan.lead")}
              </p>
            </header>

            {step === "name" && (
              <>
                <Locked when={busy}>
                  {asking ? (
                    <div className="onb__answer">
                      <OptionList<WorkspaceMode | "">
                        aria-label={t("onboarding.purpose.title")}
                        layout="cards"
                        className="onb-purpose"
                        value={purpose ?? ""}
                        onValueChange={(v) => setPurpose(v || null)}
                        options={PURPOSES.map((mode) => ({
                          value: mode,
                          leading: <PurposeScene kind={mode} chosen={purpose === mode} you={you} />,
                          title: t(`onboarding.purpose.${mode}`),
                          description: (
                            <>
                              <span>{t(`onboarding.purpose.${mode}Text`)}</span>
                              <span className="onb-purpose__examples">{t(`onboarding.purpose.${mode}Examples`)}</span>
                            </>
                          ),
                        }))}
                      />
                      {unpaidElsewhere && (
                        <UnpaidNote
                          orgId={unpaidElsewhere}
                          name={me.data.organizations.find((o) => o.id === unpaidElsewhere)?.name}
                          billing={Boolean(authConfig?.billingUrl)}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="onb__answer">
                      <div className="onb__ws">
                        <button
                          type="button"
                          className="onb__logo"
                          aria-label={logo ? t("onboarding.workspace.logoChange") : t("onboarding.workspace.logoPick")}
                          title={t("onboarding.workspace.logoHelp")}
                          onClick={() => setLogoOpen(true)}
                        >
                          {shownLogo ? (
                            <OrgMark logo={shownLogo} size={48} />
                          ) : org.trim() || name ? (
                            <span className="onb__logo-letter">{(org.trim() || name).charAt(0).toUpperCase()}</span>
                          ) : (
                            <Icon name="upload" />
                          )}
                        </button>
                        <Input
                          className="onb__big"
                          aria-label={t("onboarding.workspace.name")}
                          value={org}
                          onChange={(e) => setOrg(e.target.value)}
                          placeholder={t("onboarding.workspace.namePlaceholder")}
                          spellCheck={false}
                          autoFocus
                        />
                      </div>
                      {zoneOpen ? (
                        <Field
                          label={t("onboarding.workspace.timezone")}
                          id="org-zone"
                          hint={{
                            name: t("common.about", { label: t("onboarding.workspace.timezone") }),
                            text: t("onboarding.workspace.timezoneHelp"),
                          }}
                        >
                          <ZonePicker
                            id="org-zone"
                            value={zoneNow}
                            onChange={setZone}
                            suggested={[browserTimezone() ?? "", "UTC"].filter(Boolean)}
                          />
                        </Field>
                      ) : (
                        <p className="onb__help">
                          {t("onboarding.workspace.zone", { zone: timezoneName(zoneNow, i18n.language) })} ·{" "}
                          <button type="button" className="ac-link onb__link" onClick={() => setZoneOpen(true)}>
                            {t("onboarding.workspace.zoneChange")}
                          </button>
                        </p>
                      )}
                      <ImageCropDialog
                        open={logoOpen}
                        onClose={() => setLogoOpen(false)}
                        title={t("orgLogo.title")}
                        help={t("orgLogo.help")}
                        placeholder={<OrgMark size={56} />}
                        hasImage={shownLogo !== null}
                        removeLabel={t("orgLogo.remove")}
                        format="image/png"
                        save={async (image) => {
                          setLogo(image);
                          setLogoDirty(true);
                        }}
                        remove={async () => {
                          setLogo(null);
                          setLogoDirty(true);
                        }}
                        onSaved={() => setLogoOpen(false)}
                        onRemoved={() => setLogoOpen(false)}
                      />
                      {unpaidElsewhere && (
                        <UnpaidNote
                          orgId={unpaidElsewhere}
                          name={me.data.organizations.find((o) => o.id === unpaidElsewhere)?.name}
                          billing={Boolean(authConfig?.billingUrl)}
                        />
                      )}
                    </div>
                  )}
                </Locked>
                {inviteOnly && (
                  <p className="onb__help onb__note ac-iconline" role="status">
                    <Icon name="lock" size={14} />
                    <span>
                      {authConfig?.supportEmail
                        ? t("onboarding.workspace.inviteOnlyAsk", { email: authConfig.supportEmail })
                        : t("onboarding.workspace.inviteOnly")}
                    </span>
                  </p>
                )}
                {(confirmationSent || confirmFirst) && (
                  <p className="onb__help onb__note ac-iconline" role="status">
                    <Icon name="mail" size={14} />
                    <span>
                      {confirmationSent
                        ? t("onboarding.confirmation.sent", { email })
                        : t("onboarding.confirmation.first")}
                      {!resend.data && (
                        <>
                          <br />
                          <button
                            type="button"
                            className="ac-link onb__link"
                            onClick={() => resend.mutate()}
                            disabled={resend.isPending}
                          >
                            {t("auth.sendNewLink")}
                          </button>
                        </>
                      )}
                    </span>
                  </p>
                )}
                <div className="onb__actions">
                  <Button
                    variant="primary"
                    block
                    kbd={["↵"]}
                    data-enter=""
                    onClick={() => (asking && !personal ? setForTeam(true) : save.mutate())}
                    disabled={(asking ? !purpose : !org.trim()) || inviteOnly || busy}
                    loading={save.isPending}
                  >
                    {t("onboarding.actions.continue")}
                  </Button>
                </div>
              </>
            )}
            {step === "business" && orgId && (
              <BusinessStep
                orgId={orgId}
                context={context}
                business={kind}
                onDone={(picked) => {
                  // Another business starts the team step on its own template again; the same keeps the one picked.
                  if (picked !== kind) template.pick(null);
                  setBusiness(picked);
                  setPicked(null);
                }}
              />
            )}
            {step === "team" && orgId && (
              <TeamStep
                orgId={orgId}
                team={team}
                template={template}
                reviewer={lodiName}
                onContinue={() => setPicked(null)}
                onImport={() => open.mutate("import")}
                leaving={open.isPending}
              />
            )}
            {step === "plan" && orgId && (
              <PlanStep
                orgId={orgId}
                team={team}
                offer={offer}
                skipping={open.isPending}
                onSkip={() => open.mutate("skipped")}
              />
            )}
          </div>
          {wide && (
            <OnboardingPreview
              org={name || t("onboarding.flow.preview.name")}
              logo={shownLogo}
              channels={[
                "general",
                ...(step === "team" && team.length === 0 ? (template.chosen?.team.newChannels ?? []) : []),
              ]}
              fresh={step === "team" && team.length === 0 ? (template.chosen?.team.newChannels ?? []) : []}
              orgId={team.length > 0 ? orgId : null}
              agents={preview}
              person={me.data.user}
            />
          )}
        </div>
      </main>
    </div>
  );
}

/** The two answers to "What will you use agentes.chat for?" (ADR 0159), in this order. */
const PURPOSES = ["personal", "team"] as const satisfies readonly WorkspaceMode[];

/**
 * Owning a workspace that waits for its first plan: said in place, with the way into that workspace (someone who came
 * back to this page after making it was looking for it, not for another) and the way to its plan.
 */
function UnpaidNote({ orgId, name, billing }: { orgId: string; name: string | undefined; billing: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <p className="onb__status ac-iconline" role="alert">
        <Icon name="pause" size={14} />
        <span>{t("standing.createUnpaid")}</span>
      </p>
      {(name || billing) && (
        <div className="row">
          {name && (
            <Button onClick={() => void navigate({ href: returnPlace(orgId) })}>
              {t("standing.createUnpaidOpen", { name })}
            </Button>
          )}
          {billing && (
            <BillingLinkButton orgId={orgId} from="new_workspace" icon="external">
              {t("standing.billing.cta.payment")}
            </BillingLinkButton>
          )}
        </div>
      )}
    </>
  );
}
