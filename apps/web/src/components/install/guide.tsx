import { type DesktopRelease, useDesktopLatest } from "@agenteschat/client";
import { desktopTargetOf, type Platform, platformOf } from "@agenteschat/client/lib/machines";
import { Button, Icon } from "@agenteschat/ui";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { DownloadButtons } from "@/components/devices/parts";
import { CommandBlock } from "@/components/machine-bits";
import { SCENE_H, SCENE_W, Scene, type SceneId } from "./scenes";
import "./install.css";

/*
 * Installing the desktop app the first time (ADR 0036 §10). While the app is in beta the Mac build isn't notarized
 * and the Windows installer isn't signed, so the first open asks once, in a place nobody finds alone. The same steps
 * show under every download (`DownloadWithGuide`: frames that move on by themselves) and on the public `/download`
 * page (`InstallSteps`: every step with its drawing).
 */

/** The systems as the `/download` page's address names them (`?system=`). */
export type InstallSystem = Platform;
export const INSTALL_SYSTEMS: InstallSystem[] = ["mac", "windows", "linux"];

export function systemOfParam(value: unknown): InstallSystem | undefined {
  return INSTALL_SYSTEMS.find((s) => s === value);
}

/** A system's build, as `/api/desktop/latest` asks for it (one universal Mac build; x64 elsewhere). */
export function buildTarget(system: InstallSystem) {
  return system === "mac"
    ? ({ target: "darwin", arch: "aarch64" } as const)
    : ({ target: system, arch: "x86_64" } as const);
}

/** The system this page is open on, or none (a phone, an ARM Linux). */
export function systemHere(): InstallSystem | null {
  if (typeof navigator === "undefined") return null;
  return desktopTargetOf(navigator.userAgent) ? platformOf(navigator.userAgent) : null;
}

/** What `xattr` clears on a Mac when the button never shows: the mark every browser download carries. */
export const QUARANTINE_FIX = "xattr -dr com.apple.quarantine /Applications/agentes.chat.app";
/** System Settings › Privacy & Security, scrolled to Security (a Mac's browser asks before it opens it). */
const MAC_SECURITY = "x-apple.systempreferences:com.apple.preference.security?Security";

interface Step {
  scene: SceneId;
  /** The step in one line (under the frames). */
  text: string;
  /** The step in full (the page); `text` when absent. */
  long?: string;
  sub?: string;
  /** `sub` for the frames, where there's room for less. */
  short?: string;
  cmd?: string;
  /** Offer to open System Settings there (on a Mac only). */
  settings?: boolean;
}

/** The line over the frames: the app is in beta, so the system asks once (`<b>` marks the first sentence). */
type WhyKey = "install.mac.why" | "install.windows.why" | "install.linux.why";

function useSteps(system: InstallSystem, version: string): { why: WhyKey; steps: Step[] } {
  const { t } = useTranslation();
  if (system === "mac")
    return {
      why: "install.mac.why",
      steps: [
        { scene: "macDrag", text: t("install.mac.drag"), long: t("install.mac.dragLong") },
        { scene: "macBlocked", text: t("install.mac.blocked"), sub: t("install.mac.blockedSub") },
        {
          scene: "macSettings",
          text: t("install.mac.settings"),
          long: t("install.mac.settingsLong"),
          sub: t("install.mac.settingsSub"),
          short: t("install.mac.settingsShort"),
          settings: true,
        },
        {
          scene: "macConfirm",
          text: t("install.mac.confirm"),
          long: t("install.mac.confirmLong"),
          sub: t("install.mac.done"),
        },
      ],
    };
  if (system === "windows")
    return {
      why: "install.windows.why",
      steps: [
        { scene: "winKeep", text: t("install.windows.keep") },
        { scene: "winMore", text: t("install.windows.more"), long: t("install.windows.moreLong") },
        {
          scene: "winRun",
          text: t("install.windows.run"),
          long: t("install.windows.runLong"),
          sub: t("install.windows.done"),
        },
      ],
    };
  return {
    why: "install.linux.why",
    steps: [
      {
        scene: "linuxApt",
        text: t("install.linux.apt"),
        long: t("install.linux.aptLong"),
        cmd: `sudo apt install ./agentes_${version || "<version>"}_amd64.deb`,
      },
      { scene: "linuxOpen", text: t("install.linux.open") },
    ],
  };
}

/**
 * A scene scaled into its box. `zoom` > 1 looks closer, centred on the thing to click (measured from the drawing, so
 * a longer translation still lands on it); 1 shows the whole desktop.
 */
function FitScene({ id, version, zoom = 1 }: { id: SceneId; version: string; zoom?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const shot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = box.current;
    const s = shot.current;
    if (!b || !s) return;
    const place = () => {
      const w = b.clientWidth;
      const h = b.clientHeight;
      if (!w || !h) return;
      const k = Math.max(w / SCENE_W, h / SCENE_H) * zoom;
      let fx = SCENE_W / 2;
      let fy = SCENE_H / 2;
      const hit = zoom > 1 ? s.querySelector(".isc-hl") : null;
      if (hit) {
        s.style.transform = "none";
        const r = s.getBoundingClientRect();
        const a = r.width / SCENE_W || 1; // an ancestor's own scale (a dialog opening)
        const c = hit.getBoundingClientRect();
        fx = (c.left + c.width / 2 - r.left) / a;
        fy = (c.top + c.height / 2 - r.top) / a;
      }
      const tx = Math.min(0, Math.max(w - SCENE_W * k, w / 2 - fx * k));
      const ty = Math.min(0, Math.max(h - SCENE_H * k, h / 2 - fy * k));
      s.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(b);
    void document.fonts?.ready.then(place);
    return () => ro.disconnect();
  }, [zoom]);
  return (
    <div ref={box} className="isc-box" aria-hidden="true">
      <div ref={shot} className="isc-fit">
        <Scene id={id} version={version} />
      </div>
    </div>
  );
}

