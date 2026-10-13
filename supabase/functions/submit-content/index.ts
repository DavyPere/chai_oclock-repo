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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const token = req.headers.get("x-chai-key")?.trim();
  if (!token) return json(401, { error: "unauthorized" });

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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const required = [
    "edition",
    "content_type",
    "headline",
    "caption",
    "template_id",
    "render_payload",
    "sources",
  ];

  const missing = required.filter((key) => body?.[key] == null);
  if (missing.length) {
    return json(400, { error: "missing_fields", required: missing });
  }

  const { data: packageId, error } = await supabase.rpc(
    "submit_content_package",
    {
      p_edition: body.edition,
      p_content_type: body.content_type,
      p_headline: body.headline,
      p_poster_text: body.poster_text ?? null,
      p_caption: body.caption,
      p_template_id: body.template_id,
      p_render_payload: body.render_payload,
      p_sources: body.sources,
      p_submitted_by: client.name,
      p_intake_metadata: body.intake_metadata ?? {},
      p_source_image_asset_id: body.source_image_asset_id ?? null,
    },
  );

  if (error) {
    return json(400, {
      error: "submission_failed",
      message: error.message,
    });
  }

  await supabase
    .from("sync_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", client.id);

  return json(201, {
    ok: true,
    content_package_id: packageId,
    status: "review",
  });
});