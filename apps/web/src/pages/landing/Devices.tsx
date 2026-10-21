import {
  Avatar,
  cx,
  Icon,
  LogoMark,
  Message,
  MessageText,
  PixelSpinner,
  Reaction,
  Reactions,
  Segmented,
} from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CAST, ORGS, PEOPLE, SHOP_CHANNELS } from "./cast";
import { useLanding } from "./context";
import { useFormat } from "./format";
import { useJoy, useRunner, useVisible } from "./hooks";
import { HoldButton } from "./kit/Approval";
import { MockSidebar } from "./kit/MockSidebar";
import { LpAvatar } from "./LpAvatar";
import { PixelSky } from "./PixelSky";
import { HERO_SKY } from "./sky";
import "./devices.css";

type Device = "phone" | "mac" | "web";
const DEVICES: Device[] = ["phone", "mac", "web"];

/** The design system has no phone icon; same 20px grid and stroke as `Icon`. */
function PhoneIcon() {
  return (
    <svg viewBox="0 0 20 20" className="ac-icon" style={{ width: 16, height: 16 }} aria-hidden="true">
      <rect x="6" y="2.5" width="8" height="15" rx="2" />
      <path d="M9 15h2" />
    </svg>
  );
}
const TAB_ICON: Record<Device, ReactNode> = {
  phone: <PhoneIcon />,
  mac: <Icon name="computerMac" size={16} />,
  web: <Icon name="globe" size={16} />,
};

/**
 * "06 · Em todo lugar": the same workspace on the phone (approve a rollback
 * from the lock screen), on the Mac (the agent in the notch's wings) and in
 * the browser. One stage height for the three, so switching never moves the page.
 */
export function Devices() {
  const { t } = useTranslation();
  const [device, setDevice] = useState<Device>("phone");
  const stage = useRef<HTMLDivElement>(null);
  const live = useVisible(stage);
  return (
    <section className="lp-sec" id="lugares">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.devices.eyebrow")}</span>
          <h2>{t("landing.devices.title")}</h2>
          <p className="lp-lead">{t("landing.devices.lead")}</p>
        </div>
        <Segmented
          className="lp-dev-tabs"
          label={t("landing.devices.device")}
          value={device}
          onValueChange={setDevice}
          options={DEVICES.map((d) => ({
            value: d,
            label: (
              <>
                {TAB_ICON[d]}
                {t(`landing.devices.tabs.${d}`)}
              </>
            ),
          }))}
        />
        <div className="lp-dev-stage" ref={stage}>
          {device === "phone" && <PhoneScreen live={live} />}
          {device === "mac" && <MacScreen live={live} />}
          {device === "web" && <WebScreen />}
        </div>
      </div>
    </section>
  );
}

type PushStep = "none" | "ask" | "approved" | "done";

