import type { Credential, EndpointCheck, EndpointStyle } from "@agenteschat/client";
import { useAddCredential, useEndpointModels, useSetEndpointModels } from "@agenteschat/client";
import {
  CHECK_VIEW,
  CUSTOM_PROVIDER,
  checksInOrder,
  draftOfEndpoint,
  ENDPOINT_STYLES,
  type EndpointDraft,
  emptyEndpointDraft,
  endpointAddressLooksValid,
  endpointBaseExample,
  endpointModelsOf,
  endpointReady,
  pricesProblem,
  withListedModels,
  withTypedModel,
} from "@agenteschat/client/lib/endpoints";
import { Button, Checkbox, Field, Icon, Input, Locked, Segmented, SettingNote } from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * "Outro provedor" (ADR 0146): a workspace's own OpenAI- or Anthropic-compatible endpoint. The admin names it, picks
 * its API, types its address and key, fetches its models (or types their ids), chooses which agents may use and their
 * prices, then saves: the server runs one test call per model and the results show here. With `credential`, it
 * changes a saved endpoint's models and prices (its address and key stay).
 */
export function EndpointForm({
  orgId,
  credential,
  onDone,
}: {
  orgId: string;
  credential?: Credential;
  onDone: (saved: Credential) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [draft, setDraft] = useState<EndpointDraft>(() =>
    credential?.endpoint ? draftOfEndpoint(credential.label, credential.endpoint) : emptyEndpointDraft(),
  );
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const [saved, setSaved] = useState<{ cred: Credential; checks: EndpointCheck[] } | null>(null);
  const list = useEndpointModels(orgId);
  const add = useAddCredential(orgId);
  const change = useSetEndpointModels(orgId);
  const editing = credential !== undefined;
  const set = (patch: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (id: string, patch: Partial<EndpointDraft["models"][number]>) =>
    setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const addTyped = () => {
    const next = withTypedModel(draft, typed);
    setTypedWrong(next === null);
    if (!next) return;
    setDraft(next);
    setTyped("");
  };
  const fetchModels = () =>
    list.mutate(
      { style: draft.style, baseURL: draft.baseURL.trim(), apiKey: draft.apiKey.trim() || undefined },
      { onSuccess: (r) => setDraft((d) => ({ ...withListedModels(d, r.models), baseURL: r.baseURL })) },
    );
  const save = () => {
    const models = endpointModelsOf(draft);
    if (!models) return;
    if (editing && credential) {
      change.mutate(
        { credentialId: credential.id, models },
        {
          onSuccess: (r) =>
            setSaved({
              cred: {
                ...credential,
                ...(credential.endpoint ? { endpoint: { ...credential.endpoint, models: r.models } } : {}),
              },
              checks: r.checks,
            }),
        },
      );
      return;
    }
    add.mutate(
      {
        provider: CUSTOM_PROVIDER,
        label: draft.name.trim(),
        apiKey: draft.apiKey.trim(),
        endpoint: { style: draft.style, baseURL: draft.baseURL.trim(), models },
      },
      { onSuccess: ({ checks, ...cred }) => setSaved({ cred, checks: checks ?? [] }) },
    );
  };
  const saving = add.isPending || change.isPending;
  const ready = editing ? endpointModelsOf(draft) !== null : endpointReady(draft);
  const unpriced = draft.models.some((m) => m.on && !m.input.trim() && !m.output.trim());

  if (saved) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <b>{t("endpoint.results")}</b>
        <ul className="ac-iconlist" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {checksInOrder(draft, saved.checks).map((c) => {
            const view = CHECK_VIEW[c.check];
            return (
              <li key={c.model} className="ac-iconline">
                <Icon name={view.tone === "ok" ? "check" : "alert"} size={14} />
                <span>
                  <b>{c.model}</b> · {t(view.key, { error: c.error ?? "" })}
                </span>
              </li>
            );
          })}
        </ul>
        <span className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="primary" onClick={() => onDone(saved.cred)}>
            {t("endpoint.done")}
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <Locked when={saving}>
        {!editing && (
          <>
            <Field label={t("endpoint.name")} id={`${ids}-name`}>
              <Input
                value={draft.name}
                maxLength={80}
                placeholder={t("endpoint.namePlaceholder")}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <Segmented<EndpointStyle>
              label={t("endpoint.style")}
              value={draft.style}
              onValueChange={(style) => set({ style })}
              options={ENDPOINT_STYLES.map((s) => ({ value: s, label: t(`endpoint.styles.${s}`) }))}
            />
            <Field
              label={t("endpoint.address")}
              id={`${ids}-url`}
              help={t("endpoint.addressHelp", { example: endpointBaseExample(draft.style) })}
            >
              <Input
                value={draft.baseURL}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={endpointBaseExample(draft.style)}
                onChange={(e) => set({ baseURL: e.target.value })}
              />
            </Field>
            <Field label={t("endpoint.key")} id={`${ids}-key`} help={t("endpoint.keyHelp")}>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
            </Field>
            <span className="row">
              <Button
                icon="refresh"
                loading={list.isPending}
                disabled={!endpointAddressLooksValid(draft.baseURL)}
                onClick={fetchModels}
              >
                {t("endpoint.fetch")}
              </Button>
            </span>
            {list.data?.error && (
              <SettingNote icon="alert">{t("endpoint.listFailed", { error: list.data.error })}</SettingNote>
            )}
          </>
        )}
        {draft.models.length > 0 && (
          <fieldset className="stack" style={{ gap: 8, border: 0, margin: 0, padding: 0 }}>
            <legend className="small muted" style={{ padding: 0 }}>
              {t("endpoint.choose")}
            </legend>
            {draft.models.map((m) => {
              const problem = m.on ? pricesProblem(m) : null;
              return (
                <div key={m.id} className="stack" style={{ gap: 4 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Checkbox id={`${ids}-m-${m.id}`} checked={m.on} onCheckedChange={(on) => setModel(m.id, { on })} />
                    <label htmlFor={`${ids}-m-${m.id}`}>{m.id}</label>
                  </span>
                  {m.on && (
                    <span className="row" style={{ gap: 8, paddingInlineStart: 28, flexWrap: "wrap" }}>
                      <Input
                        aria-label={t("endpoint.priceIn", { model: m.id })}
                        placeholder={t("endpoint.priceInShort")}
                        inputMode="decimal"
                        value={m.input}
                        invalid={problem !== null}
                        style={{ width: 120 }}
                        onChange={(e) => setModel(m.id, { input: e.target.value })}
                      />
                      <Input
                        aria-label={t("endpoint.priceOut", { model: m.id })}
                        placeholder={t("endpoint.priceOutShort")}
                        inputMode="decimal"
                        value={m.output}
                        invalid={problem !== null}
                        style={{ width: 120 }}
                        onChange={(e) => setModel(m.id, { output: e.target.value })}
                      />
                      <span className="small muted">{t("endpoint.priceUnit")}</span>
                    </span>
                  )}
                  {problem && (
                    <div className="ac-field__error" role="alert" style={{ paddingInlineStart: 28 }}>
                      {t(problem === "both" ? "endpoint.priceBoth" : "endpoint.priceInvalid")}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
        <Field
          label={t("endpoint.addModel")}
          id={`${ids}-typed`}
          error={typedWrong ? t("endpoint.modelInvalid") : undefined}
        >
          <span className="agp-addacct__paste">
            <Input
              value={typed}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("endpoint.modelPlaceholder")}
              onChange={(e) => {
                setTyped(e.target.value);
                setTypedWrong(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addTyped();
              }}
            />
            <Button icon="plus" disabled={!typed.trim()} onClick={addTyped}>
              {t("endpoint.add")}
            </Button>
          </span>
        </Field>
        {unpriced && <SettingNote icon="info">{t("endpoint.unpriced")}</SettingNote>}
      </Locked>
      <span className="row" style={{ justifyContent: "flex-end" }}>
        <Button variant="primary" loading={saving} disabled={!ready || saving} onClick={save}>
          {saving ? t("endpoint.testing") : t(editing ? "endpoint.saveModels" : "endpoint.save")}
        </Button>
      </span>
    </div>
  );
}
