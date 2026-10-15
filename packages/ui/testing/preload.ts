/**
 * First `bun test` preload (root `bunfig.toml`): attaches the DOM and loads
 * the DOM-sensitive libraries of the design system while it is attached.
 * `apps/web/test/preload.ts` does the same for the web app; then
 * `preload-done.ts` detaches the DOM so backend tests never see a browser.
 */
import { plugin } from "bun";
import { attachDom } from "./dom";

// Pages may import their own stylesheet (the landing page does); tests have no CSS, so `.css` loads as an empty module.
plugin({
  name: "css-stub",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {};", loader: "js" }));
  },
});

attachDom();
await import("react-dom/client");
await import("radix-ui");
await import("@testing-library/react");
await import("@testing-library/user-event");
