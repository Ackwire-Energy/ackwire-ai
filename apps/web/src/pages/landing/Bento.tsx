import { Avatar, Button, Chip, cx, Icon, type IconName } from "@agenteschat/ui";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLanding } from "./context";
import { AGENTS, type AgentKey, PEOPLE, TERM, TERM_LAST_WAIT } from "./data";
import { useFormat } from "./format";
import { useRunner } from "./hooks";
import { SampleAgent } from "./LpAvatar";
import { RichText } from "./rich";

type Ev = "report" | "summary" | "agenda" | "costs";
const WEEK: [AgentKey, Ev][][] = [
  [
    ["teo", "report"],
    ["lia", "summary"],
  ],
  [["lia", "summary"]],
  [
    ["lia", "summary"],
    ["bia", "agenda"],
  ],
  [["lia", "summary"]],
  [
    ["lia", "summary"],
    ["teo", "costs"],
  ],
  [],
  [],
];

/** "Um lugar só": routines, the agent's computer, memory, Drive, Issues and the rest. */
export function Bento() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const lia = AGENTS.lia.name;
  const [lesson, setLesson] = useState<"yes" | "no" | null>(null);
  return (
    <section className="lp-sec lp-sec--flush">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.bento.eyebrow")}</span>
          <h2>{t("landing.bento.title")}</h2>
        </div>
        <div className="lp-bento">
          <Tile span={4} icon="routines" title={t("landing.bento.routines")}>
            <p>{t("landing.bento.routinesText")}</p>
            <div className="lp-week">
              {WEEK.map((events, i) => (
                <div className={cx("lp-day", i === 2 && "lp-today")} key={fmt.weekday(i)}>
                  <small>{fmt.weekday(i)}</small>
                  {events.map(([agent, ev]) => (
                    <span className="lp-ev" key={`${agent}-${ev}`}>
                      <SampleAgent agent={agent} px={14} />
                      <span>{t(`landing.bento.ev.${ev}`)}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </Tile>
          <Tile span={2} icon="code" title={t("landing.bento.computer")}>
            <p>{t("landing.bento.computerText")}</p>
            <Terminal />
          </Tile>
          <Tile span={2} icon="book" title={t("landing.bento.memory")}>
            <div className="lp-lesson">
              {lesson === null ? (
                <>
                  <div className="lp-lesson-head">
                    <SampleAgent agent="lia" size="sm" />
                    <b>{t("landing.bento.lessonBy", { agent: lia })}</b>
                  </div>
                  <span className="lp-muted">
                    <RichText text={t("landing.bento.lesson")} />
                  </span>
                  <div className="lp-lesson-acts">
                    <Button variant="primary" size="sm" onClick={() => setLesson("yes")}>
                      {t("landing.bento.makeRule")}
                    </Button>
                    <Button size="sm" onClick={() => setLesson("no")}>
                      {t("landing.bento.discard")}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Chip
                    icon={lesson === "yes" ? "check" : "close"}
                    tone={lesson === "yes" ? "done" : "neutral"}
                    className="lp-start"
                  >
                    {lesson === "yes" ? t("landing.bento.ruled", { agent: lia }) : t("landing.bento.discarded")}
                  </Chip>
                  <span className="lp-muted">
                    {lesson === "yes"
                      ? t("landing.bento.ruledText", { agent: lia })
                      : t("landing.bento.discardedText", { agent: lia })}
                  </span>
                </>
              )}
            </div>
          </Tile>
          <Tile span={2} icon="drive" title={t("landing.bento.drive")}>
            <p>{t("landing.bento.driveText")}</p>
            <div className="lp-files3">
              <div>
                <span className="lp-thumb">
                  {[45, 62, 51, 88].map((h) => (
                    <i key={h} style={{ height: `${h}%` }} />
                  ))}
                </span>
                <small>{t("landing.bento.weekly")}</small>
              </div>
              <div>
                <span className="lp-thumb lp-thumb--doc">
                  <i style={{ width: "70%" }} />
                  <i />
                  <i style={{ width: "85%" }} />
                  <i style={{ width: "55%" }} />
                </span>
                <small>{t("landing.bento.announce")}</small>
              </div>
              <div>
                <span className="lp-thumb lp-thumb--diff">
                  <i />
                  <i />
                  <i style={{ width: "80%" }} />
                  <i style={{ width: "60%" }} />
                </span>
                <small>{t("landing.bento.pr")}</small>
              </div>
            </div>
          </Tile>
          <Tile span={2} icon="issues" title={t("landing.bento.issues")}>
            <div className="lp-issues">
              <div className="lp-issue">
                <SampleAgent agent="lia" size="xs" />
                <span className="lp-issue-t">{t("landing.bento.issue88")}</span>
                <span className="lp-issue-n">#88</span>
              </div>
              <div className="lp-issue">
                <Avatar name={PEOPLE.rafael.name} initials={PEOPLE.rafael.initials} size="xs" />
                <span className="lp-issue-t">{t("landing.bento.issue74")}</span>
                <span className="lp-issue-n">#74</span>
              </div>
              <div className="lp-issue">
                <SampleAgent agent="teo" size="xs" />
                <span className="lp-issue-t">{t("landing.bento.issue91")}</span>
                <span className="lp-issue-n">#91</span>
              </div>
            </div>
          </Tile>
          <article className="lp-tile lp-span6 lp-tile--row">
            <h3>{t("landing.bento.also")}</h3>
            <div className="lp-also">
              <Chip icon="message">{t("landing.bento.forum")}</Chip>
              <Chip icon="book">{t("landing.bento.wiki")}</Chip>
              <Chip icon="calendar">{t("landing.bento.calendar")}</Chip>
              <Chip icon="search">{t("landing.bento.search")}</Chip>
              <Chip icon="person">{t("landing.bento.dms")}</Chip>
              <Chip icon="bolt">{t("landing.bento.webhooks")}</Chip>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function Tile({ span, icon, title, children }: { span: 2 | 4; icon: IconName; title: string; children: ReactNode }) {
  return (
    <article className={cx("lp-tile", span === 4 ? "lp-span4" : "lp-span2")}>
      <div className="lp-th">
        <span className="lp-ic">
          <Icon name={icon} />
        </span>
        <h3>{title}</h3>
      </div>
      {children}
    </article>
  );
}

/** The agent's computer: clone, test, open a PR, in a loop (all at once with reduced motion). */
function Terminal() {
  const { t } = useTranslation();
  const { reduced } = useLanding();
  const runner = useRunner();
  const total = TERM.length + 1;
  const [lines, setLines] = useState(reduced ? total : 0);
  useEffect(() => {
    if (reduced) return;
    runner.start(async (r) => {
      while (r.alive()) {
        setLines(0);
        for (let i = 0; i < total; i++) {
          setLines(i + 1);
          await r.sleep(TERM[i]?.wait ?? TERM_LAST_WAIT);
          if (!r.alive()) return;
        }
      }
    });
  }, [reduced, runner, total]);
  const all = [
    ...TERM.map((l) => l.parts),
    [
      ["c", "→"],
      ["", ` ${t("landing.bento.prOpened")}`],
    ] as [string, string][],
  ];
  return (
    <div className="lp-term">
      {all.slice(0, lines).map((parts, i) => (
        <Fragment key={parts.map((p) => p[1]).join("")}>
          {i > 0 && "\n"}
          {parts.map(([cls, text]) =>
            cls ? (
              <span className={`lp-term-${cls}`} key={text}>
                {text}
              </span>
            ) : (
              <Fragment key={text}>{text}</Fragment>
            ),
          )}
        </Fragment>
      ))}
    </div>
  );
}
