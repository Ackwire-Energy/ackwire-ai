import pkg from "../package.json" with { type: "json" };

/** Server version, taken from apps/server/package.json. */
export const version: string = pkg.version;
