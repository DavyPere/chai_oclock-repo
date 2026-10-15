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
      "id,edition,content_type,headline,poster_text,caption,render_payload,status,approved_at,created_at,updated_at,image_asset_id,submitted_by,intake_metadata",
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

  const sourcesByPackage = new Map<string, any[]>();
  if (packageIds.length) {
    const { data: sources, error: sourcesError } = await supabase
      .from("content_package_sources")
      .select(
        "id,content_package_id,source_type,source_title,source_url,source_reference,published_at,verification_status,verification_notes,created_at",
      )
      .in("content_package_id", packageIds)
      .order("created_at", { ascending: true });

    if (sourcesError) throw sourcesError;

    for (const source of sources || []) {
      const list = sourcesByPackage.get(source.content_package_id) || [];
      list.push(source);
      sourcesByPackage.set(source.content_package_id, list);
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
    sources: sourcesByPackage.get(pkg.id) || [],
    image_asset: pkg.image_asset_id
      ? assetById.get(pkg.image_asset_id) || null
      : null,
  }));
}

async function fieldReportsData(supabase: ReturnType<typeof admin>) {
  const { data: reports, error } = await supabase
    .from("field_reports")
    .select(
      "id,report_date,activity_type,activity_title,location_name,ward,constituency,participants,purpose,status,submitted_by,content_package_id,photographer_name,photographer_drive_url,created_at,updated_at",
    )
    .order("report_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  const ids = (reports || []).map((r) => r.id);
  const entriesByReport = new Map<string, any[]>();
  const issuesByReport = new Map<string, any[]>();
  const evidenceByReport = new Map<string, any[]>();

  if (ids.length) {
    const [
      { data: entries, error: entriesError },
      { data: issues, error: issuesError },
      { data: evidence, error: evidenceError },
    ] = await Promise.all([
      supabase
        .from("field_report_entries")
        .select(
          "id,field_report_id,entry_type,statement,attribution,verification_status,created_at",
        )
        .in("field_report_id", ids)
        .order("created_at", { ascending: true }),
      supabase
        .from("field_report_issues")
        .select(
          "id,field_report_id,title,description,status,owner,due_date,created_at,updated_at",
        )
        .in("field_report_id", ids)
        .order("created_at", { ascending: true }),
      supabase
        .from("field_report_evidence")
        .select(
          "id,field_report_id,evidence_type,title,source_url,source_reference,asset_id,notes,verification_status,created_at",
        )
        .in("field_report_id", ids)
        .order("created_at", { ascending: true }),
    ]);

    if (entriesError) throw entriesError;
    if (issuesError) throw issuesError;
    if (evidenceError) throw evidenceError;

    for (const item of entries || []) {
      const list = entriesByReport.get(item.field_report_id) || [];
      list.push(item);
      entriesByReport.set(item.field_report_id, list);
    }
    for (const item of issues || []) {
      const list = issuesByReport.get(item.field_report_id) || [];
      list.push(item);
      issuesByReport.set(item.field_report_id, list);
    }
    for (const item of evidence || []) {
      const list = evidenceByReport.get(item.field_report_id) || [];
      list.push(item);
      evidenceByReport.set(item.field_report_id, list);
    }
  }

  const evidenceAssetIds = [
    ...new Set(
      [...evidenceByReport.values()]
        .flat()
        .map((item) => item.asset_id)
        .filter(Boolean),
    ),
  ];

  const evidenceAssetById = new Map<string, any>();
  if (evidenceAssetIds.length) {
    const { data: assets, error: assetsError } = await supabase
      .from("assets")
      .select("id,storage_bucket,storage_path,mime_type")
      .in("id", evidenceAssetIds);

    if (assetsError) throw assetsError;

    for (const asset of assets || []) {
      const { data: signed } = await supabase.storage
        .from(asset.storage_bucket)
        .createSignedUrl(asset.storage_path, 60 * 15);

      evidenceAssetById.set(asset.id, {
        ...asset,
        signed_url: signed?.signedUrl || null,
      });
    }
  }

  return (reports || []).map((report) => ({
    ...report,
    entries: entriesByReport.get(report.id) || [],
    issues: issuesByReport.get(report.id) || [],
    evidence: (evidenceByReport.get(report.id) || []).map((item) => ({
      ...item,
      asset: item.asset_id ? evidenceAssetById.get(item.asset_id) || null : null,
    })),
  }));
}

async function messagingBankData(supabase: ReturnType<typeof admin>) {
  const [
    { data: pillars, error: pillarsError },
    { data: items, error: itemsError },
  ] = await Promise.all([
    supabase
      .from("message_pillars")
      .select("id,slug,name,description,sort_order,active")
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("message_bank_items")
      .select(
        "id,internal_label,category,pillar_id,exact_text,caption_exact,attribution,claim_type,verification_status,source_url,source_reference,source_notes,template_key,image_guidance,status,wording_locked,created_by,reviewed_by,reviewed_at,notes,created_at,updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(200),
  ]);

  if (pillarsError) throw pillarsError;
  if (itemsError) throw itemsError;

  const itemIds = (items || []).map((item) => item.id);
  const eventsByItem = new Map<string, any[]>();

  if (itemIds.length) {
    const { data: events, error: eventsError } = await supabase
      .from("message_bank_events")
      .select(
        "id,message_bank_item_id,event_type,actor,note,created_at",
      )
      .in("message_bank_item_id", itemIds)
      .order("created_at", { ascending: false });

    if (eventsError) throw eventsError;

    for (const event of events || []) {
      const list = eventsByItem.get(event.message_bank_item_id) || [];
      if (list.length < 5) {
        list.push(event);
        eventsByItem.set(event.message_bank_item_id, list);
      }
    }
  }

  return {
    pillars: pillars || [],
    items: (items || []).map((item) => ({
      ...item,
      events: eventsByItem.get(item.id) || [],
    })),
  };
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
        message:
          error instanceof Error
            ? error.message
            : JSON.stringify(error),
      });
    }
  }

  if (req.method === "GET" && action === "field-reports") {
    try {
      return json(req, 200, { items: await fieldReportsData(supabase) });
    } catch (error) {
      return json(req, 500, {
        error: "field_reports_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (req.method === "POST" && action === "field-report") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    const required = [
      "report_date",
      "activity_type",
      "activity_title",
      "location_name",
      "purpose",
      "entries",
    ];

    const missing = required.filter((key) => body?.[key] == null);
    if (missing.length) {
      return json(req, 400, { error: "missing_fields", required: missing });
    }

    if (!Array.isArray(body.entries) || body.entries.length < 1) {
      return json(req, 400, { error: "at_least_one_entry_required" });
    }

    const { data: reportId, error } = await supabase.rpc(
      "create_field_report_v2",
      {
        p_report_date: body.report_date,
        p_activity_type: body.activity_type,
        p_activity_title: body.activity_title,
        p_location_name: body.location_name,
        p_ward: body.ward ?? null,
        p_constituency: body.constituency ?? null,
        p_participants: Array.isArray(body.participants)
          ? body.participants
          : [],
        p_purpose: body.purpose,
        p_entries: body.entries,
        p_issues: Array.isArray(body.issues) ? body.issues : [],
        p_evidence: Array.isArray(body.evidence) ? body.evidence : [],
        p_submitted_by: session.actor,
        p_photographer_name: body.photographer_name ?? null,
        p_photographer_drive_url: body.photographer_drive_url ?? null,
      },
    );

    if (error) {
      return json(req, 400, {
        error: "field_report_create_failed",
        message: error.message,
      });
    }

    return json(req, 201, {
      ok: true,
      field_report_id: reportId,
      status: "saved",
    });
  }

  if (req.method === "POST" && action === "field-report-package") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    if (!body?.field_report_id) {
      return json(req, 400, { error: "field_report_id_required" });
    }

    const { data: packageId, error } = await supabase.rpc(
      "prepare_field_report_package",
      {
        p_field_report_id: body.field_report_id,
        p_actor: session.actor,
      },
    );

    if (error) {
      return json(req, 400, {
        error: "field_report_package_failed",
        message: error.message,
      });
    }

    return json(req, 200, {
      ok: true,
      content_package_id: packageId,
      status: "review",
    });
  }

  if (req.method === "POST" && action === "field-report-photo-upload") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json(req, 400, { error: "invalid_multipart_form" });
    }

    const fieldReportId = String(form.get("field_report_id") || "").trim();
    const upload = form.get("file");

    if (!fieldReportId) {
      return json(req, 400, { error: "field_report_id_required" });
    }

    if (!(upload instanceof File)) {
      return json(req, 400, { error: "photo_file_required" });
    }

    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);

    if (!allowedMimeTypes.has(upload.type)) {
      return json(req, 400, {
        error: "unsupported_photo_type",
        allowed: [...allowedMimeTypes],
      });
    }

    const maxBytes = 12 * 1024 * 1024;
    if (upload.size < 1 || upload.size > maxBytes) {
      return json(req, 400, {
        error: "photo_size_invalid",
        max_bytes: maxBytes,
      });
    }

    const { data: report, error: reportError } = await supabase
      .from("field_reports")
      .select("id,report_date")
      .eq("id", fieldReportId)
      .maybeSingle();

    if (reportError || !report) {
      return json(req, 404, { error: "field_report_not_found" });
    }

    const extByMime: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };

    const reportDate = String(report.report_date || new Date().toISOString().slice(0, 10));
    const year = reportDate.slice(0, 4);
    const month = reportDate.slice(5, 7);
    const objectPath =
      `field-reports/${year}/${month}/${fieldReportId}/${crypto.randomUUID()}.${extByMime[upload.type]}`;

    const { error: uploadError } = await supabase.storage
      .from("source-media")
      .upload(objectPath, upload, {
        contentType: upload.type,
        upsert: false,
      });

    if (uploadError) {
      return json(req, 500, {
        error: "photo_storage_upload_failed",
        message: uploadError.message,
      });
    }

    let assetId: string | null = null;

    try {
      const { data: asset, error: assetError } = await supabase
        .from("assets")
        .insert({
          storage_bucket: "source-media",
          storage_path: objectPath,
          asset_type: "source_image",
          source: "field_report_upload",
          mime_type: upload.type,
          verification_status: "unverified",
        })
        .select("id")
        .single();

      if (assetError) throw assetError;
      assetId = asset.id;

      const title =
        upload.name && upload.name.trim()
          ? upload.name.trim().slice(0, 240)
          : "Uploaded field photo";

      const { data: evidence, error: evidenceError } = await supabase
        .from("field_report_evidence")
        .insert({
          field_report_id: fieldReportId,
          evidence_type: "photo",
          title,
          source_reference: `uploaded-photo:${assetId}`,
          asset_id: assetId,
          notes: "Direct upload from the private Chai O'Clock field reporting dashboard.",
          verification_status: "unverified",
        })
        .select("id,asset_id,title,verification_status")
        .single();

      if (evidenceError) throw evidenceError;

      const { data: signed } = await supabase.storage
        .from("source-media")
        .createSignedUrl(objectPath, 60 * 15);

      return json(req, 201, {
        ok: true,
        evidence: {
          ...evidence,
          signed_url: signed?.signedUrl || null,
        },
      });
    } catch (error) {
      if (assetId) {
        await supabase.from("assets").delete().eq("id", assetId);
      }
      await supabase.storage.from("source-media").remove([objectPath]);

      return json(req, 500, {
        error: "photo_evidence_attach_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (req.method === "POST" && action === "field-report-drive-evidence") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    const fieldReportId = String(body?.field_report_id || "").trim();
    const driveUrl = String(body?.drive_url || "").trim();
    const photographerName = String(body?.photographer_name || "").trim();

    if (!fieldReportId) {
      return json(req, 400, { error: "field_report_id_required" });
    }

    if (!/^https:\/\/drive\.google\.com\//i.test(driveUrl)) {
      return json(req, 400, {
        error: "invalid_google_drive_url",
        message: "Google Drive evidence must begin with https://drive.google.com/",
      });
    }

    const { data: report, error: reportError } = await supabase
      .from("field_reports")
      .select("id")
      .eq("id", fieldReportId)
      .maybeSingle();

    if (reportError || !report) {
      return json(req, 404, { error: "field_report_not_found" });
    }

    const { data: existing, error: existingError } = await supabase
      .from("field_report_evidence")
      .select("id,source_url")
      .eq("field_report_id", fieldReportId)
      .eq("source_url", driveUrl)
      .maybeSingle();

    if (existingError) {
      return json(req, 500, {
        error: "drive_evidence_lookup_failed",
        message: existingError.message,
      });
    }

    let evidence = existing;

    if (!evidence) {
      const { data: inserted, error: insertError } = await supabase
        .from("field_report_evidence")
        .insert({
          field_report_id: fieldReportId,
          evidence_type: "photo",
          title: photographerName
            ? `${photographerName} — Google Drive folder`
            : "Photographer Google Drive folder",
          source_url: driveUrl,
          notes: "Photographer media handoff folder attached from the Evidence section.",
          verification_status: "unverified",
        })
        .select(
          "id,field_report_id,evidence_type,title,source_url,source_reference,asset_id,notes,verification_status,created_at",
        )
        .single();

      if (insertError) {
        return json(req, 500, {
          error: "drive_evidence_insert_failed",
          message: insertError.message,
        });
      }

      evidence = inserted;
    }

    const { error: updateError } = await supabase
      .from("field_reports")
      .update({
        photographer_name: photographerName || null,
        photographer_drive_url: driveUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", fieldReportId);

    if (updateError) {
      return json(req, 500, {
        error: "drive_evidence_report_update_failed",
        message: updateError.message,
      });
    }

    return json(req, 200, {
      ok: true,
      evidence,
      photographer_drive_url: driveUrl,
    });
  }

  if (req.method === "GET" && action === "messaging-bank") {
    try {
      return json(req, 200, await messagingBankData(supabase));
    } catch (error) {
      return json(req, 500, {
        error: "messaging_bank_load_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (req.method === "POST" && action === "message-bank-item") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    const { data: itemId, error } = await supabase.rpc(
      "create_message_bank_item",
      {
        p_internal_label: body.internal_label ?? null,
        p_category: body.category ?? "other",
        p_pillar_id: body.pillar_id ?? null,
        p_exact_text: body.exact_text ?? null,
        p_caption_exact: body.caption_exact ?? null,
        p_attribution: body.attribution ?? null,
        p_claim_type: body.claim_type ?? "opinion",
        p_verification_status: body.verification_status ?? "not_required",
        p_source_url: body.source_url ?? null,
        p_source_reference: body.source_reference ?? null,
        p_source_notes: body.source_notes ?? null,
        p_template_key: body.template_key ?? null,
        p_image_guidance: body.image_guidance ?? null,
        p_notes: body.notes ?? null,
        p_actor: session.actor,
      },
    );

    if (error) {
      return json(req, 400, {
        error: "message_bank_create_failed",
        message: error.message,
      });
    }

    return json(req, 201, {
      ok: true,
      message_bank_item_id: itemId,
      status: "draft",
    });
  }

  if (req.method === "POST" && action === "message-bank-item-update") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    if (!body?.id) {
      return json(req, 400, { error: "message_bank_item_id_required" });
    }

    const { error } = await supabase.rpc(
      "update_message_bank_item",
      {
        p_item_id: body.id,
        p_internal_label: body.internal_label ?? null,
        p_category: body.category ?? "other",
        p_pillar_id: body.pillar_id ?? null,
        p_exact_text: body.exact_text ?? null,
        p_caption_exact: body.caption_exact ?? null,
        p_attribution: body.attribution ?? null,
        p_claim_type: body.claim_type ?? "opinion",
        p_verification_status: body.verification_status ?? "not_required",
        p_source_url: body.source_url ?? null,
        p_source_reference: body.source_reference ?? null,
        p_source_notes: body.source_notes ?? null,
        p_template_key: body.template_key ?? null,
        p_image_guidance: body.image_guidance ?? null,
        p_notes: body.notes ?? null,
        p_actor: session.actor,
      },
    );

    if (error) {
      return json(req, 400, {
        error: "message_bank_update_failed",
        message: error.message,
      });
    }

    return json(req, 200, { ok: true });
  }

  if (req.method === "POST" && action === "message-bank-status") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    if (
      !body?.id ||
      !["draft", "review", "approved", "paused", "retired"].includes(
        body?.status,
      )
    ) {
      return json(req, 400, { error: "invalid_message_bank_status_request" });
    }

    const { error } = await supabase.rpc(
      "set_message_bank_status",
      {
        p_item_id: body.id,
        p_status: body.status,
        p_note: body.note ?? null,
        p_actor: session.actor,
      },
    );

    if (error) {
      return json(req, 400, {
        error: "message_bank_status_failed",
        message: error.message,
      });
    }

    return json(req, 200, { ok: true, status: body.status });
  }

  if (req.method === "POST" && action === "field-report-issue-status") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, 400, { error: "invalid_json" });
    }

    const allowed = [
      "reported",
      "verified",
      "action_required",
      "in_progress",
      "completed",
      "follow_up_needed",
    ];

    if (!body?.issue_id || !allowed.includes(body?.status)) {
      return json(req, 400, { error: "invalid_issue_status_request" });
    }

    const { data, error } = await supabase
      .from("field_report_issues")
      .update({
        status: body.status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.issue_id)
      .select("id,status,updated_at")
      .maybeSingle();

    if (error || !data) {
      return json(req, 400, {
        error: "issue_status_update_failed",
        message: error?.message || "issue not found",
      });
    }

    return json(req, 200, { ok: true, issue: data });
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