import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SESSION_SECONDS = 60 * 60 * 24 * 30;
const ALLOWED_ORIGINS = new Set([
  "https://davypere.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function admin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase server credentials unavailable.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    ...(allowed ? { "access-control-allow-origin": allowed } : {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "content-type,x-chai-dashboard-session",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...cors(req),
    },
  });
}

async function authenticate(
  req: Request,
  supabase: ReturnType<typeof admin>,
) {
  const raw = req.headers.get("x-chai-dashboard-session")?.trim();
  if (!raw) return null;

  const hash = await sha256Hex(raw);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("dashboard_sessions")
    .select("id,actor,expires_at")
    .eq("token_hash", hash)
    .eq("actor", "mobile-review-dashboard-v3")
    .gt("expires_at", now)
    .maybeSingle();

  if (error || !data) return null;

  await supabase
    .from("dashboard_sessions")
    .update({ last_used_at: now })
    .eq("id", data.id);

  return { ...data, tokenHash: hash };
}

async function setupSession(
  setupToken: string,
  supabase: ReturnType<typeof admin>,
) {
  const tokenHash = await sha256Hex(setupToken);
  const now = new Date().toISOString();

  const { data: setup, error } = await supabase
    .from("dashboard_setup_tokens")
    .select("id")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error || !setup) return null;

  const { data: consumed, error: consumeError } = await supabase
    .from("dashboard_setup_tokens")
    .update({ used_at: now })
    .eq("id", setup.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (consumeError || !consumed) return null;

  const rawSession = randomToken(32);
  const sessionHash = await sha256Hex(rawSession);
  const expiresAt = new Date(
    Date.now() + SESSION_SECONDS * 1000,
  ).toISOString();

  const { error: sessionError } = await supabase
    .from("dashboard_sessions")
    .insert({
      token_hash: sessionHash,
      actor: "mobile-review-dashboard-v3",
      expires_at: expiresAt,
      last_used_at: now,
    });

  if (sessionError) return null;

  return { session_token: rawSession, expires_at: expiresAt };
}

async function queueData(supabase: ReturnType<typeof admin>) {
  const { data: packages, error } = await supabase
    .from("content_packages")
    .select(
      "id,edition,content_type,headline,poster_text,caption,render_payload,status,approved_at,created_at,updated_at,image_asset_id",
    )
    .in("status", ["review", "approved"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  const packageIds = (packages || []).map((p) => p.id);
  const assetIds = (packages || [])
    .map((p) => p.image_asset_id)
    .filter(Boolean);

  let jobs: any[] = [];
  if (packageIds.length) {
    const { data, error: jobsError } = await supabase
      .from("render_jobs")
      .select(
        "id,content_package_id,status,error_message,canva_design_id,canva_edit_url,canva_view_url,created_at,updated_at",
      )
      .in("content_package_id", packageIds)
      .order("created_at", { ascending: false });

    if (jobsError) throw jobsError;
    jobs = data || [];
  }

  const latestJobByPackage = new Map<string, any>();
  for (const job of jobs) {
    if (!latestJobByPackage.has(job.content_package_id)) {
      latestJobByPackage.set(job.content_package_id, job);
    }
  }

  const assetById = new Map<string, any>();
  if (assetIds.length) {
    const { data: assets, error: assetsError } = await supabase
      .from("assets")
      .select("id,storage_bucket,storage_path,mime_type")
      .in("id", assetIds);

    if (assetsError) throw assetsError;

    for (const asset of assets || []) {
      const { data: signed } = await supabase.storage
        .from(asset.storage_bucket)
        .createSignedUrl(asset.storage_path, 60 * 15);

      assetById.set(asset.id, {
        ...asset,
        signed_url: signed?.signedUrl || null,
      });
    }
  }

  return (packages || []).map((pkg) => ({
    ...pkg,
    render_job: latestJobByPackage.get(pkg.id) || null,
    image_asset: pkg.image_asset_id
      ? assetById.get(pkg.image_asset_id) || null
      : null,
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(req) });
  }

  const origin = req.headers.get("origin") || "";
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(req, 403, { error: "origin_not_allowed" });
  }

  const supabase = admin();
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (req.method === "GET" && action === "health") {
    return json(req, 200, { ok: true });
  }

  if (req.method === "POST" && action === "setup") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    if (!body?.setup_token || typeof body.setup_token !== "string") {
      return json(req, 400, { error: "missing_setup_token" });
    }

    const session = await setupSession(body.setup_token, supabase);
    if (!session) {
      return json(req, 401, {
        error: "invalid_or_used_setup_token",
      });
    }

    return json(req, 200, { ok: true, ...session });
  }

  const session = await authenticate(req, supabase);
  if (!session) {
    return json(req, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && action === "queue") {
    try {
      return json(req, 200, { items: await queueData(supabase) });
    } catch (error) {
      return json(req, 500, {
        error: "queue_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (req.method === "POST" && action === "decision") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    if (
      !body?.content_package_id ||
      !["approve", "reject"].includes(body?.decision)
    ) {
      return json(req, 400, { error: "invalid_decision_request" });
    }

    const { data, error } = await supabase.rpc("review_content_package", {
      p_content_package_id: body.content_package_id,
      p_decision: body.decision,
      p_note: body.note ?? null,
      p_actor: session.actor,
    });

    if (error) {
      return json(req, 400, {
        error: "review_failed",
        message: error.message,
      });
    }

    return json(req, 200, { ok: true, result: data });
  }

  if (req.method === "POST" && action === "logout") {
    await supabase
      .from("dashboard_sessions")
      .delete()
      .eq("token_hash", session.tokenHash);

    return json(req, 200, { ok: true });
  }

  return json(req, 404, { error: "not_found" });
});