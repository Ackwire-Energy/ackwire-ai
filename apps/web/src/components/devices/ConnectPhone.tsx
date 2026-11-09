import type { ComputerDevice, DeviceAudience, PhoneDevice } from "@agenteschat/client";
import {
  androidStage,
  computerLine,
  IPHONE_STEPS,
  type IphoneStep,
  iphoneOf,
  iphoneSteps,
  phoneLine,
  type StepState,
} from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { computerKind } from "@agenteschat/client/lib/machines";
import {
  Button,
  ComputerIcon,
  DialogBody,
  Field,
  Icon,
  InfoHint,
  Input,
  Locked,
  PixelSpinner,
  Segmented,
  Select,
} from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandBlock } from "@/components/Machines";
import { QrCode } from "@/components/OpenOnPhone";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { FlowFooter, type FlowProps } from "./flow";
import { DevicePortrait } from "./parts";
import { useDevices, useUpdatePhone } from "./queries";
import { WhoPicker, WhoSelect } from "./WhoCanUse";

/** What to run on the computer for Wi-Fi pairing: adb's own words, with what the phone shows in capitals. */
const ADB_PAIR = "adb pair IP:PORT CODE";

/** While a phone flow is open, the list is asked every 2 s too: the phone may show up between events. */
const PHONE_POLL_MS = 2000;

/** One step of a live checklist: its mark (a tick, the live orbit, an alert, or its number), title, one line, extras. */
function Step({
  state,
  title,
  text,
  children,
}: {
  state: StepState;
  title: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="dv-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
      <span className="dv-step__mark" aria-hidden="true">
        {state === "done" ? (
          <Icon name="check" size={14} />
        ) : state === "current" ? (
          <PixelSpinner size={14} />
        ) : state === "needs" ? (
          <Icon name="alert" size={14} />
        ) : null}
      </span>
      <div className="dv-step__head">
        <p className="dv-step__title">{title}</p>
        {text && (
          <p className="dv-step__text" role={state === "current" ? "status" : undefined}>
            {text}
          </p>
        )}
      </div>
      {children && state !== "done" && <div className="dv-step__more">{children}</div>}
    </li>
  );
}

