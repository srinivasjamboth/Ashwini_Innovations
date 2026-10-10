// Throwaway verification, phase 2: the shell attributes + field inventory.
const BASE = "https://localhost:3000";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

for (const route of ["/login", "/signup", "/forgot-password", "/reset-password"]) {
  const html = await (await fetch(BASE + route)).text();
  const shell = (html.match(/<div class="auth-shell[^"]*"[^>]*>/) || [])[0] || "NONE";
  const inputs = [...html.matchAll(/<input([^>]*class="auth-input"[^>]*)>/g)].map((m) => {
    const type = (m[1].match(/type="([^"]+)"/) || [])[1];
    const ac = (m[1].match(/autocomplete="([^"]+)"/) || [])[1];
    const ph = (m[1].match(/placeholder="([^"]+)"/) || [])[1];
    return `${type}/${ac || "-"}/${ph}`;
  });
  console.log(
    `\n${route}\n  SHELL: ${shell}\n  FIELDS(${inputs.length}): ${JSON.stringify(inputs)}`,
  );
  console.log(
    "  labels:",
    JSON.stringify([...html.matchAll(/<label class="sr-only" for="[^"]*">([^<]*)<\/label>/g)].map((m) => m[1])),
  );
  console.log(
    "  links:",
    JSON.stringify(
      [...html.matchAll(/<a[^>]*class="auth-(link|submit-secondary|brand)"[^>]*href="([^"]*)"/g)].map(
        (m) => `${m[1]}->${m[2]}`,
      ),
    ),
  );
  console.log(
    "  buttons:",
    JSON.stringify([...html.matchAll(/<button[^>]*class="auth-submit"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim())),
  );
  const panel = (html.match(/<aside class="auth-panel">([\s\S]*?)<\/aside>/) || [])[1];
  console.log("  panel copy:", panel ? panel.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "NONE");
}
