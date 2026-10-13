import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const CANVA_CAPABILITIES_URL =
  "https://api.canva.com/rest/v1/users/me/capabilities";

function html(status: number, title: string, message: string) {
  const safe = (value: string) =>
    value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char] ?? char));

  return new Response(
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safe(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;line-height:1.5}
    .card{border:1px solid #ddd;border-radius:16px;padding:28px}
    h1{margin-top:0}
  </style>
</head>
<body><div class="card"><h1>${safe(title)}</h1><p>${safe(message)}</p></div></body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") {
    return html(405, "Method not allowed", "Use the Canva authorization link.");
  }

  const url = new URL(req.url);
  const oauthError = url.searchParams.get("error");
  const oauthErrorDescription = url.searchParams.get("error_description");

  if (oauthError) {
    return html(
      400,
      "Canva authorization cancelled",
      oauthErrorDescription || oauthError
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return html(400, "Invalid callback", "The authorization code or state is missing.");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return html(500, "Server configuration error", "Supabase credentials are unavailable.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: sessionRows, error: sessionError } = await supabase.rpc(
    "consume_canva_oauth_session",
    { p_state: state }
  );

  if (sessionError) {
    return html(500, "OAuth session error", sessionError.message);
  }

  const session = Array.isArray(sessionRows) ? sessionRows[0] : sessionRows;
  if (!session?.code_verifier || !session?.redirect_uri) {
    return html(
      400,
      "Authorization link expired",
      "Generate a new Canva authorization link and try again."
    );
  }

  const { data: credentialRows, error: credentialError } = await supabase.rpc(
    "get_canva_oauth_credentials"
  );

  if (credentialError) {
    return html(500, "Credential error", credentialError.message);
  }

  const credentials = Array.isArray(credentialRows)
    ? credentialRows[0]
    : credentialRows;

  if (!credentials?.client_id || !credentials?.client_secret) {
    return html(
      500,
      "Canva credentials missing",
      "Store the Canva Client ID and Client Secret first."
    );
  }

  const basic = btoa(
    `${credentials.client_id}:${credentials.client_secret}`
  );

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: session.code_verifier,
    redirect_uri: session.redirect_uri,
  });

  const tokenResponse = await fetch(CANVA_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  const tokenBody = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok) {
    return html(
      400,
      "Canva token exchange failed",
      `Canva returned HTTP ${tokenResponse.status}. Generate a new authorization link after checking the app configuration.`
    );
  }

  if (!tokenBody?.refresh_token || !tokenBody?.access_token) {
    return html(
      500,
      "Incomplete Canva token response",
      "Canva did not return both an access token and a refresh token."
    );
  }

  const { error: storeError } = await supabase.rpc(
    "set_canva_refresh_token",
    { p_refresh_token: tokenBody.refresh_token }
  );

  if (storeError) {
    return html(500, "Token storage failed", storeError.message);
  }

  let capabilityNote = "Canva OAuth is connected and the refresh token is stored securely.";

  try {
    const capabilityResponse = await fetch(CANVA_CAPABILITIES_URL, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
    });
    const capabilityBody = await capabilityResponse.json().catch(() => ({}));
    const capabilities = Array.isArray(capabilityBody?.capabilities)
      ? capabilityBody.capabilities
      : [];

    const hasAutofill = capabilities.includes("autofill");
    capabilityNote += hasAutofill
      ? " Autofill capability is available."
      : " OAuth succeeded; autofill capability was not reported by Canva.";
  } catch {
    // OAuth connection remains valid even if the optional capability check fails.
  }

  return html(
    200,
    "Chai O'Clock connected to Canva",
    capabilityNote + " You can close this tab and return to ChatGPT."
  );
});
