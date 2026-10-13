import "dotenv/config";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}

const isModernPublishable =
  key.startsWith("sb_publishable_") &&
  !/\s/.test(key);

const isLegacyAnonJwt =
  key.startsWith("eyJ") &&
  key.split(".").length === 3 &&
  !/\s/.test(key);

if (!isModernPublishable && !isLegacyAnonJwt) {
  console.error("Stored GitHub secret is not a recognized Supabase public client key.");
  process.exit(1);
}

// Query a normal RLS-protected table. A public client key may receive an
// empty array because RLS blocks anonymous rows; HTTP 200 still proves that
// GitHub Actions can authenticate to this Supabase project's Data API.
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
