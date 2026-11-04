import {
  type SecretRequest,
  type SecretToVaultInput,
  useApi,
  useSaveSecretToVault,
  type VaultAccess,
  type VaultScope,
} from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { secretAad } from "@agenteschat/client/lib/secret-box";
import { secretValueProblem, secretWhere } from "@agenteschat/client/lib/secret-requests";
import { secretEndedAt, secretOutcome } from "@agenteschat/client/lib/secret-words";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { sealSecret } from "@/lib/secret-box";
import { useOrg } from "@/providers/org";
import { Button, Chip, CodeInput, haptics, Icon, Segmented, Text, ToggleSwitch, useToast } from "@/ui";
import { IconTile } from "../connectors/ConnectorIcon";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { useSheetIfAny } from "../shared/SheetHost";
import { codeComplete, codeLength, LIMITS, vaultSaveOffered } from "../vault/logic";
import { AgentPickSheet } from "../vault/parts";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore, useExpired } from "./asks";
import { markName } from "./logic";

type AgentPick = Pick<VaultAccess, "allAgents" | "agentIds">;

/** How long a failed save keeps the typed value for "Try again" (ADR 0135), at most. */
const RETRY_MS = 2 * 60_000;

/**
 * An agent asks for a secret for its computer (`request_secret`, ADR 0027), as the request card. Only the
 * person asked sees the field; the value is sealed here, on the phone, to the key the computer made, so it
 * never reaches our server, the chat or the agent. Everyone else sees who was asked. Once it ends, one line.
 *
 * ADR 0135 §6: a site's password or a key can also go to the Vault ("Save to the Vault", on by default), personal or
 * the team's, for the agents chosen (the one that asked first), with the username the agent filled in. Only then
 * does the value reach the server, once, after the box was delivered. A code asked by the site comes in one box per
 * digit and is never saved.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const asks = useAskStore();
  const sheet = useSheetIfAny();
  const saveToVault = useSaveSecretToVault(orgId);
  // What this phone did to it (the message's copy changes only when the server says so).
  const [answered, setAnswered] = useState<SecretRequest | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | null>(null);
  const r = answered ?? request;
  const code = codeLength(r);
  const offered = vaultSaveOffered(r);
  const site = r.target.kind === "site";
  const canTeam = can(org, "manage_credentials");
  const [save, setSave] = useState(true);
  const [scope, setScope] = useState<VaultScope>("personal");
  const [pick, setPick] = useState<AgentPick>(() => ({ allAgents: false, agentIds: [request.agentId] }));
  const [username, setUsername] = useState(request.username ?? "");
  // "dropped": it failed and the time to try again is over, so the typed value is gone.
  const [kept, setKept] = useState<"saved" | "failed" | "saving" | "dropped" | null>(null);
  // A save that failed keeps what it sent, for "Try again", while this card is on screen and for two minutes at most.
  // The mutation itself forgets it as soon as it ends (`reset`, `gcTime: 0`).
  const retry = useRef<(SecretToVaultInput & { requestId: string }) | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      retry.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );
  // It closes at its expiry even when no event says so (as the line above the composer stops counting it).
  const expired = useExpired(r.expiresAt);
  const agentName = dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent");
  const mine = r.requestedForUserId === meId;
  const person = dir.memberById.get(r.requestedForUserId)?.name ?? t("channel.unknownPerson");
  const pending = r.status === "pending" && !expired;

  const failed = (err: unknown) => {
    const status = (err as { status?: number }).status;
    setError(status === 409 ? t("secret.alreadyAnswered") : t("secret.failed"));
  };
  const done = (res: SecretRequest) => {
    asks?.settle(r.id);
    setAnswered(res);
  };
  const keep = async (input: SecretToVaultInput & { requestId: string }) => {
    setKept("saving");
    try {
      await saveToVault.mutateAsync(input);
      retry.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setKept("saved");
    } catch {
      if (!retry.current) {
        retry.current = input;
        retryTimer.current = setTimeout(() => {
          retry.current = null;
          setKept((k) => (k === "failed" ? "dropped" : k));
        }, RETRY_MS);
      }
      setKept("failed");
      toast({ title: t("mobile.vault.card.notSaved"), icon: "x" });
    } finally {
      saveToVault.reset();
    }
  };
  const send = async () => {
    const problem = code
      ? codeComplete(value, code)
        ? null
        : "mobile.vault.card.codeIncomplete"
      : secretValueProblem(value);
    if (problem) return setError(t(problem));
    setError(null);
    setBusy("send");
    try {
      if (!r.publicKey) throw Object.assign(new Error("closed"), { status: 409 });
      const aad = secretAad({ requestId: r.id, orgId, name: r.name, target: r.target });
      const res = await api.secrets.deliver(orgId, r.id, await sealSecret(r.publicKey, value, aad));
      const sent = value;
      setValue("");
      successHaptic();
      done(res);
      // Delivered first: the Vault keeps it only once the computer has it (the server checks it too).
      if (offered && save) {
        const name = username.trim();
        void keep({
          requestId: r.id,
          value: sent,
          scope: scope === "team" && canTeam ? "team" : "personal",
          allAgents: pick.allAgents,
          agentIds: pick.agentIds,
          ...(site && name ? { username: name } : {}),
        });
      }
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setError(null);
    setBusy("decline");
    try {
      done(await api.secrets.decline(orgId, r.id));
    } catch (err) {
      failed(err);
      toast({ title: t("mobile.app.failed"), icon: "x" });
    } finally {
      setBusy(null);
    }
  };
  const chooseAgents = () =>
    sheet?.open(<AgentPickSheet initial={pick} onChange={setPick} onDone={() => sheet.close()} />);

  const where = [
    secretWhere(t, r, agentName),
    site && r.username ? t("mobile.vault.card.as", { username: r.username }) : null,
  ]
    .filter(Boolean)
    .join(" ");
  // Closed: one line, how it ended and which secret, never its value; what it was for when asked.
  if (!pending)
    return (
      <>
        <AskDone
          done={r.status === "delivered"}
          words={[
            `${secretOutcome(t, r, mine, person)}: ${markName(r.name)}`,
            kept === "saved" ? t("mobile.vault.card.saved") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          at={secretEndedAt(r)}
          more={{
            label: t("approval.seeDetails"),
            content: (
              <Text variant="small" tone="muted">
                {`${r.purpose}\n${where}`}
              </Text>
            ),
          }}
        />
        {kept === "failed" || kept === "dropped" || (kept === "saving" && retry.current) ? (
          <View style={styles.retry}>
            <Icon name="x" size={13} color={c.danger} />
            <Text variant="footnote" tone="muted" style={styles.grow}>
              {t("mobile.vault.card.notSaved")}
            </Text>
            {kept === "dropped" ? null : (
              <Button
                variant="ghost"
                size="sm"
                label={t("common.retry")}
                loading={kept === "saving"}
                onPress={() => {
                  if (retry.current) void keep(retry.current);
                }}
              />
            )}
          </View>
        ) : null}
      </>
    );

  return (
    <AskCard
      id={r.id}
      kind="secret"
      agentId={r.agentId}
      waitsFor={mine ? "you" : t("ask.waitingFor", { name: person })}
      lead={r.purpose}
      well={{ tile: <IconTile name="lock" size={32} />, title: r.name, detail: where }}
      body={
        mine ? (
          <>
            {code ? (
              <CodeInput
                length={code}
                value={value}
                onChange={(v) => {
                  setValue(v);
                  setError(null);
                }}
                label={t("mobile.vault.card.codeLabel", { name: r.name })}
                error={Boolean(error)}
                onSubmit={() => void send()}
              />
            ) : (
              <View style={[styles.field, { backgroundColor: c.raised, borderColor: error ? c.danger : c.line2 }]}>
                <TextInput
                  value={value}
                  onChangeText={(v) => {
                    setValue(v);
                    setError(null);
                  }}
                  placeholder={t("secret.label", { name: r.name })}
                  placeholderTextColor={c.faint}
                  accessibilityLabel={t("secret.label", { name: r.name })}
                  style={[styles.input, { color: c.ink }]}
                  secureTextEntry
                  textContentType="none"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  returnKeyType="send"
                  onSubmitEditing={() => void send()}
                  submitBehavior="submit"
                />
              </View>
            )}
            {error ? (
              <Text variant="footnote" tone="danger">
                {error}
              </Text>
            ) : null}
            <View style={styles.note}>
              <Icon name="lock" size={13} color={c.muted} />
              <Text variant="footnote" tone="muted" style={styles.grow}>
                {code ? t("mobile.vault.card.codeNote") : t("secret.private")}
              </Text>
            </View>
            {offered ? (
              <View style={[styles.save, { borderTopColor: c.line2 }]}>
                <Pressable
                  onPress={() => {
                    haptics.selection();
                    setSave((s) => !s);
                  }}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: save }}
                  accessibilityLabel={t("mobile.vault.card.save")}
                  accessibilityHint={t("mobile.vault.card.saveText")}
                  style={styles.saveRow}
                >
                  <Icon name={site ? "globe" : "key"} size={16} color={c.muted} />
                  <View style={styles.grow}>
                    <Text variant="subhead" style={styles.semibold}>
                      {t("mobile.vault.card.save")}
                    </Text>
                    <Text variant="footnote" tone="muted">
                      {t("mobile.vault.card.saveText")}
                    </Text>
                  </View>
                  <ToggleSwitch value={save} />
                </Pressable>
                {save ? (
                  <>
                    {canTeam ? (
                      <Segmented
                        items={[
                          { key: "personal", label: t("mobile.vault.tab.personal") },
                          { key: "team", label: t("mobile.vault.tab.team") },
                        ]}
                        value={scope}
                        onChange={(k) => setScope(k === "team" ? "team" : "personal")}
                      />
                    ) : (
                      <Text variant="footnote" tone="muted">
                        {t("mobile.vault.card.personalOnly")}
                      </Text>
                    )}
                    <View style={styles.agents}>
                      {pick.allAgents ? (
                        <Chip icon="agent" label={t("mobile.vault.access.allAgents")} />
                      ) : pick.agentIds.length === 0 ? (
                        <Text variant="footnote" tone="muted">
                          {t("mobile.vault.access.noAgent")}
                        </Text>
                      ) : (
                        pick.agentIds.map((id) => (
                          <Chip
                            key={id}
                            leading={<AgentFace agentId={id} size={16} live={false} />}
                            label={dir.anyAgent(id)?.name ?? t("channel.unknownAgent")}
                          />
                        ))
                      )}
                      {sheet ? (
                        <Pressable onPress={chooseAgents} accessibilityRole="button" hitSlop={8}>
                          <Text variant="subhead" tone="ink2" style={styles.semibold}>
                            {t("mobile.vault.card.choose")}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {site ? (
                      <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line2 }]}>
                        <TextInput
                          value={username}
                          onChangeText={setUsername}
                          maxLength={LIMITS.username}
                          placeholder={t("mobile.vault.field.username")}
                          placeholderTextColor={c.faint}
                          accessibilityLabel={t("mobile.vault.field.username")}
                          style={[styles.input, { color: c.ink }]}
                          textContentType="username"
                          autoCapitalize="none"
                          autoCorrect={false}
                          spellCheck={false}
                        />
                      </View>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null
      }
      foot={
        <AskFoot expiry={<ExpiryLine expiresAt={r.expiresAt} />}>
          {mine ? (
            <AskButtons
              primary={
                <Button
                  variant="primary"
                  size="card"
                  wide
                  icon="lock"
                  label={t("secret.send")}
                  loading={busy === "send"}
                  disabled={busy !== null}
                  onPress={() => void send()}
                />
              }
              secondary={
                <Button
                  variant="secondary"
                  size="card"
                  wide
                  label={t("approval.notNow")}
                  loading={busy === "decline"}
                  disabled={busy !== null}
                  onPress={() => void decline()}
                />
              }
            />
          ) : (
            <Text variant="small" tone="muted">
              {t("secret.waitingFor", { person })}
            </Text>
          )}
        </AskFoot>
      }
    />
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  field: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: "center",
  },
  input: { fontSize: 17, paddingVertical: 10 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  save: { gap: 10, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  saveRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  agents: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  retry: { flexDirection: "row", alignItems: "center", gap: 6 },
});
