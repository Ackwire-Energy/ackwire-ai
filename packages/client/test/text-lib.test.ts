import { expect, test } from "bun:test";
import { emailTypoFix, webmailOf } from "../src/lib/text";

test("a misspelled webmail domain gets one fix; anything else is left alone", () => {
  expect(emailTypoFix("Marina@Gmial.com ")).toBe("marina@gmail.com");
  expect(emailTypoFix("ana@hotmail.con")).toBe("ana@hotmail.com");
  expect(emailTypoFix("ana@uol.com")).toBe("ana@uol.com.br");
  expect(emailTypoFix("ana@gmail.com")).toBeNull();
  expect(emailTypoFix("ana@acme.com.br")).toBeNull();
  expect(emailTypoFix("ana")).toBeNull();
  expect(emailTypoFix("a@b@gmial.com")).toBeNull();
});

test("the webmail to open after sending an e-mail", () => {
  expect(webmailOf("ana@gmail.com")?.name).toBe("Gmail");
  expect(webmailOf("ana@hotmail.com")?.name).toBe("Outlook");
  expect(webmailOf("ana@icloud.com")?.name).toBe("iCloud Mail");
  expect(webmailOf("ana@yahoo.com.br")?.name).toBe("Yahoo Mail");
  expect(webmailOf("ana@acme.com.br")).toBeNull();
});
