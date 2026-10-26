import { expect, test } from "bun:test";
import { isInviteToken } from "../../src/features/auth/links";
import {
  emailsFrom,
  HOST,
  introducesAt,
  nextStep,
  OPTIONAL,
  prevStep,
  progressAt,
  STEPS,
  zoneCity,
} from "../../src/features/onboarding/logic";

test("the phone's steps: no computer step; import and people are optional; the strip fills to the end", () => {
  expect([...STEPS]).toEqual(["workspace", "context", "import", "agents", "team", "done"]);
  expect([...OPTIONAL].sort()).toEqual(["import", "team"]);
  expect(progressAt("workspace")).toBe(0);
  expect(progressAt("done")).toBe(1);
  expect(progressAt("agents")).toBeCloseTo(3 / 5, 5);
  expect(nextStep("team")).toBe("done");
  expect(prevStep("workspace")).toBeNull();
  expect(prevStep("done")).toBeNull();
  expect(prevStep("context")).toBe("workspace");
});

test("each host says hi only the first time it appears", () => {
  expect(HOST.workspace).toBe("ada");
  expect(introducesAt("workspace")).toBe(true);
  expect(introducesAt("context")).toBe(true);
  expect(introducesAt("agents")).toBe(false);
  expect(introducesAt("team")).toBe(false);
});

test("e-mails typed or pasted: lower-cased, no repeats, the wrong ones kept apart", () => {
  expect(emailsFrom("Rafael@Acme.com, bia@acme.com;rafael@acme.com nope", ["bia@acme.com"])).toEqual({
    valid: ["rafael@acme.com"],
    invalid: ["nope"],
  });
  expect(emailsFrom("   ")).toEqual({ valid: [], invalid: [] });
});

test("the time zone reads as its city; invitation tokens only url-safe", () => {
  expect(zoneCity("America/Sao_Paulo")).toBe("Sao Paulo");
  expect(isInviteToken("a".repeat(43))).toBe(true);
  expect(isInviteToken("../etc")).toBe(false);
  expect(isInviteToken(undefined)).toBe(false);
});

test("the import step shows each app's official logo: the files the web app ships", async () => {
  const phone = (name: string) => Bun.file(new URL(`../../assets/images/brands/${name}`, import.meta.url).pathname);
  const web = (name: string) => Bun.file(new URL(`../../../web/public/brands/${name}`, import.meta.url).pathname);
  // OpenBot has no vector logo: its raster, byte for byte.
  expect(Buffer.from(await phone("openbot.png").arrayBuffer())).toEqual(
    Buffer.from(await web("openbot.png").arrayBuffer()),
  );
  // OpenMausBot's SVG, rendered for the phone at 96 px (the PNG header's width and height).
  expect(await web("openmausbot.svg").exists()).toBe(true);
  const png = new DataView(await phone("openmausbot.png").arrayBuffer());
  expect([png.getUint32(16), png.getUint32(20)]).toEqual([96, 96]);
});
