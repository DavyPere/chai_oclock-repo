import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const refreshToken = process.env.CANVA_REFRESH_TOKEN_BOOTSTRAP;

if (!url || !secret || !refreshToken) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_SECRET_KEY, and CANVA_REFRESH_TOKEN_BOOTSTRAP are required."
  );
}

const supabase = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { error } = await supabase.rpc("set_canva_refresh_token", {
  p_refresh_token: refreshToken,
});

if (error) throw error;

console.log("Canva refresh token stored in Supabase Vault.");
console.log("Delete CANVA_REFRESH_TOKEN_BOOTSTRAP from GitHub after this succeeds.");