/** Where to go in the phone's own Settings, when no button can open it. */
function SettingsPath({ segments, label }: { segments: string[]; label: string }) {
  return (
    <ol className="dv-path" aria-label={label}>
      {segments.map((s) => (
        <li key={s}>
          <span className="dv-path__seg">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** A tiny drawing of the phone's own setting row, the row to find ringed: a tap count or its switch. */
function SettingRowDrawing({ title, sub, taps }: { title: string; sub: string; taps?: number }) {
  return (
    <div className="dv-setting" role="img" aria-label={title}>
      <span className="dv-setting__text">
        <b>{title}</b>
        <small>{sub}</small>
      </span>
      {taps ? (
        <span className="dv-setting__tap">
          <Icon name="pointer" size={14} />
          {taps}×
        </span>
      ) : (
        <span className="dv-setting__switch" data-on="" />
      )}
    </div>
  );
}

/**
 * Android's own "Allow USB debugging?" prompt, drawn in the app's language with Android's own words for it (we can
 * only draw it: nothing may tick it or tap Allow for the person).
 */
export function UsbPrompt({ wifi = false }: { wifi?: boolean }) {
  const { t } = useTranslation();
  const title = t(wifi ? "devices.android.prompt.titleWifi" : "devices.android.prompt.title");
  return (
    <div className="dv-setting dv-setting--dialog" role="img" aria-label={title}>
      <span className="dv-setting__title">{title}</span>
      <span className="dv-setting__row">
        {/* The checkbox's look, drawn: nothing here can be ticked. */}
        <span className="ac-check" data-state="checked" aria-hidden="true">
          <span className="ac-check__mark" data-state="checked">
            <svg viewBox="0 0 12 12" fill="none" className="ac-check__svg" aria-hidden="true">
              <path className="ac-check__tick" d="m2.5 6.2 2.3 2.3 4.7-5" />
            </svg>
          </span>
        </span>
        {t(wifi ? "devices.android.prompt.alwaysWifi" : "devices.android.prompt.always")}
      </span>
      <span className="dv-setting__btns">
        <span>{t("devices.android.prompt.cancel")}</span>
        <span className="dv-setting__tap">
          <Icon name="pointer" size={14} />
          {t("devices.android.prompt.allow")}
        </span>
      </span>
    </div>
  );
}

/** A computer to plug into: its line icon, name and whether it's online, online ones first. */
function HostSelect({
  hosts,
  value,
  onChange,
  id,
}: {
  hosts: ComputerDevice[];
  value: string;
  onChange: (id: string) => void;
  id: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      value={value}
      onValueChange={onChange}
      options={hosts.map((h) => ({
        value: h.id,
        label: t(h.status.kind === "offline" ? "devices.host.offline" : "devices.host.online", { name: h.name }),
        leading: <ComputerIcon kind={computerKind(h.os)} size={16} />,
        description: computerLine(t, h),
      }))}
    />
  );
}

const onlineFirst = (a: ComputerDevice, b: ComputerDevice) =>
  Number(a.status.kind === "offline") - Number(b.status.kind === "offline");

/** The computer a phone flow starts on: the one asked for, else the viewer's own online one, else any online one. */
function pickHost(hosts: ComputerDevice[], wanted: string | null, me: string) {
  return (
    hosts.find((h) => h.id === wanted) ??
    hosts.find((h) => h.ownerUserId === me && h.status.kind !== "offline") ??
    hosts.find((h) => h.status.kind !== "offline") ??
    hosts[0]
  );
}

/** No computer to plug a phone into yet: say so, and offer to connect one. */
function NeedsComputer({ text, onConnect }: { text: string; onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="setup-progress setup-progress--line ac-iconline" role="status">
      <Icon name="info" size={14} />
      <span>
        {text}{" "}
        <button type="button" className="ac-link" onClick={onConnect}>
          {t("devices.connectComputer")}
        </button>
      </span>
    </p>
  );
}

/**
 * An Android phone through a computer people connected: pick the computer, then a checklist the computer drives (it
 * sees the phone ask to allow USB debugging, then ready). Beside it a QR that opens the same steps in our phone app,
 * where buttons open each setting. Over Wi-Fi: Wireless debugging and `adb pair` on that computer.
 */
export function AndroidFlow({
  onClose,
  onBack,
  setTitle,
  hostId,
  onConnectComputer,
}: FlowProps & { hostId: string | null; onConnectComputer: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const devices = useDevices(org.id, PHONE_POLL_MS);
  const hosts = (devices.data?.devices ?? []).filter((d) => d.machineKind !== "managed").sort(onlineFirst);
  const [picked, setPicked] = useState<string | null>(hostId);
  const [way, setWay] = useState<"cable" | "wifi">("cable");
  const host = pickHost(hosts, picked, me.user.id);
  // The phones each computer had when the dialog opened: only a new one (or one still asking) is the one being plugged.
  const known = useRef<Set<string> | null>(null);
  if (!known.current && devices.data)
    known.current = new Set(devices.data.devices.flatMap((d) => d.phones.map((p) => p.id)));
  const stage = androidStage(host, known.current ?? new Set());
  const readyName = stage.kind === "ready" ? stage.phone.name : null;
  useEffect(
    () => setTitle(readyName ? t("devices.android.connectedTitle", { name: readyName }) : t("devices.android.title")),
    [readyName, setTitle, t],
  );
  if (stage.kind === "ready" && host) return <PhoneConnected phone={stage.phone} host={host} onClose={onClose} />;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const guide = host
    ? `${origin}/org/${org.id}/settings/devices/android-setup?computer=${encodeURIComponent(host.id)}`
    : "";
  const looking = host ? t("devices.android.looking", { computer: host.name }) : "";
  const allow = stage.kind === "allow";
  const steps =
    way === "cable" ? (
      <ol className="dv-steps">
        <Step
          state={allow ? "done" : "waiting"}
          title={t("devices.android.devOptions")}
          text={allow ? t("devices.android.found", { name: stage.phone.name }) : t("devices.android.devOptionsText")}
        >
          <SettingRowDrawing
            title={t("devices.android.buildNumber")}
            sub={t("devices.android.buildNumberSub")}
            taps={7}
          />
        </Step>
        <Step
          state={allow ? "done" : "waiting"}
          title={t("devices.android.usbDebugging")}
          text={allow ? t("devices.android.found", { name: stage.phone.name }) : t("devices.android.usbDebuggingText")}
        >
          <SettingRowDrawing title={t("devices.android.usbRow")} sub={t("devices.android.usbRowSub")} />
        </Step>
        <Step
          state={allow ? "done" : "current"}
          title={t("devices.android.plug")}
          text={allow ? t("devices.android.plugged", { computer: host?.name ?? "" }) : looking}
        />
        <Step
          state={allow ? "needs" : "waiting"}
          title={t("devices.android.allow")}
          text={t("devices.android.allowText")}
        >
          <UsbPrompt />
        </Step>
      </ol>
    ) : (
      <ol className="dv-steps">
        <Step
          state={allow ? "done" : "waiting"}
          title={t("devices.android.devOptions")}
          text={allow ? t("devices.android.found", { name: stage.phone.name }) : t("devices.android.devOptionsText")}
        >
          <SettingRowDrawing
            title={t("devices.android.buildNumber")}
            sub={t("devices.android.buildNumberSub")}
            taps={7}
          />
        </Step>
        <Step
          state={allow ? "done" : "current"}
          title={t("devices.android.wifiPair")}
          text={allow ? t("devices.android.found", { name: stage.phone.name }) : t("devices.android.wifiPairText")}
        >
          <SettingsPath
            label={t("devices.onThePhone")}
            segments={[
              t("devices.android.path.devOptions"),
              t("devices.android.path.wireless"),
              t("devices.android.path.pairCode"),
            ]}
          />
          <span className="small muted">{t("devices.android.wifiRun", { computer: host?.name ?? "" })}</span>
          <CommandBlock command={ADB_PAIR} />
          <span className="small muted">{looking}</span>
        </Step>
        <Step
          state={allow ? "needs" : "waiting"}
          title={t("devices.android.allow")}
          text={t("devices.android.allowTextWifi")}
        >
          <UsbPrompt wifi />
        </Step>
      </ol>
    );
  return (
    <>
      <DialogBody className="dv-android">
        {hosts.length === 0 ? (
          <NeedsComputer text={t("devices.android.noComputer")} onConnect={onConnectComputer} />
        ) : (
          <div className="dv-split">
            <div className="stack-4" style={{ gap: "var(--space-4)" }}>
              <Field
                label={t(way === "cable" ? "devices.android.plugInto" : "devices.android.pairWith")}
                id="dv-android-host"
              >
                <HostSelect hosts={hosts} value={host?.id ?? ""} onChange={setPicked} id="dv-android-host" />
              </Field>
              <Segmented
                block
                label={t("devices.android.way")}
                value={way}
                onValueChange={setWay}
                options={[
                  {
                    value: "cable",
                    label: (
                      <>
                        {t("devices.android.cable")}
                        <span className="dv-seg__note">{t("devices.android.recommended")}</span>
                      </>
                    ),
                  },
                  { value: "wifi", label: t("devices.android.wifi") },
                ]}
              />
              {host?.status.kind === "offline" ? (
                <p className="setup-progress setup-progress--line ac-iconline" role="status">
                  <Icon name="dash" size={14} />
                  <span>{t("devices.android.hostOffline", { computer: host.name })}</span>
                </p>
              ) : (
                steps
              )}
            </div>
            {guide && (
              <div className="dv-qr">
                <span className="dv-qr__code">
                  <QrCode text={guide} label={t("devices.android.qrLabel")} />
                </span>
                <span className="dv-qr__text">
                  <p className="dv-qr__line">{t("devices.android.qrLine")}</p>
                  <p className="dv-qr__caption">{t("devices.android.qrCaption")}</p>
                </span>
              </div>
            )}
          </div>
        )}
      </DialogBody>
      <FlowFooter
        onClose={onClose}
        onBack={onBack}
        note={
          way === "wifi" ? (
            <span className="ac-iconline small muted">
              <Icon name="info" size={14} />
              <span>{t("devices.android.wifiNote")}</span>
            </span>
          ) : (
            <span className="ac-hintline small muted">
              <span>{t("devices.android.notShowing")}</span>
              <InfoHint name={t("devices.android.notShowing")}>{t("devices.android.notShowingHelp")}</InfoHint>
            </span>
          )
        }
      />
    </>
  );
}

/** The phone showed up ready: its portrait and facts, its name and who can use it, saved on Done. */
function PhoneConnected({ phone, host, onClose }: { phone: PhoneDevice; host: ComputerDevice; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const update = useUpdatePhone(org.id);
  const [name, setName] = useState(phone.name);
  const [audience, setAudience] = useState<DeviceAudience>(
    () => phone.audience ?? { mode: "owner", userIds: [], roleIds: [] },
  );
  const follows = phone.audience === null;
  const done = () => {
    const clean = name.trim();
    const input = {
      ...(clean && clean !== phone.name ? { name: clean } : {}),
      ...(!follows ? { audience } : {}),
    };
    if (Object.keys(input).length === 0) return onClose();
    update.mutate(
      { id: phone.id, ...input },
      { onSuccess: onClose, onError: (err) => toast.show(errorText(t, err), "error") },
    );
  };
  return (
    <>
      <Locked when={update.isPending}>
        <DialogBody>
          <div className="ac-faceline" role="status">
            <DevicePortrait device={phone} />
            <span className="dv-connected__text">
              <span className="dv-connected__name ac-captop">{phone.name}</span>
              <span className="dv-connected__facts">{phoneLine(t, phone, host.name)}</span>
            </span>
          </div>
          <Field label={t("devices.name")} id="dv-phone-name" example={t("devices.nameHelp")}>
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          {!follows && (
            <>
              <Field
                label={t("devices.who.title")}
                id="dv-phone-who"
                example={t("devices.who.phoneHint", { host: host.name })}
              >
                <WhoSelect value={audience} onChange={setAudience} />
              </Field>
              <WhoPicker value={audience} onChange={setAudience} ownerUserId={me.user.id} idPrefix="dv-phone" />
            </>
          )}
        </DialogBody>
      </Locked>
      <FlowFooter onClose={onClose}>
        <Button variant="primary" onClick={done} loading={update.isPending} disabled={update.isPending}>
          {t("devices.done")}
        </Button>
      </FlowFooter>
    </>
  );
}

const APP_STORE_XCODE = "https://apps.apple.com/app/xcode/id497799835";

/**
 * An iPhone through a Mac: pick the Mac, then the checklist mirrored from what the Mac reports. Steps on the iPhone
 * show their Settings path: no app or page can open those screens.
 */
export function IphoneFlow({
  onClose,
  onBack,
  setTitle,
  hostId,
  onConnectComputer,
}: FlowProps & { hostId: string | null; onConnectComputer: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const devices = useDevices(org.id, PHONE_POLL_MS);
  const macs = (devices.data?.devices ?? [])
    .filter((d) => d.machineKind !== "managed" && computerKind(d.os) === "mac")
    .sort(onlineFirst);
  const [picked, setPicked] = useState<string | null>(hostId);
  const mac = pickHost(macs, picked, me.user.id);
  const phone = iphoneOf(mac);
  const states = iphoneSteps(mac, phone);
  const ready = IPHONE_STEPS.every((s) => states[s] === "done");
  const helperReason = phone && "reason" in phone.status ? phone.status.reason : null;
  useEffect(() => setTitle(t("devices.iphone.title")), [setTitle, t]);
  const text: Record<IphoneStep, ReactNode> = {
    xcode:
      states.xcode === "done"
        ? t("devices.iphone.xcodeDone", { version: mac?.toolchains.xcode ?? "" })
        : t("devices.iphone.xcodeText", { mac: mac?.name ?? "" }),
    tools: states.tools === "done" ? t("devices.iphone.toolsDone") : t("devices.iphone.toolsText"),
    account:
      states.account === "done"
        ? (mac?.toolchains.appleTeam ?? t("devices.iphone.accountDone"))
        : t("devices.iphone.accountText", { mac: mac?.name ?? "" }),
    connected:
      states.connected === "done" && phone
        ? t("devices.iphone.connectedDone", { name: phone.name, version: phone.osVersion })
        : t("devices.iphone.connectedText", { mac: mac?.name ?? "" }),
    trust: states.trust === "done" ? t("devices.iphone.trustDone") : t("devices.iphone.trustText"),
    developerMode: states.developerMode === "done" ? t("devices.iphone.devModeDone") : t("devices.iphone.devModeText"),
    uiAutomation: t("devices.iphone.uiAutomationText"),
    helper:
      helperReason === "helper_untrusted"
        ? t("devices.iphone.helperUntrustedText")
        : helperReason === "team_limit"
          ? t("devices.iphone.teamLimitText")
          : t("devices.iphone.helperText"),
  };
  const more: Partial<Record<IphoneStep, ReactNode>> = {
    xcode: (
      <span className="dv-step__acts">
        <Button asChild size="sm" icon="external">
          <a href={APP_STORE_XCODE} target="_blank" rel="noopener noreferrer">
            {t("devices.iphone.getXcode")}
          </a>
        </Button>
      </span>
    ),
    developerMode: (
      <SettingsPath
        label={t("devices.onTheIphone")}
        segments={[
          t("devices.iphone.path.settings"),
          t("devices.iphone.path.privacy"),
          t("devices.iphone.path.devMode"),
        ]}
      />
    ),
    uiAutomation: (
      <SettingsPath
        label={t("devices.onTheIphone")}
        segments={[
          t("devices.iphone.path.settings"),
          t("devices.iphone.path.developer"),
          t("devices.iphone.path.uiAutomation"),
        ]}
      />
    ),
    ...(helperReason === "helper_untrusted"
      ? {
          helper: (
            <SettingsPath
              label={t("devices.onTheIphone")}
              segments={[
                t("devices.iphone.path.settings"),
                t("devices.iphone.path.general"),
                t("devices.iphone.path.deviceManagement"),
              ]}
            />
          ),
        }
      : {}),
  };
  const note = (
    <span className="ac-iconline small muted">
      <Icon name="info" size={14} />
      <span>{t("devices.iphone.noMacNote")}</span>
    </span>
  );
  return (
    <>
      <DialogBody>
        <p className="small muted">{t("devices.iphone.lead")}</p>
        {macs.length === 0 ? (
          <NeedsComputer text={t("devices.iphone.noMac")} onConnect={onConnectComputer} />
        ) : (
          <>
            <Field label={t("devices.iphone.mac")} id="dv-iphone-mac">
              <HostSelect hosts={macs} value={mac?.id ?? ""} onChange={setPicked} id="dv-iphone-mac" />
            </Field>
            {mac?.status.kind === "offline" ? (
              <p className="setup-progress setup-progress--line ac-iconline" role="status">
                <Icon name="dash" size={14} />
                <span>{t("devices.android.hostOffline", { computer: mac.name })}</span>
              </p>
            ) : (
              <ol className="dv-steps">
                {IPHONE_STEPS.map((s) => (
                  <Step key={s} state={states[s]} title={t(`devices.iphone.steps.${s}`)} text={text[s]}>
                    {states[s] === "current" || states[s] === "needs" ? more[s] : null}
                  </Step>
                ))}
              </ol>
            )}
            {ready && phone && (
              <p className="setup-progress setup-progress--line ac-iconline" role="status">
                <Icon name="check" size={14} />
                <span>{t("devices.iphone.ready", { name: phone.name })}</span>
              </p>
            )}
          </>
        )}
      </DialogBody>
      <FlowFooter onClose={onClose} onBack={onBack} note={note}>
        {ready ? (
          <Button variant="primary" onClick={onClose}>
            {t("devices.done")}
          </Button>
        ) : undefined}
      </FlowFooter>
    </>
  );
}
