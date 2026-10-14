/**
 * Enforces the edition boundary (docs/adr/0002-editions-and-modules.md):
 * open-source code under apps/ and packages/ must never import the
 * proprietary Cloud package (private agentes-chat-cloud repo) or the
 * commercially licensed `ee/` package. Run in CI via `bun run check:boundaries`.
 */
import { Glob } from "bun";

const forbidden =
  /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](@agenteschat\/(cloud|ee)(\/[^"']*)?|(\.\.\/)+(cloud|ee)(\/[^"']*)?)["']/;
const violations: string[] = [];

for (const dir of ["apps", "packages"]) {
  for await (const file of new Glob(`${dir}/**/*.{ts,tsx,js,mjs}`).scan({ dot: false })) {
    if (file.includes("node_modules") || file.includes("/dist/")) continue;
    const text = await Bun.file(file).text();
    text.split("\n").forEach((line, i) => {
      if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
}

for (const pkgFile of ["apps", "packages"].flatMap((d) => [...new Glob(`${d}/*/package.json`).scanSync()])) {
  const pkg = await Bun.file(pkgFile).json();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  for (const name of ["@agenteschat/cloud", "@agenteschat/ee"]) {
    if (name in deps) violations.push(`${pkgFile}: depends on ${name}`);
  }
}

if (violations.length > 0) {
  console.error(`Open-source code must not depend on cloud/ or ee/:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("boundaries ok");
