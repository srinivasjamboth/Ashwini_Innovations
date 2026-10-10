// Phase 3: do the sr-only labels render as real <label for>, and does
// Tailwind actually ship the .sr-only rule into the served sheet?
const BASE = "https://localhost:3000";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const html = await (await fetch(BASE + "/signup")).text();
console.log("labels:", JSON.stringify([...html.matchAll(/<label[^>]*>[\s\S]*?<\/label>/g)].map((m) => m[0])));
console.log("legal note block:", (html.match(/<p class="auth-legal">[\s\S]*?<\/p>/) || ["NONE"])[0]);

const hrefs = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
for (const href of hrefs) {
  const css = await (await fetch(BASE + (href.startsWith("http") ? "" : href) + (href.startsWith("/") && !href.includes("?") ? "" : ""))).text();
  console.log(
    href.slice(0, 60),
    "| sr-only rule:", /\.sr-only\s*\{/.test(css),
    "| auth-legal:", /\.auth-legal/.test(css),
    "| globals tailwind:", /\.container-xxl|flex-direction:column/.test(css),
  );
}