/** How close each frame looks at its drawing. */
const ZOOM: Record<SceneId, number> = {
  macDrag: 1,
  macBlocked: 1.25,
  macSettings: 1.3,
  macConfirm: 1.05,
  winKeep: 1.2,
  winMore: 1.1,
  winRun: 1.1,
  linuxApt: 1.05,
  linuxOpen: 1.1,
};

/**
 * The steps as frames under a download: why the system asks (beta), one drawing at a time with its line, moving on
 * by themselves (a bar fills; hovering pauses it; the bars and arrows move it by hand), and the full page.
 */
export function InstallFrames({ system, release }: { system: InstallSystem; release: DesktopRelease }) {
  const { t } = useTranslation();
  const { why, steps } = useSteps(system, release.version);
  const [at, setAt] = useState(0);
  const go = (i: number) => setAt((i + steps.length) % steps.length);
  const step = steps[at] ?? steps[0];
  if (!step) return null;
  const name = t(`machines.os.${buildTarget(system).target}`);
  return (
    <section className="ifr" aria-label={t("install.frames", { system: name })}>
      <p className="ifr__lead">
        <Icon name="info" size={16} />
        <span>
          <Trans i18nKey={why} components={{ b: <strong /> }} />
        </span>
      </p>
      <div className="ifr__pic">
        {steps.map((s, i) => (
          <div key={s.scene} className="ifr__frame" data-on={i === at || undefined}>
            <FitScene id={s.scene} version={release.version} zoom={ZOOM[s.scene]} />
          </div>
        ))}
      </div>
      <div className="ifr__bars" style={{ "--n": steps.length } as CSSProperties}>
        {steps.map((s, i) => (
          <button
            key={s.scene}
            type="button"
            className="ifr__bar"
            aria-label={t("install.step", { n: i + 1 })}
            aria-current={i === at ? "step" : undefined}
            data-done={i < at || undefined}
            data-on={i === at || undefined}
            onClick={() => go(i)}
          >
            {/* A new key restarts the fill when the same step is shown again. */}
            <i key={i === at ? `on-${at}` : "off"} onAnimationEnd={() => go(at + 1)} />
          </button>
        ))}
      </div>
      <div className="ifr__cap" aria-live="polite">
        <span className="ifr__n">{at + 1}</span>
        <span className="ifr__text">
          {step.text}
          {(step.short ?? step.sub) && <small>{step.short ?? step.sub}</small>}
        </span>
        <span className="ifr__nav">
          <Button size="sm" variant="ghost" iconOnly icon="chevronLeft" aria-label={t("install.previous")} onClick={() => go(at - 1)} />
          <Button size="sm" variant="ghost" iconOnly icon="chevronRight" aria-label={t("install.next")} onClick={() => go(at + 1)} />
        </span>
      </div>
      <a className="ifr__more ac-link" href={`/download?system=${system}`} target="_blank" rel="noreferrer">
        {t("install.fullGuide")}
        <Icon name="arrowRight" size={14} />
      </a>
    </section>
  );
}

/**
 * "Download for …" and, under it, the frames of the system picked (this computer's, or the one chosen in Other
 * systems). Nothing under it while that system has no build.
 */
export function DownloadWithGuide({
  primary = false,
  onLine,
}: {
  primary?: boolean;
  onLine?: (shell: "unix" | "windows") => void;
}) {
  const [system, setSystem] = useState<InstallSystem | null>(systemHere);
  const target = buildTarget(system ?? "mac");
  const build = useDesktopLatest(target.target, target.arch, system !== null);
  return (
    <>
      <span className="dv-step__acts">
        <DownloadButtons primary={primary} onLine={onLine} onPick={setSystem} />
      </span>
      {system && build.data && <InstallFrames key={system} system={system} release={build.data} />}
    </>
  );
}

/** Every step of a system with its drawing, in a numbered line (the `/download` page). */
export function InstallSteps({ system, release }: { system: InstallSystem; release: DesktopRelease | null }) {
  const { t } = useTranslation();
  const version = release?.version ?? "";
  const { steps } = useSteps(system, version);
  const onMac = typeof navigator !== "undefined" && platformOf(navigator.userAgent) === "mac";
  return (
    <>
      <ol className="ist">
        {steps.map((s, i) => (
          <li key={s.scene} className="ist__step">
            <div className="ist__text">
              <span className="ist__n">{i + 1}</span>
              <div>
                <p className="ist__line">{s.long ?? s.text}</p>
                {s.sub && <p className="ist__sub">{s.sub}</p>}
                {s.cmd && <CommandBlock command={s.cmd} copied={t("install.copied")} />}
                {s.settings && onMac && (
                  <Button asChild size="sm">
                    <a href={MAC_SECURITY}>
                      <Icon name="settings" />
                      {t("install.mac.openSettings")}
                    </a>
                  </Button>
                )}
              </div>
            </div>
            <div className="ist__shot">
              <FitScene id={s.scene} version={version} />
            </div>
          </li>
        ))}
      </ol>
      {system === "mac" && (
        <div className="ist__stuck">
          <Icon name="question" />
          <div>
            <p className="ist__line">{t("install.mac.stuckTitle")}</p>
            <p className="ist__sub">{t("install.mac.stuckText")}</p>
            <CommandBlock command={QUARANTINE_FIX} copied={t("install.copied")} />
          </div>
        </div>
      )}
    </>
  );
}
