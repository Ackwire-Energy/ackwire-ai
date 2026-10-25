import { ApiError } from "@agenteschat/client";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openRefusalKey } from "./sites";

/**
 * The address bar of the agent's browser while a person is in control (ADR 0040 §7): the site
 * opens there (a closed browser starts), and a refusal (outside the agent's sites, not an
 * address, a page that didn't load) is said under the field.
 */
export function AddressBar({
  grammar,
  onOpen,
  focus = false,
  cloud = false,
}: {
  grammar: ReturnType<typeof agentGrammar>;
  /** Opens the typed address; rejects with the server's refusal. */
  onOpen: (url: string) => Promise<unknown>;
  /** Takes the focus when it appears: with the browser closed, an address is the next thing to type. */
  focus?: boolean;
  /** The workspace's own computer: its refusals never say it is off. */
  cloud?: boolean;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  const go = async () => {
    const typed = url.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onOpen(typed);
      setUrl("");
    } catch (e) {
      setError(t(openRefusalKey(e instanceof ApiError ? e.code : undefined, cloud), grammar));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="brw-go"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <label className="brw-go__field">
        <Icon name="globe" size={14} />
        <input
          ref={input}
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={2048}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          placeholder={t("browser.inCard.goPlaceholder")}
          aria-label={t("browser.inCard.goLabel")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </label>
      <Button type="submit" size="sm" loading={busy} disabled={!url.trim()}>
        {t("browser.inCard.go")}
      </Button>
      {error && (
        <p id={errorId} className="brw-go__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
