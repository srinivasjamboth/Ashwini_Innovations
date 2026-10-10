// Phase 4: stylesheet isolation between the auth pages, the landing and
// the legal pages, and that the newest CSS edit is being served.
const BASE = "https://localhost:3000";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function sheets(route) {
  const html = await (await fetch(BASE + route)).text();
  const hrefs = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
  let blob = "";
  for (const href of hrefs) blob += await (await fetch(BASE + href)).text();
  return {
    hrefs: hrefs.map((h) => h.split("/").pop()),
    authShell: /\.auth-shell/.test(blob),
    bootstrap: /container-xxl/.test(blob),
    legalPage: /\.legal-page/.test(blob),
    heroGradient: /--gradient-hero/.test(blob),
  };
}

for (const route of ["/login", "/signup", "/terms", "/"]) {
  const s = await sheets(route);
  console.log(`\n${route}`);
  console.log("  css:", JSON.stringify(s.hrefs));
  console.log(
    "  auth-shell:", s.authShell,
    "| bootstrap:", s.bootstrap,
    "| legal-page:", s.legalPage,
    "| landing hero:", s.heroGradient,
  );
}

const loginCss = await (await fetch(BASE + "/src/app/(auth)/auth-shell.css")).catch(() => null);
const html = await (await fetch(BASE + "/login")).text();
const href = [...html.matchAll(/href="([^"]*auth-shell[^"]*\.css[^"]*)"/g)][0]?.[1];
const css = await (await fetch(BASE + href)).text();
console.log(
  "\nauth sheet served:", href?.split("/").pop(),
  "| .auth-legal a rule:", /\.auth-legal a/.test(css),
  "| bytes:", css.length,
);
console.log("login loads dashboard-only ui css?", /components\/ui|globals/.test(html) ? "check" : "no reference");
