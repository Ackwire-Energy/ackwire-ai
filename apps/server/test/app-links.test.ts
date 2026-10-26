import { expect, test } from "bun:test";
import { androidAssetLinks, appleAppSiteAssociation } from "../src/app-links";

test("iOS: invitation and password reset links open the app once team and bundle id are set", () => {
  expect(appleAppSiteAssociation({ APPLE_TEAM_ID: undefined, APPLE_APP_BUNDLE_ID: "chat.agentes.app" })).toBeNull();
  expect(appleAppSiteAssociation({ APPLE_TEAM_ID: "ABCDE12345", APPLE_APP_BUNDLE_ID: "chat.agentes.app" })).toEqual({
    applinks: {
      details: [
        {
          appIDs: ["ABCDE12345.chat.agentes.app"],
          components: [{ "/": "/invite/*" }, { "/": "/reset-password" }],
        },
      ],
    },
  });
});

test("Android: the package and every signing fingerprint, upper-cased; nothing without them", () => {
  expect(androidAssetLinks({ ANDROID_APP_PACKAGE: "chat.agentes.app", ANDROID_APP_CERT_SHA256: " " })).toBeNull();
  expect(androidAssetLinks({ ANDROID_APP_PACKAGE: undefined, ANDROID_APP_CERT_SHA256: "AA:BB" })).toBeNull();
  expect(
    androidAssetLinks({ ANDROID_APP_PACKAGE: "chat.agentes.app", ANDROID_APP_CERT_SHA256: "aa:bb, CC:DD" }),
  ).toEqual([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "chat.agentes.app",
        sha256_cert_fingerprints: ["AA:BB", "CC:DD"],
      },
    },
  ]);
});
