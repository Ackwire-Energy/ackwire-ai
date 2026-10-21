import { expect, test } from "bun:test";
import { mobileEn } from "../src/i18n/keys.en";
import { mobilePtBR } from "../src/i18n/keys.pt-BR";
import { pickLocale, withMobileKeys } from "../src/i18n/merge";

function leaves(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : leaves(v as object, `${prefix}${k}.`),
  );
}

test("pt-BR and en have the same keys", () => {
  expect(leaves(mobileEn).sort()).toEqual(leaves(mobilePtBR).sort());
});

test("placeholders match between locales", () => {
  const vars = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort();
  const get = (o: object, path: string) =>
    path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)[k], o);
  for (const key of leaves(mobilePtBR))
    expect(vars(get(mobileEn, key) as string)).toEqual(vars(get(mobilePtBR, key) as string));
});

test("the app's strings are added under `mobile` in every namespace", () => {
  const merged = withMobileKeys({ "pt-BR": { translation: { a: "1" } }, en: { translation: { a: "2" } } });
  expect(merged["pt-BR"]?.translation?.a).toBe("1");
  expect(merged["pt-BR"]?.translation?.mobile).toBe(mobilePtBR);
  expect(merged.en?.translation?.mobile).toBe(mobileEn);
});

test("the phone's language picks pt-BR or en", () => {
  expect(pickLocale(["pt-PT"])).toBe("pt-BR");
  expect(pickLocale(["en-GB", "pt-BR"])).toBe("en");
  expect(pickLocale(["fr-FR"])).toBe("pt-BR");
  expect(pickLocale([null, "en-US"])).toBe("en");
});

test("extra keys merge deeply into the app's strings", () => {
  const merged = withMobileKeys(
    { "pt-BR": { translation: {} } },
    { "pt-BR": { auth: { extra: "x" }, home: { a: "b" } } },
  );
  const mobile = merged["pt-BR"]?.translation?.mobile as Record<string, Record<string, unknown>>;
  expect(mobile.home?.a).toBe("b");
  expect(mobile.auth?.extra).toBe("x");
  expect((mobile.auth?.social as Record<string, string> | undefined)?.failed).toBe(mobilePtBR.auth.social.failed);
});
