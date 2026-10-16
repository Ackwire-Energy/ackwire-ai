import { Button, Card, CheckboxPill, Chip, Icon, SearchField, Segmented, Toolbar } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentSkills } from "@/api/queries";
import {
  LevelRow,
  levelText,
  ResourceIcon,
  resourceName,
  toolLabel,
  useConnectedById,
} from "@/components/AccessLevels";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { type AccessResource, asksAt, type Level } from "@/lib/access-levels";
import { CardHead, ChangedTag, useAgentEdit, WasLine } from "./context";
import { ReadOnlyNote } from "./pieces";

type AccessFilter = "all" | "on" | "ask";

/** Ferramentas e acesso: one level per connector and built-in area, and the skills. Saved with the save bar. */
export function AccessTab() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g, viewer, draft, setLevel, set, can, changeOf, resources, accessState, ownerFirst } = useAgentEdit();
  const items = useConnectedById();
  const skills = useAgentSkills(org.id, agent.id);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("all");
  const editable = can("levels");
  const level = (r: AccessResource) => draft.levels[r.id] ?? "none";
  const asksOf = (r: AccessResource) => asksAt(r, level(r)).map((x) => toolLabel(t, r, x));
  const needle = q.trim().toLowerCase();
  const shown = resources.filter((r) => {
    if (needle && !resourceName(t, r, items).toLowerCase().includes(needle)) return false;
    if (filter === "on") return level(r) !== "none";
    if (filter === "ask") return asksOf(r).length > 0;
    return true;
  });
  const count = {
    all: resources.length,
    on: resources.filter((r) => level(r) !== "none").length,
    ask: resources.filter((r) => asksOf(r).length > 0).length,
  };
  const connectors = shown.filter((r) => r.kind === "connector");
  const builtins = shown.filter((r) => r.kind === "builtin");
  const row = (r: AccessResource) => {
    const name = resourceName(t, r, items);
    const key = `levels:${r.id}`;
    const changed = Boolean(changeOf(key));
    return (
      <LevelRow
        key={r.id}
        icon={<ResourceIcon resource={r} items={items} name={name} />}
        name={name}
        description={levelText(t, r, level(r))}
        asks={asksOf(r)}
        levels={r.levels}
        value={level(r)}
        onChange={editable ? (l) => setLevel(r.id, l) : undefined}
        changed={changed}
        tag={changed ? <ChangedTag changeKey={key} /> : undefined}
        extra={changed ? <WasLine changeKey={key} /> : undefined}
      />
    );
  };
  const empty = (
    <div className="agp-empty">
      <b>{needle ? t("agentPage.access.noMatch", { q }) : t("agentPage.access.noneHere")}</b>
      <span className="small muted">{t("agentPage.access.clear")}</span>
    </div>
  );
  const allConnectors = (l: Level) => {
    for (const r of resources) if (r.kind === "connector" && r.levels.includes(l)) setLevel(r.id, l);
  };
  const library = skills.data ?? [];
  const enabled = new Set(draft.skills ?? []);
  const skillsEditable = can("skills") && draft.skills !== undefined;
  return (
    <>
      <ReadOnlyNote field="levels" />
      <Toolbar
        size="sm"
        className="agp-toolbar"
        search={
          <SearchField
            size="sm"
            aria-label={t("agentPage.access.search")}
            placeholder={t("agentPage.access.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")}
            clearLabel={t("filters.clearSearch")}
          />
        }
      >
        <Segmented
          size="sm"
          label={t("agentPage.access.filter")}
          value={filter}
          onValueChange={setFilter}
          options={(["all", "on", "ask"] as const).map((f) => ({
            value: f,
            label: t(`agentPage.access.filters.${f}`),
            count: count[f],
          }))}
        />
        {editable && resources.some((r) => r.kind === "connector") && (
          <span className="newag__quick agp-quick">
            {t("agentPage.access.allConnectors")}
            <Button size="sm" variant="ghost" onClick={() => allConnectors("none")}>
              {t("access.level.none")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => allConnectors("read")}>
              {t("agentPage.access.onlyRead")}
            </Button>
          </span>
        )}
      </Toolbar>
      <div className="agp-cols">
        <div className="agp-col">
          {accessState === "loading" ? (
            <Card className="agp-card">
              <LoadingLine width={260} />
            </Card>
          ) : accessState === "unavailable" ? (
            <Card className="agp-card">
              <span className="muted">{t("access.unavailable")}</span>
            </Card>
          ) : (
            <>
              <Card as="section" className="agp-card" aria-labelledby="ac-connectors">
                <CardHead
                  id="ac-connectors"
                  icon="plug"
                  title={t("agentPage.access.connectors", { org: org.name })}
                  action={<span className="small muted">{t("agentPage.access.oneLevel")}</span>}
                />
                {resources.every((r) => r.kind !== "connector") ? (
                  <p className="small muted">{t("access.noConnectors", { org: org.name })}</p>
                ) : connectors.length ? (
                  <ul className="level-list" aria-label={t("access.kind.connectors")}>
                    {connectors.map(row)}
                  </ul>
                ) : (
                  empty
                )}
                {viewer === "admin" && !needle && (
                  <Link
                    className="newag__addrow"
                    to="/org/$orgId/settings/$section"
                    params={{ orgId: org.id, section: "connectors" }}
                  >
                    <Icon name="plug" />
                    {t("newAgent.connectOther")}
                    <span className="newag__addrow-aside">{t("newAgent.opensConnectors")}</span>
                  </Link>
                )}
              </Card>
              <Card as="section" className="agp-card" aria-labelledby="ac-builtin">
                <CardHead
                  id="ac-builtin"
                  icon="agent"
                  title={t("agentPage.access.builtin")}
                  action={<span className="small muted">{t("agentPage.access.builtinHelp")}</span>}
                />
                {builtins.length ? (
                  <ul className="level-list" aria-label={t("access.kind.builtin")}>
                    {builtins.map(row)}
                  </ul>
                ) : (
                  empty
                )}
              </Card>
            </>
          )}
        </div>
        <div className="agp-col">
          <p className="newag__note">
            <Icon name="shield" size={16} />
            <span>
              <b>{t("newAgent.approvalsNote")}</b>{" "}
              {ownerFirst ? t("newAgent.approverOwner", { name: ownerFirst }) : t("newAgent.approverAdmins")}
            </span>
          </p>
          <Card
            as="section"
            className="agp-card"
            data-changed={changeOf("skills") ? true : undefined}
            aria-labelledby="ac-skills"
          >
            <CardHead id="ac-skills" icon="book" title={t("skills.agentTitle")} changeKeys={["skills"]} lock="skills" />
            <span className="small muted">{t("newAgent.skillsHelp", g)}</span>
            {skills.isLoading ? (
              <LoadingLine width={200} />
            ) : skills.isError ? (
              <span className="muted">{t("skills.unavailable")}</span>
            ) : library.length === 0 ? (
              <span className="small muted">{t("skills.empty")}</span>
            ) : skillsEditable ? (
              <div className="newag__pills">
                {library.map((s) => (
                  <CheckboxPill
                    key={s.id}
                    id={`agp-skill-${s.id}`}
                    checked={enabled.has(s.id)}
                    onCheckedChange={(on) => {
                      const next = new Set(enabled);
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                      set("skills", [...next].sort());
                    }}
                  >
                    {s.name}
                  </CheckboxPill>
                ))}
              </div>
            ) : enabled.size > 0 ? (
              <span className="agp-chips">
                {library
                  .filter((s) => enabled.has(s.id))
                  .map((s) => (
                    <Chip key={s.id} icon="book">
                      {s.name}
                    </Chip>
                  ))}
              </span>
            ) : (
              <span className="small muted">{t("skills.agentEmpty", { name: agent.name })}</span>
            )}
            <WasLine changeKey="skills" />
            {viewer === "admin" && (
              <Link
                className="agp-more"
                to="/org/$orgId/settings/$section"
                params={{ orgId: org.id, section: "skills" }}
              >
                <Icon name="book" size={14} />
                {t("agentPage.access.library")}
              </Link>
            )}
          </Card>
          <p className="newag__note">
            <Icon name="info" size={16} />
            <span>{t("agentPage.access.fineTune")}</span>
          </p>
        </div>
      </div>
    </>
  );
}
