import { describe, expect, test } from "bun:test";
import type { Memory, WikiGraph } from "@agenteschat/client";
import {
  aroundStar,
  frameStars,
  MAP_MEMORIES,
  memoryMap,
  namedStars,
  pixelsAlong,
  placeStars,
  ringAround,
  wikiMap,
} from "../../src/features/constellation/logic";
import { agentFilters, justLearned, mostUsed, searchMemories } from "../../src/features/memory/logic";

const NOW = Date.UTC(2026, 10, 1, 12);
const agents = [
  { id: "ada", name: "Ada" },
  { id: "atlas", name: "Atlas" },
];

function memory(over: Partial<Memory> & { id: string; agentId: string }): Memory {
  return {
    kind: "fact",
    text: `Text of ${over.id}`,
    source: "",
    uses: 0,
    lastUsedAt: null,
    pinned: false,
    archived: false,
    lowTrust: false,
    verified: false,
    supersedes: null,
    editedByUserId: null,
    updatedAt: "2026-10-30T10:00:00.000Z",
    ...over,
  };
}

describe("the memory sky", () => {
  test("each agent tied to what it knows; archived and gone agents stay out; a link used today is lit", () => {
    const map = memoryMap(
      [
        memory({ id: "m1", agentId: "ada", uses: 3, lastUsedAt: new Date(NOW - 3_600_000).toISOString() }),
        memory({ id: "m2", agentId: "ada", archived: true }),
        memory({ id: "m3", agentId: "gone" }),
        memory({ id: "m4", agentId: "atlas", lastUsedAt: new Date(NOW - 3 * 86_400_000).toISOString() }),
      ],
      agents,
      NOW,
    );
    expect(map.stars.map((s) => s.id).sort()).toEqual(["ada", "atlas", "m1", "m4"]);
    expect(map.links).toEqual([
      { from: "ada", to: "m1", recent: true },
      { from: "atlas", to: "m4", recent: false },
    ]);
  });

  test("draws only the most used when there are many", () => {
    const many = Array.from({ length: MAP_MEMORIES + 5 }, (_, i) => memory({ id: `m${i}`, agentId: "ada", uses: i }));
    const map = memoryMap(many, agents, NOW);
    expect(map.stars.filter((s) => s.kind === "memory")).toHaveLength(MAP_MEMORIES);
    expect(map.stars.some((s) => s.id === "m0")).toBe(false);
  });
});

describe("the wiki sky", () => {
  const graph: WikiGraph = {
    nodes: [
      { slug: "a", title: "A", folder: "Eng", tags: [] },
      { slug: "b", title: "B", folder: "", tags: [] },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "deleted" },
    ],
  };

  test("pages, their links, and who read them", () => {
    const map = wikiMap(graph, [{ slug: "a", total: 4, agents: [{ agentId: "ada", count: 4 }] }], agents);
    expect(map.stars.map((s) => s.id)).toEqual(["ada", "a", "b"]);
    expect(map.stars.find((s) => s.id === "a")?.weight).toBe(4);
    expect(map.links).toEqual([
      { from: "a", to: "b", recent: false },
      { from: "ada", to: "a", recent: true },
    ]);
  });

  test("around a page: only what touches it", () => {
    const map = wikiMap(graph, [{ slug: "a", total: 1, agents: [{ agentId: "ada", count: 1 }] }], agents);
    expect(aroundStar(map, "b").stars.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("drawing it", () => {
  const map = memoryMap(
    Array.from({ length: 12 }, (_, i) => memory({ id: `m${i}`, agentId: i % 2 ? "ada" : "atlas", uses: i })),
    agents,
    NOW,
  );

  test("the same map always lands the same way, inside the world", () => {
    const at = placeStars(map);
    expect(placeStars(map)).toEqual(at);
    expect(at.size).toBe(map.stars.length);
  });

  test("names never cover each other and the selected always shows", () => {
    const at = new Map([
      ["ada", { x: 100, y: 100 }],
      ["atlas", { x: 400, y: 400 }],
      ["m0", { x: 110, y: 110 }],
      ["m1", { x: 400, y: 100 }],
    ]);
    const small = {
      stars: map.stars.filter((s) => at.has(s.id)),
      links: [],
    };
    const named = namedStars(small, at, "m0");
    expect(named.has("m0")).toBe(true);
    expect(named.has("ada")).toBe(false);
    expect(named.has("m1")).toBe(true);
  });

  test("a sky only to look at frames every star", () => {
    const at = new Map([
      ["a", { x: 56, y: 56 }],
      ["b", { x: 284, y: 284 }],
    ]);
    const { zoom, center } = frameStars(at, 343, 170);
    expect(center).toEqual({ x: 170, y: 170 });
    expect(228 * zoom).toBeLessThanOrEqual(170 - 96);
  });

  test("the ring has twelve squares around the star", () => {
    const ring = ringAround({ x: 100, y: 100 }, 14);
    expect(ring).toHaveLength(12);
    expect(ring[0]).toEqual({ x: 113, y: 99 });
  });

  test("a line is small squares on a 2-point grid", () => {
    const line = pixelsAlong({ x: 0, y: 0 }, { x: 40, y: 0 });
    expect(line.length).toBeGreaterThan(5);
    expect(line.every((p) => p.x % 2 === 0)).toBe(true);
  });
});

describe("the lists under the sky", () => {
  const list = [
    memory({ id: "m1", agentId: "ada", uses: 2, text: "Deploy depois das 18h", updatedAt: "2026-10-30T10:00:00.000Z" }),
    memory({ id: "m2", agentId: "ada", uses: 0, updatedAt: "2026-10-31T10:00:00.000Z" }),
    memory({ id: "m3", agentId: "atlas", uses: 9, updatedAt: "2026-10-29T10:00:00.000Z" }),
  ];

  test("a filter per agent that knows something, who knows most first", () => {
    expect(agentFilters(list, [...agents, { id: "theo", name: "Theo" }], "Tudo")).toEqual([
      { key: "all", label: "Tudo" },
      { key: "ada", label: "Ada", count: 2 },
      { key: "atlas", label: "Atlas", count: 1 },
    ]);
  });

  test("newest, most used (what was never used stays out), and search", () => {
    expect(justLearned(list).map((m) => m.id)).toEqual(["m2", "m1", "m3"]);
    expect(mostUsed(list).map((m) => m.id)).toEqual(["m3", "m1"]);
    expect(searchMemories(list, "DEPLOY").map((m) => m.id)).toEqual(["m1"]);
  });

  test("search finds a memory by its plain summary too", () => {
    const summed = memory({
      id: "m9",
      agentId: "ada",
      text: "supabase secrets set KEY",
      summary: "Gravar senhas sem expô-las",
    });
    expect(searchMemories([...list, summed], "senhas").map((m) => m.id)).toEqual(["m9"]);
  });
});
