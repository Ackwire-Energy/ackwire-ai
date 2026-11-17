import type { RequestHeader } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  HEADER_NAME_EXAMPLE,
  type HeaderRefused,
  type HeaderRow,
  MAX_HEADER_NAME,
  MAX_REQUEST_HEADERS,
  savedHeadersLine,
} from "@agenteschat/client/lib/request-headers";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Button, fieldText, Icon, IconButton, Text, TOOL_H, TOUCH, useTheme } from "@/ui";
import { tapHaptic } from "../shared/parts";
import { headerNamesText } from "./logic";

/**
 * The request headers of a server by address (ADR 0186), under its key: one line that opens them. A name and a value
 * per row, the value typed as a secret. On Reconectar the saved ones come first, by name: "Remover" sends none of them
 * any more, and typing a row replaces them all, which its line then says. Saved ones that couldn't be read
 * (`unreadable`) are no longer said to stay: that refusal takes the line, over "Remover". A header the server refused
 * says so under its row.
 */
export function RequestHeaders({
  rows,
  saved,
  dropSaved,
  open,
  refused,
  unreadable,
  onOpen,
  onChange,
}: {
  rows: HeaderRow[];
  /** Reconectar: the names the account has. */
  saved: string[];
  dropSaved: boolean;
  open: boolean;
  refused: HeaderRefused | null;
  unreadable: HeaderRefused | null;
  onOpen: (open: boolean) => void;
  onChange: (rows: HeaderRow[], dropSaved: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { colors: c, reducedMotion } = useTheme();
  // The keyboard's "next" on a name goes to its value, by the row's id.
  const values = useRef(new Map<number, TextInputInstance | null>());
  const appear = reducedMotion ? undefined : FadeIn.duration(160);
  const full = rows.length >= MAX_REQUEST_HEADERS;
  const line = savedHeadersLine(rows, dropSaved, unreadable !== null);
  const tooMany = t("errors.connector.headersTooMany", { max: MAX_REQUEST_HEADERS });
  const field = [styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  const set = (id: number, patch: Partial<RequestHeader>) =>
    onChange(
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      dropSaved,
    );
  const why = (refusal: HeaderRefused) => (
    <Text variant="footnote" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
      {errorText(t, refusal.error, i18n.language)}
    </Text>
  );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          onOpen(!open);
        }}
        // 32 tall among the sheet's fields: 44 to the finger.
        hitSlop={{ top: (TOUCH - TOOL_H) / 2, bottom: (TOUCH - TOOL_H) / 2 }}
        style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
      >
        <Text variant="subhead" tone="muted" style={[styles.grow, styles.bold]}>
          {t("connectFlow.headers.title")}
        </Text>
        <View style={open ? styles.flip : null}>
          <Icon name="chev" size={15} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View entering={appear} style={styles.body}>
          <Text variant="small" tone="muted">
            {t("connectFlow.headers.help")}
          </Text>
          {saved.length > 0 ? (
            <View>
              {line.says === "unreadable" && unreadable ? (
                why(unreadable)
              ) : (
                <Text variant="small" tone="ink">
                  {headerNamesText(
                    t,
                    line.says === "saved" ? "connectFlow.headers.saved" : "connectFlow.headers.dropping",
                    saved,
                  )}
                </Text>
              )}
              {line.action ? (
                <Button
                  variant="text"
                  size="sm"
                  label={t(line.action === "drop" ? "connectFlow.headers.drop" : "connectFlow.headers.undo")}
                  onPress={() => onChange(rows, line.action === "drop")}
                />
              ) : null}
            </View>
          ) : null}
          {rows.length > 0 ? (
            <View style={styles.labeled}>
              {/* Each field says its own name and row to a screen reader. */}
              <View aria-hidden style={styles.row}>
                <Text variant="footnote" tone="faint" style={styles.name}>
                  {t("connectFlow.name")}
                </Text>
                <Text variant="footnote" tone="faint" style={styles.value}>
                  {t("connectFlow.headers.value")}
                </Text>
                <View style={styles.removeRoom} />
              </View>
              <View style={styles.rows}>
                {rows.map((row, i) => {
                  const wrong = refused?.row === row.id ? refused : null;
                  return (
                    <Animated.View key={row.id} entering={appear} style={styles.entry}>
                      <View style={styles.row}>
                        <TextInput
                          value={row.name}
                          onChangeText={(name) => set(row.id, { name })}
                          placeholder={HEADER_NAME_EXAMPLE}
                          placeholderTextColor={c.faint}
                          maxLength={MAX_HEADER_NAME}
                          autoCapitalize="none"
                          autoCorrect={false}
                          autoComplete="off"
                          spellCheck={false}
                          returnKeyType="next"
                          submitBehavior="submit"
                          onSubmitEditing={() => values.current.get(row.id)?.focus()}
                          accessibilityLabel={t("connectFlow.headers.nameOf", { n: i + 1 })}
                          style={[field, styles.name, wrong?.field === "name" ? { borderColor: c.danger } : null]}
                        />
                        <TextInput
                          ref={(input) => {
                            values.current.set(row.id, input);
                          }}
                          value={row.value}
                          onChangeText={(value) => set(row.id, { value })}
                          secureTextEntry
                          autoCapitalize="none"
                          autoCorrect={false}
                          autoComplete="off"
                          accessibilityLabel={t("connectFlow.headers.valueOf", { n: i + 1 })}
                          style={[field, styles.value, wrong?.field === "value" ? { borderColor: c.danger } : null]}
                        />
                        <IconButton
                          icon="x"
                          small
                          label={t("connectFlow.headers.remove", { n: i + 1 })}
                          onPress={() =>
                            onChange(
                              rows.filter((other) => other.id !== row.id),
                              dropSaved,
                            )
                          }
                        />
                      </View>
                      {wrong ? why(wrong) : null}
                    </Animated.View>
                  );
                })}
              </View>
            </View>
          ) : null}
          {refused && refused.row === null ? why(refused) : null}
          <View style={styles.add}>
            <Button
              variant="secondary"
              size="sm"
              label={t("connectFlow.headers.add")}
              disabled={full}
              {...(full ? { hint: tooMany } : {})}
              onPress={() =>
                onChange(
                  [...rows, { id: Math.max(0, ...rows.map((row) => row.id)) + 1, name: "", value: "" }],
                  dropSaved,
                )
              }
            />
            {full ? (
              <Text variant="footnote" tone="muted">
                {tooMany}
              </Text>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  head: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: TOOL_H },
  pressed: { opacity: 0.6 },
  flip: { transform: [{ rotate: "180deg" }] },
  body: { gap: 12 },
  labeled: { gap: 6 },
  rows: { gap: 8 },
  // A row with what the server said about it, right under.
  entry: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  // A name is read, a value only shows dots: the name gets the wider field.
  name: { flex: 3, minWidth: 0 },
  value: { flex: 2, minWidth: 0 },
  // The remove button's column, kept over the labels so each stands over its field.
  removeRoom: { width: TOOL_H },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
  add: { gap: 6 },
});
