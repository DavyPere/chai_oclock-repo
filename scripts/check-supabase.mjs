import "dotenv/config";
import crypto from "node:crypto";

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

const fingerprint = crypto.createHash("sha256").update(key).digest("hex");
const expectedFingerprint = "a7d49c75630e0192592adb2a19a4ff9983714f1678b8dc5f8352d3633e427645";

if (fingerprint !== expectedFingerprint) {
  console.error("Stored GitHub secret does not match the currently active publishable key for this Supabase project.");
  process.exit(1);
}

// Connectivity check used by GitHub Actions and local development.
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
