import { type SecretRequest, useApi } from "@agenteschat/client";
import { MAX_SECRET_BYTES, secretAad } from "@agenteschat/client/lib/secret-box";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { sealSecret } from "@/lib/secret-box";
import { Button, Icon, Text, useToast } from "@/ui";
import { IconTile } from "../connectors/ConnectorIcon";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore, useExpired } from "./asks";

/**
 * An agent asks for a secret for its computer (`request_secret`, ADR 0027), as the request card. Only the
 * person asked sees the field; the value is sealed here, on the phone, to the key the computer made, so it
 * never reaches our server, the chat or the agent. Everyone else sees who was asked. Once it ends, one line.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const when = useWhen();
  const asks = useAskStore();
  // What this phone did to it (the message's copy changes only when the server says so).
  const [answered, setAnswered] = useState<SecretRequest | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "decline" | null>(null);
  const r = answered ?? request;
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
  const send = async () => {
    if (!value) return setError(t("secret.empty"));
    if (new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) return setError(t("secret.tooLarge"));
    setError(null);
    setBusy("send");
    try {
      if (!r.publicKey) throw Object.assign(new Error("closed"), { status: 409 });
      const aad = secretAad({ requestId: r.id, orgId, name: r.name, target: r.target });
      const res = await api.secrets.deliver(orgId, r.id, await sealSecret(r.publicKey, value, aad));
      setValue("");
      successHaptic();
      done(res);
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

  if (!pending) {
    const line =
      r.status === "delivered"
        ? r.deliveredAt
          ? mine
            ? t("secret.deliveredByYou", { time: when.time(r.deliveredAt) })
            : t("secret.delivered", { person, time: when.time(r.deliveredAt) })
          : t("secret.chipDone")
        : r.status === "declined"
          ? t("secret.declined")
          : r.status === "canceled"
            ? t("secret.canceled")
            : t("secret.expired");
    return <AskDone done={r.status === "delivered"} words={line} />;
  }

  const where =
    r.target.kind === "file"
      ? t("secret.targetFile", { path: r.target.path, agent: agentName })
      : t("secret.targetEnv", { name: r.name, agent: agentName });
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
            {error ? (
              <Text variant="footnote" tone="danger">
                {error}
              </Text>
            ) : null}
            <View style={styles.note}>
              <Icon name="lock" size={13} color={c.muted} />
              <Text variant="footnote" tone="muted" style={styles.grow}>
                {t("secret.private")}
              </Text>
            </View>
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
  field: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: "center",
  },
  input: { fontSize: 17, paddingVertical: 10 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
});
