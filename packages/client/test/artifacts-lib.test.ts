import { describe, expect, test } from "bun:test";
import { artifactRefs } from "../src/lib/artifacts";

describe("a message's files (`meta.artifacts`)", () => {
  test("a file listed twice shows once, at its newest version", () => {
    const meta = {
      artifacts: [
        { id: "a", version: 1 },
        { id: "b", version: 1 },
        { id: "a", version: 1 },
        { id: "a", version: 2 },
      ],
    };
    expect(artifactRefs(meta)).toEqual([
      { id: "a", version: 2 },
      { id: "b", version: 1 },
    ]);
  });

  test("only entries it can show", () => {
    expect(artifactRefs({ artifacts: [null, { id: 1 }, { id: "x", deleted: true, title: "x.png" }] })).toEqual([
      { id: "x", deleted: true, title: "x.png" },
    ]);
    expect(artifactRefs(undefined)).toEqual([]);
  });
});
