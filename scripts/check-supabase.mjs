import "dotenv/config";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}

// Connectivity check used by GitHub Actions and local development.
// This verifies the Supabase REST API is reachable with the configured
// publishable key without assuming public table access.
const res = await fetch(`${url}/rest/v1/`, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`
  }
});

if (!res.ok) {
  console.error(`Supabase API check failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

console.log("Supabase API is reachable.");
console.log("Project ref: jrdtelveihwusdtpgnks");
