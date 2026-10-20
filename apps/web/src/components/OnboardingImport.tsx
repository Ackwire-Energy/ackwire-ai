import { Button, Card, Checkbox, Chip, Field, Icon, type IconName, Input, OptionCard, Spinner } from "@agenteschat/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  groupLeftOut,
  IMPORT_SOURCES,
  type ImportResult,
  type ImportSource,
  type LeftOutKind,
  SOURCE_ACCEPT,
  SOURCE_ICON,
  SOURCE_NAME,
} from "@/lib/agent-import";

/** An icon per kind of thing that stays behind (chips say it with an icon, never a dot). */
const LEFT_OUT_ICON: Record<LeftOutKind, IconName> = {
  skill: "book",
  routine: "routines",
  room: "channel",
  connection: "link",
  app: "bolt",
  notes: "document",
  picture: "image",
  preset: "agent",
  remote: "cloud",
  model: "settings",
  secret: "lock",
  redacted: "lock",
  file: "file",
};

export type ImportChoice = ImportSource | "none" | null;

/**
 * Onboarding step "Trazer seus agentes" (docs/design/telas/OnboardingEtapas.html):
 * pick the source, drop the file or paste a GitHub link under the cards, then
 * see what was found (agents to bring, checked) and what doesn't come along.
 * Not using another app is "Pular esta etapa".
 */
export function OnboardingImport({
  source,
  onSource,
  result,
  picked,
  onPick,
  reading,
  error,
  onFiles,
  onLink,
  onReset,
}: {
  source: ImportChoice;
  onSource: (s: ImportChoice) => void;
  result: ImportResult | null;
  picked: Set<string>;
  onPick: (key: string, on: boolean) => void;
  reading: boolean;
  error: string | null;
  onFiles: (files: File[]) => void;
  onLink: (url: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: pressable cards, not a native fieldset */}
      <div className="onb__choices" role="group" aria-label={t("onboarding.import.sourcesLabel")}>
        {IMPORT_SOURCES.map((s) => (
          <OptionCard key={s} stacked pressed={source === s} onClick={() => onSource(s)} className="onb__choice">
            <span className="onb__ic" aria-hidden="true">
              <img src={SOURCE_ICON[s]} alt="" className="onb__source-mark" />
            </span>
            <span className="ac-option__title">{SOURCE_NAME[s]}</span>
            <span className="ac-option__desc">{t(`onboarding.import.${s}Desc`)}</span>
          </OptionCard>
        ))}
      </div>

      {source &&
        source !== "none" &&
        (reading ? (
          <Card as="div">
            <span className="row small muted" role="status" style={{ gap: 8 }}>
              <Spinner />
              {t("onboarding.import.reading")}
            </span>
          </Card>
        ) : result && result.source === source ? (
          <Found result={result} picked={picked} onPick={onPick} onReset={onReset} />
        ) : (
          <Pick source={source} error={error} onFiles={onFiles} onLink={onLink} />
        ))}
    </>
  );
}

/** Drop or choose the files, or paste a GitHub link. */
function Pick({
  source,
  error,
  onFiles,
  onLink,
}: {
  source: ImportSource;
  error: string | null;
  onFiles: (files: File[]) => void;
  onLink: (url: string) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [link, setLink] = useState("");
  const submitLink = () => {
    if (link.trim()) onLink(link.trim());
  };
  return (
    <Card as="div">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={SOURCE_ACCEPT[source]}
        aria-label={t("onboarding.import.fileLabel")}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <button
        type="button"
        className="onb__drop"
        data-over={over || undefined}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = [...(e.dataTransfer?.files ?? [])];
          if (files.length) onFiles(files);
        }}
      >
        <Icon name="upload" />
        <span className="onb__label">{t(`onboarding.import.drop.${source}`)}</span>
        <span className="small muted">{t("onboarding.import.dropHelp")}</span>
      </button>
      <Field label={t("onboarding.import.link")} id="import-link">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            value={link}
            placeholder={t(`onboarding.import.linkPlaceholder.${source}`)}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitLink();
              }
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button onClick={submitLink} disabled={!link.trim()}>
            {t("onboarding.import.readLink")}
          </Button>
        </div>
      </Field>
      {error && (
        <p className="small onb__error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <p className="onb__note">
        <Icon name="info" size={16} />
        <span>
          {t(`onboarding.import.where.${source}`)} {t("onboarding.import.privacy")}
        </span>
      </p>
    </Card>
  );
}

/** What was read: the agents to bring (checked), and what doesn't come along. */
function Found({
  result,
  picked,
  onPick,
  onReset,
}: {
  result: ImportResult;
  picked: Set<string>;
  onPick: (key: string, on: boolean) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const groups = groupLeftOut(result.leftOut);
  return (
    <Card as="section" aria-labelledby="import-found">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <h2 id="import-found" className="section-title onb__import-file">
            {result.team ?? result.files.join(", ")}
          </h2>
          <Chip icon="check" tone="done">
            {t("onboarding.import.read")}
          </Chip>
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>
          {t("onboarding.import.change")}
        </Button>
      </div>

      <h3 className="onb__group">
        {t("onboarding.import.agents")} <span className="muted tabular">{result.agents.length}</span>
      </h3>
      <ul className="onb__found">
        {result.agents.map((a) => {
          const id = `import-${a.key}`;
          return (
            <li key={a.key} className="onb__found-row">
              <Checkbox
                id={id}
                checked={picked.has(a.key)}
                onCheckedChange={(on) => onPick(a.key, on)}
                aria-label={t("onboarding.import.bring", { name: a.name })}
              />
              <AgentAvatar name={a.name} appearance={a.appearance} />
              <label htmlFor={id} className="onb__found-text">
                <span className="ac-option__title">{a.role ? `${a.name} · ${a.role}` : a.name}</span>
                {a.description && <span className="ac-option__desc">{a.description}</span>}
                {a.playbooks > 0 && (
                  <span className="small muted">{t("onboarding.import.playbooks", { count: a.playbooks })}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>

      {groups.length > 0 && (
        <>
          <h3 className="onb__group">{t("onboarding.import.leftOutTitle")}</h3>
          <span className="small muted">{t("onboarding.import.leftOutHelp")}</span>
          <ul className="onb__left-out">
            {groups.map((g) => (
              <li key={g.kind}>
                <Chip icon={LEFT_OUT_ICON[g.kind]}>{t(`onboarding.import.leftOut.${g.kind}`)}</Chip>
                <span className="small">{g.labels.join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="onb__note">
        <Icon name="lock" size={16} />
        <span>{t("onboarding.import.never")}</span>
      </p>
    </Card>
  );
}
