// Phase 5: is the newest rule actually in the served sheet?
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const BASE = "https://localhost:3000";
const html = await (await fetch(BASE + "/login")).text();
const href = (html.match(/href="([^"]*auth-shell[^"]*\.css[^"]*)"/) || [])[1];
const css = await (await fetch(BASE + href)).text();
console.log("sheet:", href.split("/").pop(), "| bytes:", css.length);
for (const probe of [
  /\.auth-legal a \{/,
  /\.auth-legal a:hover/,
  /\.auth-strong/,
  /\.auth-submit \{[^}]*text-decoration: none/,
  /prefers-reduced-motion/,
  /max-width: 991\.98px/,
]) {
  console.log("  ", probe.test(css), String(probe));
}
