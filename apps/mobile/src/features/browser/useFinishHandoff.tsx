import { type BrowserHandoff, useBrowserHandoffActions } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { FAILED_REASONS, NOTE_MAX } from "./logic";

/**
 * Ending a person's turn on an agent's browser or screen: Pronto or Devolver and "Não consegui", each a sheet with what
 * the person wants the agent to know, which it reads as their own words. `doneLabel`: the word the turn ends with.
 */
export function useFinishHandoff(handoff: BrowserHandoff | null | undefined, name: string, doneLabel: string) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const sheet = useSheet();
  const actions = useBrowserHandoffActions(orgId);
  const g = genderOf(name);
  const finish = async (ok: boolean, said?: string) => {
    if (!handoff) return;
    const text = said?.slice(0, NOTE_MAX) || undefined;
    try {
      if (ok) await actions.done(handoff.id, text);
      else await actions.failed(handoff.id, text);
      successHaptic();
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    }
  };
  const handBack = () => {
    tapHaptic();
    sheet.open(
      <PromptForm
        title={t("mobile.browser.done.title")}
        intro={t(`mobile.browser.done.intro${g}`, { name })}
        placeholder={t("mobile.browser.done.placeholder")}
        submitLabel={doneLabel}
        icon="check"
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          await finish(true, text);
        }}
      />,
    );
  };
  const couldnt = () => {
    tapHaptic();
    sheet.open(
      <PromptForm
        title={t("mobile.browser.failed.title")}
        intro={t(`mobile.browser.failed.intro${g}`, { name })}
        placeholder={t("mobile.browser.failed.placeholder")}
        submitLabel={t("mobile.browser.failed.send")}
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          await finish(false, text.trim() || undefined);
        }}
      >
        <View style={styles.reasons}>
          {FAILED_REASONS.map((r) => (
            <Button
              key={r}
              variant="secondary"
              size="sm"
              label={t(`mobile.browser.failed.reason.${r}`)}
              onPress={() => {
                sheet.close();
                void finish(false, t(`mobile.browser.failed.reason.${r}`));
              }}
            />
          ))}
        </View>
      </PromptForm>,
    );
  };
  return { handBack, couldnt };
}

const styles = StyleSheet.create({
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
