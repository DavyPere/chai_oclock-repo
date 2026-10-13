import "dotenv/config";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}

const expectedPrefix = "sb_publishable_";
const formatLooksValid =
  key.startsWith(expectedPrefix) &&
  key.length === 46 &&
  !/\s/.test(key);

if (!formatLooksValid) {
  console.error("Stored GitHub secret does not match the expected Supabase publishable-key format.");
  process.exit(1);
}

// Use a normal Data API resource rather than /rest/v1/ root.
// The root schema endpoint requires a server-side secret key.
// poster_templates is RLS-protected, so an unauthenticated publishable-key
// request may return an empty array; HTTP 200 still proves the client key,
// API gateway, project, and Data API are connected correctly.
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

console.log("Supabase Data API is reachable with the configured publishable key.");
console.log("Project ref: jrdtelveihwusdtpgnks");