/** The lock screen: Atlas asks for a rollback; hold to approve (it holds by itself if nobody does). */
function PhoneScreen({ live }: { live: boolean }) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const runner = useRunner();
  const joy = useJoy();
  const [step, setStep] = useState<PushStep>(reduced ? "ask" : "none");

  // The push arrives half a second after the screen is on view.
  useEffect(() => {
    if (reduced || !live) return;
    runner.start(async (run) => {
      await run.sleep(500);
      if (run.alive()) setStep("ask");
    });
    return () => runner.stop();
  }, [live, reduced, runner]);

  const approve = () => {
    joy.trigger(2000);
    if (reduced) {
      setStep("done");
      return;
    }
    runner.start(async (run) => {
      setStep("approved");
      await run.sleep(2400);
      if (!run.alive()) return;
      setStep("done");
      await run.sleep(4000);
      if (!run.alive()) return;
      // The next round: a fresh push half a second later.
      setStep("none");
      await run.sleep(500);
      if (run.alive()) setStep("ask");
    });
  };

  const atlas = CAST.atlas;
  const text =
    step === "ask"
      ? { b: t("landing.devices.phone.askTitle"), p: t("landing.devices.phone.askText") }
      : step === "approved"
        ? { b: t("landing.devices.phone.approvedTitle"), p: t("landing.devices.phone.approvedText") }
        : { b: t("landing.devices.phone.doneTitle"), p: t("landing.devices.phone.doneText") };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled sample screen, not a form group
    <div className="lp-dev-phone" role="group" aria-label={t("landing.devices.phone.label")}>
      <div className="lp-dev-phone__screen">
        <span className="lp-dev-phone__island" aria-hidden="true" />
        <div className="lp-dev-phone__time">{t("landing.devices.phone.time")}</div>
        <div className="lp-dev-phone__date">{t("landing.devices.phone.date")}</div>
        {step !== "none" && (
          <div className="lp-dev-push lp-enter" key={step}>
            <div className="lp-dev-push__h">
              <LpAvatar look={atlas.look} px={20} name={atlas.name} className={joy.className} />
              {t("landing.devices.phone.app")}
            </div>
            <b>{text.b}</b>
            <span>{text.p}</span>
            {step === "ask" && (
              <HoldButton
                onDone={approve}
                ms={1000}
                size="md"
                block
                auto={live && !reduced ? 4000 : undefined}
                className="lp-dev-push__hold"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type NotchStep = 0 | 1 | 2 | 3;
const NOTCH_MS: Record<NotchStep, number> = { 0: 2800, 1: 2800, 2: 4200, 3: 2800 };
const NOTCH_CAP = { 0: "idleCap", 1: "workingCap", 2: "approvalCap", 3: "doneCap" } as const;

/** The MacBook: quiet notch, an agent on its wings, an approval in the notch, then "done". */
function MacScreen({ live }: { live: boolean }) {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const devJoy = useJoy();
  const atlasJoy = useJoy();
  const [step, setStep] = useState<NotchStep>(reduced ? 2 : 0);
  const [approved, setApproved] = useState(false);
  const joyDev = devJoy.trigger;

  useEffect(() => {
    if (reduced || !live) return;
    let id: ReturnType<typeof setTimeout>;
    const show = (n: NotchStep) => {
      setStep(n);
      setApproved(false);
      if (n === 3) joyDev(2400);
      id = setTimeout(() => show(((n + 1) % 4) as NotchStep), NOTCH_MS[n]);
    };
    show(0);
    return () => clearTimeout(id);
  }, [live, reduced, joyDev]);

  const dev = CAST.dev;
  const wing = (key: "dev" | "atlas", joyClass: string) => (
    <>
      <LpAvatar
        look={CAST[key].look}
        px={18}
        name={CAST[key].name}
        state={key === "dev" && step === 1 ? "thinking" : undefined}
        className={joyClass}
      />
      {CAST[key].name}
    </>
  );
  return (
    <div className="lp-dev-mac-wrap">
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled sample screen, not a form group */}
      <div className="lp-dev-mac" role="group" aria-label={t("landing.devices.mac.label")}>
        <div className="lp-dev-wall" aria-hidden="true">
          <PixelSky options={{ pixel: 4, sprites: true, ...HERO_SKY }} />
        </div>
        <div className="lp-dev-mbar" aria-hidden="true">
          <span className="lp-dev-mbar__apple" />
          <b>{t("landing.devices.mac.app")}</b>
          <span className="lp-dev-mbar__dim">{t("landing.devices.mac.file")}</span>
          <span className="lp-dev-mbar__dim">{t("landing.devices.mac.edit")}</span>
          <span className="lp-dev-mbar__r">
            <LogoMark size={14} />
            <span>{t("landing.devices.mac.clock")}</span>
          </span>
        </div>
        <div className={cx("lp-dev-notch", (step === 1 || step === 3) && "is-open", step === 2 && "is-big")}>
          <div className="lp-dev-notch__wings">
            <span className="lp-dev-notch__w">
              {step === 1 || step === 3 ? wing("dev", devJoy.className) : null}
              {step === 2 ? wing("atlas", atlasJoy.className) : null}
            </span>
            <span className="lp-dev-notch__w">
              {step === 1 && (
                <>
                  <PixelSpinner size={14} color={dev.color} />
                  {t("landing.devices.mac.working")}
                </>
              )}
              {step === 2 &&
                (approved ? (
                  <>
                    <Icon name="check" size={14} />
                    {t("landing.devices.mac.approved")}
                  </>
                ) : (
                  t("landing.devices.mac.waiting")
                ))}
              {step === 3 && (
                <>
                  <Icon name="check" size={14} />
                  {t("landing.devices.mac.pr")}
                </>
              )}
            </span>
          </div>
          {step === 2 && (
            <div className="lp-dev-notch__panel">
              <div className="lp-dev-notch__action">{t("landing.devices.mac.action")}</div>
              {approved ? (
                <span className="lp-dev-notch__ok">
                  <Icon name="check" size={14} />
                  {t("landing.devices.mac.approved")}
                </span>
              ) : (
                <HoldButton
                  ms={900}
                  block
                  className="lp-dev-notch__hold"
                  onDone={() => {
                    setApproved(true);
                    atlasJoy.trigger();
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
      <p className="lp-dev-cap">{t(`landing.devices.mac.${NOTCH_CAP[step]}`)}</p>
    </div>
  );
}

/** The browser: the real sidebar and #produto, where Ada took a decision to the forum. */
function WebScreen() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const [liked, setLiked] = useState(false);
  const ada = CAST.ada;
  const marina = PEOPLE.marina;
  const channel = t("landing.channel.product");
  const adaAvatar = <LpAvatar look={ada.look} name={ada.name} />;
  const likes = 2 + (liked ? 1 : 0);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled sample screen, not a form group
    <div className="lp-dev-web" role="group" aria-label={t("landing.devices.web.label")}>
      <div className="lp-dev-web__bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>{`agentes.chat/${ORGS.shop.slug}/${channel}`}</span>
      </div>
      <div className="lp-dev-web__grid">
        <MockSidebar
          org="shop"
          channels={SHOP_CHANNELS.map((key) => ({ key }))}
          active="product"
          agents={["ada", "theo"]}
          states={{ ada: "thinking" }}
          tools={[]}
          tail={false}
          label={t("landing.devices.web.sidebar")}
          className="lp-dev-web__side"
        />
        <div className="lp-dev-web__chan">
          <div className="lp-dev-web__head">
            <Icon name="channel" size={16} />
            {channel}
          </div>
          <div className="lp-dev-web__feed">
            <Message
              avatar={<Avatar name={marina.name} initials={marina.initials} />}
              author={marina.short}
              time={fmt.time(9, 58)}
            >
              <MessageText>{t("landing.devices.web.ask")}</MessageText>
            </Message>
            <Message agent avatar={adaAvatar} author={ada.name} time={fmt.time(9, 59)}>
              <MessageText>{t("landing.devices.web.forum")}</MessageText>
              <div className="lp-dev-forum">
                <Icon name="message" size={16} />
                <div>
                  <b>{t("landing.devices.web.forumTitle")}</b>
                  <span>{t("landing.devices.web.forumMeta")}</span>
                </div>
              </div>
            </Message>
            <Message agent avatar={adaAvatar} author={ada.name} time={fmt.time(10, 9)}>
              <MessageText>{t("landing.devices.web.summary")}</MessageText>
              <Reactions label={t("landing.devices.web.reactions")}>
                <Reaction
                  pressed={liked}
                  count={likes}
                  label={t("landing.devices.web.like", { n: likes })}
                  onClick={() => setLiked((v) => !v)}
                >
                  <Icon name="thumbUp" size={14} />
                </Reaction>
              </Reactions>
            </Message>
          </div>
        </div>
      </div>
    </div>
  );
}
