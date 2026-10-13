import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const token = req.headers.get("x-chai-key")?.trim();
  if (!token) {
    return json(401, { error: "unauthorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json(500, { error: "server_configuration_error" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tokenHash = await sha256Hex(token);

  const { data: client, error: clientError } = await supabase
    .from("sync_clients")
    .select("id,name")
    .eq("token_hash", tokenHash)
    .eq("enabled", true)
    .maybeSingle();

  if (clientError || !client) {
    return json(401, { error: "unauthorized" });
  }

  let body: {
    content_package_id?: string;
    decision?: "approve" | "reject";
    note?: string | null;
  };

  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.content_package_id || !body.decision) {
    return json(400, {
      error: "missing_fields",
      required: ["content_package_id", "decision"],
    });
  }

  if (!["approve", "reject"].includes(body.decision)) {
    return json(400, { error: "invalid_decision" });
  }

  const { data, error } = await supabase.rpc("review_content_package", {
    p_content_package_id: body.content_package_id,
    p_decision: body.decision,
    p_note: body.note ?? null,
    p_actor: client.name,
  });

  if (error) {
    return json(400, {
      error: "review_failed",
      message: error.message,
    });
  }

  await supabase
    .from("sync_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", client.id);

  return json(200, {
    ok: true,
    result: data,
  });
});
