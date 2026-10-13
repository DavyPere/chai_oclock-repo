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
  console.error(`Starts with sb_publishable_: ${key.startsWith(expectedPrefix)}`);
  console.error(`Length is 46 characters: ${key.length === 46}`);
  console.error(`Contains whitespace: ${/\s/.test(key)}`);
  process.exit(1);
}

// Connectivity check used by GitHub Actions and local development.
// Modern Supabase publishable keys are sent via the apikey header.
const res = await fetch(`${url}/rest/v1/`, {
  headers: {
    apikey: key
  }
});

if (!res.ok) {
  console.error(`Supabase API check failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

console.log("Supabase API is reachable.");
console.log("Project ref: jrdtelveihwusdtpgnks");
