import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const clientId = process.env.CANVA_CLIENT_ID?.trim();
const clientSecret = process.env.CANVA_CLIENT_SECRET?.trim();

if (!supabaseUrl || !secret || !clientId || !clientSecret) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_SECRET_KEY, CANVA_CLIENT_ID, and CANVA_CLIENT_SECRET are required."
  );
}

const supabase = createClient(supabaseUrl, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { error: credentialsError } = await supabase.rpc(
  "set_canva_oauth_credentials",
  {
    p_client_id: clientId,
    p_client_secret: clientSecret,
  }
);
if (credentialsError) throw credentialsError;

const base64url = (buffer) =>
  Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const codeVerifier = base64url(crypto.randomBytes(64));
const codeChallenge = base64url(
  crypto.createHash("sha256").update(codeVerifier).digest()
);
const state = base64url(crypto.randomBytes(32));
const redirectUri =
  `${supabaseUrl}/functions/v1/canva-oauth-callback`;
const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

const { error: sessionError } = await supabase.rpc(
  "create_canva_oauth_session",
  {
    p_state: state,
    p_code_verifier: codeVerifier,
    p_redirect_uri: redirectUri,
    p_expires_at: expiresAt,
  }
);
if (sessionError) throw sessionError;

const params = new URLSearchParams({
  code_challenge: codeChallenge,
  code_challenge_method: "s256",
  scope: [
    "design:content:read",
    "design:content:write",
    "asset:read",
    "asset:write",
  ].join(" "),
  response_type: "code",
  client_id: clientId,
  state,
  redirect_uri: redirectUri,
});

console.log("Canva OAuth credentials stored in Supabase Vault.");
console.log(`CANVA_REDIRECT_URI=${redirectUri}`);
console.log(`CANVA_AUTHORIZATION_URL=https://www.canva.com/api/oauth/authorize?${params.toString()}`);
console.log(`AUTH_LINK_EXPIRES_AT=${expiresAt}`);
