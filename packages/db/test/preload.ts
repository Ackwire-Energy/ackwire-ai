import { setDefaultTimeout } from "bun:test";

// The first test of each file migrates a template database (PGlite); on a busy
// machine that can take longer than Bun's 5 s default (`timeout` in bunfig is not honored).
setDefaultTimeout(30_000);
