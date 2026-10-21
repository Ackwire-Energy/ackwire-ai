import type { BrowserHandoff } from "@agenteschat/client";
import {
  handoffFuse,
  handoffMinutesLeft,
  isWaitingHandoff,
  keys,
  useApi,
  useBrowserHandoffMutations,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, ExpiryFuse, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { AgentAvatar } from "../AgentAvatar";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { BrowserCard } from "./BrowserCard";
import { useBrowserCardRequest } from "./open";
import "./browser.css";

/** Re-renders every `ms` while `on` (a countdown). */
export function useTick(on: boolean, ms = 15_000) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [on, ms]);
}

/** The newest view of a request: what the cache heard (an action, the realtime event), else the card's meta. */
export function useCurrentHandoff(orgId: string, handoff: BrowserHandoff) {
  const api = useApi();
  // Listens to the cache entry without fetching: the card's meta is where it starts.
  const query = useQuery({
    queryKey: keys.browserHandoff(orgId, handoff.id),
    queryFn: () => api.browser.handoff(orgId, handoff.id),
    enabled: false,
    placeholderData: handoff,
  });
  return query.data ?? handoff;
}

/**
 * An agent asks a person for help in its browser (`browser_ask_person`,
 * ADR 0040 §6): the request, the time left, "Abrir" to the live view; who is
 * helping; and how it ended. Same family as the approval card.
 */
export function BrowserHandoffCard({ handoff }: { handoff: BrowserHandoff }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const current = useCurrentHandoff(org.id, handoff);
  const actions = useBrowserHandoffMutations(org.id);
  const agent = dir.agentById.get(current.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(t, name);
  const waiting = isWaitingHandoff(current);
  const active = current.status === "active";
  useTick(waiting);
  const mineInControl = active && current.controllerUserId === me.user.id;
  const helper = current.controllerUserId ? dir.memberById.get(current.controllerUserId)?.name : undefined;
  const people = [current.requestedForUserId, agent?.ownerUserId ?? null]
    .filter((id, i, all): id is string => Boolean(id) && all.indexOf(id) === i)
    .map((id) => (id === me.user.id ? null : dir.memberById.get(id)?.name))
    .filter(Boolean) as string[];
  const settled = !waiting && !active;
  const status = current.status === "pending" ? "expired" : current.status;
  const minutes = handoffMinutesLeft(current);
  // The agent's browser opens right here, under the request.
  const [here, setHere] = useState(false);
  const take = () =>
    actions.takeControl.mutate(current.id, {
      onSuccess: () => setHere(true),
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
          "error",
        ),
    });
  // A notification asked for this request: take it (or show it, when it's already mine).
  const asked = useBrowserCardRequest({ handoffId: current.id });
  const latest = useRef({ take, waiting });
  latest.current = { take, waiting };
  useEffect(() => {
    if (asked === null) return;
    if (latest.current.waiting) latest.current.take();
    else setHere(true);
  }, [asked]);
  const showBrowser = (here && (waiting || active)) || mineInControl;
  const time = current.resolvedAt ? formatTime(i18n.language, current.resolvedAt) : "";
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div
        className={settled ? "brw-rq brw-rq--settled" : "brw-rq"}
        role="group"
        aria-label={t("browser.card.group", g)}
      >
        <span className="brw-rq__face">
          <AgentAvatar
            agentId={current.agentId}
            size="md"
            state={waiting ? "waiting" : active ? "thinking" : "idle"}
            name={name}
          />
        </span>
        <div className="brw-rq__meta">
          <b>{name}</b>
          {settled ? (
            <span>
              {t(
                status === "done"
                  ? "browser.card.settledDone"
                  : status === "failed"
                    ? "browser.card.settledFailed"
                    : status === "cancelled"
                      ? "browser.card.settledCancelled"
                      : "browser.card.settledExpired",
              )}
            </span>
          ) : (
            <span>
              {people.length > 0
                ? t("browser.card.asked", { people: people.join(t("notifications.and")) })
                : t("browser.card.askedShort")}
            </span>
          )}
          <span className="brw-grow" />
          {waiting && minutes !== null && (
            <>
              <Icon name="clock" size={14} />
              <span>{t("browser.card.left", { count: minutes })}</span>
            </>
          )}
          {active && (
            <>
              <Icon name="person" size={14} />
              <span>
                {mineInControl ? t("browser.card.helpingYou") : t("browser.card.helping", { name: helper ?? "" })}
              </span>
            </>
          )}
        </div>
        <p className="brw-rq__title">{current.instructions}</p>
        <div className="brw-rq__body">
          <div className="brw-exact">
            <span className="brw-exact__ic">
              <Icon name="globe" size={16} />
            </span>
            <span className="brw-exact__t">
              <b>{t("browser.card.where", g)}</b>
              {agent?.handle && <small>@{agent.handle}</small>}
            </span>
          </div>
          {status === "done" && settled && (
            <div className="brw-rq__res brw-rq__res--ok">
              <Icon name="check" size={16} />
              {current.controllerUserId === me.user.id
                ? t("browser.card.doneByYou", { time, ...g, agent: name })
                : t("browser.card.doneBy", { ...g, time, agent: name, name: helper ?? "" })}
            </div>
          )}
          {status === "failed" && settled && (
            <>
              <div className="brw-rq__res">
                <Icon name="close" size={16} />
                {t("browser.card.failed")}
              </div>
              {current.note && <div className="brw-rq__why">“{current.note}”</div>}
            </>
          )}
          {status === "expired" && settled && (
            <div className="brw-rq__res">
              <Icon name="clock" size={16} />
              {t("browser.card.expired", g)}
            </div>
          )}
          {status === "cancelled" && settled && (
            <div className="brw-rq__res">
              <Icon name="close" size={16} />
              {t("browser.card.cancelled")}
            </div>
          )}
          {waiting && !showBrowser && (
            <div className="brw-rq__acts">
              <Button variant="primary" icon="globe" loading={actions.takeControl.isPending} onClick={take}>
                {t("browser.inCard.openHere")}
              </Button>
              <span className="brw-rq__hint">{t("browser.inCard.openHereHint")}</span>
            </div>
          )}
          {active && !showBrowser && (
            <div className="brw-rq__acts">
              <Button icon="globe" onClick={() => setHere(true)}>
                {t("browser.card.watch")}
              </Button>
            </div>
          )}
          {showBrowser && (
            <div className="brw-rq__res">
              <Icon name="person" size={16} />
              {mineInControl
                ? t("browser.inCard.helpingHere")
                : t("browser.inCard.helpingOther", { person: helper ?? "" })}
            </div>
          )}
        </div>
        {waiting && <ExpiryFuse left={handoffFuse(current)} color={colorOf(agent)} />}
      </div>
      {showBrowser && (
        <BrowserCard
          agentId={current.agentId}
          name={name}
          handoff={current}
          defaultOpen
          onSettled={() => setHere(false)}
        />
      )}
    </>
  );
}
