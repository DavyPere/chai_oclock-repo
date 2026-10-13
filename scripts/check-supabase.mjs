import "dotenv/config";

const url = process.env.SUPABASE_URL;
const rawKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !rawKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}

const key = rawKey.trim();

const diagnostics = {
  length: key.length,
  startsModernPublishable: key.startsWith("sb_publishable_"),
  startsModernSecret: key.startsWith("sb_secret_"),
  startsLegacyJwt: key.startsWith("eyJ"),
  startsAssignment: key.startsWith("SUPABASE_PUBLISHABLE_KEY="),
  wrappedInQuotes:
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'")),
  containsWhitespace: /\s/.test(key)
};

console.log("Supabase secret shape:", JSON.stringify(diagnostics));

const isModernPublishable =
  diagnostics.startsModernPublishable &&
  !diagnostics.containsWhitespace;

const isLegacyAnonJwt =
  diagnostics.startsLegacyJwt &&
  key.split(".").length === 3 &&
  !diagnostics.containsWhitespace;

if (!isModernPublishable && !isLegacyAnonJwt) {
  console.error("Stored GitHub secret is not a recognized Supabase public client key.");
  process.exit(1);
}

const endpoint =
  `${url}/rest/v1/poster_templates?select=id&limit=1`;

const res = await fetch(endpoint, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`
  }
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Supabase Data API check failed: ${res.status} ${res.statusText}`);
  console.error(body.slice(0, 300));
  process.exit(1);
}

console.log("Supabase Data API is reachable with the configured public client key.");
console.log("Project ref: jrdtelveihwusdtpgnks");
