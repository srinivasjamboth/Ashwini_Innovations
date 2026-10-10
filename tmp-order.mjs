import https from "node:https";

const agent = new https.Agent({ rejectUnauthorized: false });
const res = await fetch("https://localhost:3000/login", { agent });
const html = await res.text();

const order = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) =>
  (m[0].match(/href="([^"]+)"/) || [])[1],
);
console.log("stylesheet order:", order);
console.log("auth-shell position:", order.findIndex((h) => h?.includes("auth-shell")));
console.log("count:", order.length);

const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
console.log("title:", title);
console.log("robots meta:", (html.match(/<meta name="robots"[^>]*>/) || ["none"])[0]);
console.log("theme-color/globals present:", order.length > 0);
