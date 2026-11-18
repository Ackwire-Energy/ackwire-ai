import {
  CLOUD_SERVER,
  checkServer,
  HOSTING_FOOT,
  HOSTING_POINTS,
  helpUrl,
  normalizeServer,
  serverHost,
} from "@agenteschat/client/lib/server";
import { DOWNLOAD_URL } from "@agenteschat/i18n/docs";
import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  type Hosting,
  HostingScene,
  Icon,
  Input,
  OptionList,
} from "@agenteschat/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import "./hosting.css";

/** What a server of one's own looks like typed: the example in the address field. */
const EXAMPLE_HOST = "agentes.example.com";

/** The chosen option's lines: what it gives (the Cloud) or what it asks of you (your own server). */
function Points({ hosting }: { hosting: Hosting }) {
  const { t } = useTranslation();
  return (
    <span className="hosting-points">
      {HOSTING_POINTS[hosting].map(([key, icon]) => (
        <span key={key} className="ac-iconline">
          <Icon name={icon} size={14} />
          {t(key)}
        </span>
      ))}
      <span className="hosting-points__foot">{t(HOSTING_FOOT[hosting])}</span>
    </span>
  );
}

/**
 * "Onde fica o seu workspace?": the Cloud, recommended and chosen by default, against a server of one's own (free,
 * open source), each said by what it takes on. The sky turns to night and the team falls asleep on one's own server,
 * as they do when it is off. The Cloud goes to its sign-in; one's own server takes its address, checked before the
 * page goes there. `here`: the server this page is on.
 */
export function HostingSheet({
  open,
  onOpenChange,
  here,
  cloud,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  here: string;
  cloud: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [pick, setPick] = useState<Hosting>(cloud ? "cloud" : "own");
  const [address, setAddress] = useState(cloud ? "" : serverHost(here));
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [getting, setGetting] = useState(false);

  const go = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pick === "cloud") {
      if (cloud) onOpenChange(false);
      else window.location.assign(`${CLOUD_SERVER}/login`);
      return;
    }
    const server = normalizeServer(address);
    if (!server) return setError(t("hosting.own.invalid"));
    if (server === here) return onOpenChange(false);
    setChecking(true);
    const check = await checkServer(server);
    setChecking(false);
    if (!check.ok) return setError(t("hosting.own.unreachable", { host: serverHost(server) }));
    window.location.assign(`${check.server}/login`);
  };

  const name = (hosting: Hosting) =>
    hosting === "cloud" ? (
      <>
        {t("hosting.cloud.name")}
        <Chip tone="info" className="hosting-tag">
          {t("hosting.recommended")}
        </Chip>
      </>
    ) : (
      <>
        {t("hosting.own.name")}
        <Chip className="hosting-tag">{t("hosting.free")}</Chip>
      </>
    );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("hosting.title")}
        closeLabel={t("common.close")}
        width={440}
        bare
        className="hosting-sheet"
      >
        <form onSubmit={(e) => void go(e)} noValidate>
          <div className="hosting-sheet__hero">
            <HostingScene hosting={pick} />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              className="hosting-sheet__close"
              aria-label={t("common.close")}
              onClick={() => onOpenChange(false)}
            />
          </div>
          <p className="hosting-sheet__title" aria-hidden="true">
            {t("hosting.title")}
          </p>
          <DialogBody className="hosting-sheet__body">
            <OptionList<Hosting>
              aria-label={t("hosting.title")}
              value={pick}
              attached
              onValueChange={(v) => {
                setPick(v);
                setError(null);
              }}
              options={(["cloud", "own"] as const).map((h) => ({
                value: h,
                title: name(h),
                description: pick === h ? <Points hosting={h} /> : t(`hosting.${h}.short`),
                ...(h === "own"
                  ? {
                      children: (
                        <Field label={t("hosting.own.address")} error={error ?? undefined}>
                          <Input
                            value={address}
                            onChange={(e) => {
                              setAddress(e.target.value);
                              setError(null);
                            }}
                            placeholder={EXAMPLE_HOST}
                            inputMode="url"
                            autoComplete="url"
                            spellCheck={false}
                            invalid={error !== null}
                            autoFocus
                          />
                        </Field>
                      ),
                    }
                  : {}),
              }))}
            />
            {pick === "own" && (
              <p className="hosting-sheet__none">
                {t("hosting.own.none")}{" "}
                <button type="button" className="ac-link" onClick={() => setGetting(true)}>
                  {t("hosting.own.noneLink")}
                </button>
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="submit" variant="primary" size="lg" block loading={checking}>
              {pick === "cloud" ? t("hosting.cloud.enter") : t("hosting.own.connect")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      <GetServerDialog
        open={getting}
        onOpenChange={setGetting}
        locale={i18n.language}
        onCloud={() => {
          setGetting(false);
          setPick("cloud");
          setError(null);
        }}
      />
    </>
  );
}

/**
 * "Ainda não tem um?": the two ways to have a server of one's own, each with where it goes on the docs site (a
 * server for a team, always on; or the desktop app on one's own computer, no Docker), and a quiet way back to the
 * Cloud for whoever would rather not look after anything.
 */
export function GetServerDialog({
  open,
  onOpenChange,
  locale,
  onCloud,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: string;
  onCloud: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("hosting.get.title")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody className="hosting-get">
        <section className="hosting-get__way">
          <span className="hosting-get__head ac-iconline">
            <Icon name="globe" size={16} />
            <b>{t("hosting.get.server")}</b>
          </span>
          <span className="hosting-get__text">{t("hosting.get.serverText")}</span>
          <span className="hosting-get__acts ac-acts">
            <Button asChild size="sm">
              <a href={helpUrl("install-on-a-server", locale)} target="_blank" rel="noopener noreferrer">
                {t("hosting.get.serverAction")}
              </a>
            </Button>
          </span>
        </section>
        <section className="hosting-get__way">
          <span className="hosting-get__head ac-iconline">
            <Icon name="computer" size={16} />
            <b>{t("hosting.get.here")}</b>
          </span>
          <span className="hosting-get__text">{t("hosting.get.hereText")}</span>
          <span className="hosting-get__acts ac-acts">
            <Button asChild size="sm" variant="primary">
              <a href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
                {t("hosting.get.download")}
              </a>
            </Button>
            <Button asChild size="sm">
              <a href={helpUrl("run-on-your-computer", locale)} target="_blank" rel="noopener noreferrer">
                {t("hosting.get.how")}
              </a>
            </Button>
          </span>
        </section>
      </DialogBody>
      <DialogFooter
        note={
          <span>
            {t("hosting.get.foot")}{" "}
            <button type="button" className="ac-link" onClick={onCloud}>
              {t("hosting.get.footLink")}
            </button>
          </span>
        }
      />
    </Dialog>
  );
}
