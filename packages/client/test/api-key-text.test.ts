import { describe, expect, test } from "bun:test";
import { looksLikeApiKey, withoutApiKeys } from "../src/lib/api-key-text";

// Made-up keys with the real shapes (random runs with digits), never real ones.
const ANTHROPIC = "sk-ant-api03-Zq8xW2pL5mN7vR1tY4uI9oP3aS6dF0gH-jK2lZ8xC5vB1nM4qW7eR9tY2uI6oP0aS3dF";
const OPENAI = "sk-proj-4fG7hJ2kL9mN1pQ5rS8tU3vW6xY0zA2bC4dE7fG9hJ1kL3mN5pQ";
const LEGACY = "sk-9aB3cD5eF7gH1iJ3kL5mN7oP9qR1sT3uV5wX7yZ9aB1cD3eF";
const DEEPSEEK = "sk-0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
// Joined at run time: the secret scan reads a literal Google key shape as a real key.
const GOOGLE = ["AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"].join("");

describe("looksLikeApiKey", () => {
  test("finds the shapes people paste: Anthropic, OpenAI, other sk- keys, Google", () => {
    expect(looksLikeApiKey(`minha chave é ${ANTHROPIC}`)).toBe(ANTHROPIC);
    expect(looksLikeApiKey(OPENAI)).toBe(OPENAI);
    expect(looksLikeApiKey(`usa essa: ${LEGACY}.`)).toBe(LEGACY);
    expect(looksLikeApiKey(`deepseek ${DEEPSEEK}\nvaleu`)).toBe(DEEPSEEK);
    expect(looksLikeApiKey(`https://x.dev/?key=${GOOGLE}`)).toBe(GOOGLE);
    expect(looksLikeApiKey(`\`${ANTHROPIC}\``)).toBe(ANTHROPIC);
  });

  test("normal text with sk- words, prefixes alone and hyphenated names is not a key", () => {
    for (const text of [
      "o sk-learn resolve isso",
      "chaves da Anthropic começam com sk-ant-",
      "a branch sk-this-is-a-very-long-branch-name está pronta",
      "task-1234567890123456789012 no Linear",
      "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "AIza curto: AIzaSyA1b2C3",
      "bom dia, @ada",
    ]) {
      expect(looksLikeApiKey(text)).toBeNull();
    }
  });
});

describe("withoutApiKeys", () => {
  test("takes the keys out and keeps the rest of the message", () => {
    expect(withoutApiKeys(`minha chave é ${ANTHROPIC} e a outra ${GOOGLE}, conecta?`)).toBe(
      "minha chave é e a outra , conecta?",
    );
    expect(withoutApiKeys(`${OPENAI}\n@ada usa essa`)).toBe("@ada usa essa");
    expect(withoutApiKeys("o sk-learn fica")).toBe("o sk-learn fica");
  });
});
