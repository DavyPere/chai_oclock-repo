import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Connectivity check used by GitHub Actions and local development.
// This verifies that the Supabase API is reachable without assuming public
// table access. Chai O'Clock's tables intentionally use RLS and may return
// permission errors until an authenticated policy is added.
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
