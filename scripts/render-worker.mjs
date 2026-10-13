import { createClient } from "@supabase/supabase-js";
import {
  createAutofilledDesign,
  exportDesignPng,
  getCanvaAccessToken,
  removeBackground,
} from "../src/lib/canva-api.mjs";

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
}

const supabase = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let jobId = process.env.RENDER_JOB_ID || null;

function requiredText(payload, field, fallback = null) {
  const value = payload?.[field] ?? fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required render field: ${field}`);
  }
  return value.trim();
}

try {
  if (!jobId) {
    const { data, error } = await supabase.rpc("claim_next_render_job");
    if (error) throw error;
    jobId = data;
  }

  if (!jobId) {
    console.log("No queued render jobs.");
    process.exit(0);
  }

  const { data: job, error: jobError } = await supabase
    .from("render_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (jobError) throw jobError;

  const { data: pkg, error: pkgError } = await supabase
    .from("content_packages")
    .select("*")
    .eq("id", job.content_package_id)
    .single();
  if (pkgError) throw pkgError;

  if (pkg.status !== "approved") {
    throw new Error(`Package is not approved; current status is ${pkg.status}.`);
  }

  const { data: template, error: templateError } = await supabase
    .from("poster_templates")
    .select("*")
    .eq("id", job.poster_template_id)
    .single();
  if (templateError) throw templateError;

  if (!template.canva_design_id) {
    throw new Error("Template has no Canva autofill source design.");
  }

  const renderPayload = pkg.render_payload || {};
  const schema = template.autofill_schema || {};
  const canvaData = {};

  for (const [field, definition] of Object.entries(schema)) {
    if (definition?.type === "text") {
      const fallback =
        field === "HEADLINE" ? pkg.headline :
        field === "SUBHEADLINE" ? pkg.poster_text :
        null;
      canvaData[field] = {
        type: "text",
        text: requiredText(renderPayload, field, fallback),
      };
    }
  }

  let imageAssetId = null;

  if (pkg.source_image_asset_id) {
    const { data: sourceAsset, error: sourceError } = await supabase
      .from("assets")
      .select("canva_asset_id")
      .eq("id", pkg.source_image_asset_id)
      .single();
    if (sourceError) throw sourceError;
    imageAssetId = sourceAsset.canva_asset_id;

    if (!imageAssetId) {
      throw new Error("Source image asset is not linked to a Canva asset.");
    }
  } else {
    imageAssetId = schema?.PRIMARY_IMAGE?.default_asset_id || null;
  }

  if (!imageAssetId) {
    throw new Error("No Canva image asset is available for PRIMARY_IMAGE.");
  }

  const canvaToken = await getCanvaAccessToken(supabase);

  if (
    pkg.source_image_asset_id &&
    schema?.PRIMARY_IMAGE?.preprocess === "remove_background"
  ) {
    imageAssetId = await removeBackground(
      canvaToken,
      imageAssetId,
      `Chai O'Clock cutout ${pkg.id}`
    );
  }

  canvaData.PRIMARY_IMAGE = { type: "image", asset_id: imageAssetId };

  const title = `Chai O'Clock | ${(pkg.headline || pkg.id).slice(0, 180)}`;
  const design = await createAutofilledDesign(
    canvaToken,
    template.canva_design_id,
    title,
    canvaData
  );

  const exportUrl = await exportDesignPng(canvaToken, design.id);
  const exported = await fetch(exportUrl);
  if (!exported.ok) {
    throw new Error(`Unable to download Canva export: ${exported.status}`);
  }

  const bytes = new Uint8Array(await exported.arrayBuffer());
  const now = new Date();
  const storagePath = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    pkg.id,
    `${job.id}.png`,
  ].join("/");

  const { error: uploadError } = await supabase.storage
    .from("rendered-posters")
    .upload(storagePath, bytes, {
      contentType: "image/png",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data: asset, error: assetError } = await supabase
    .from("assets")
    .insert({
      storage_bucket: "rendered-posters",
      storage_path: storagePath,
      asset_type: "rendered_poster",
      source: "canva_render_worker",
      mime_type: "image/png",
      canva_design_id: design.id,
    })
    .select("id")
    .single();
  if (assetError) throw assetError;

  const { data: attached, error: completeError } = await supabase.rpc(
    "complete_render_job",
    {
      p_job_id: job.id,
      p_output_asset_id: asset.id,
      p_canva_design_id: design.id,
      p_canva_edit_url: design?.urls?.edit_url ?? design?.url ?? null,
      p_canva_view_url: design?.urls?.view_url ?? null,
    }
  );
  if (completeError) throw completeError;

  if (!attached) {
    console.log("Render completed but package was no longer approved; output was not staged.");
    process.exit(0);
  }

  console.log(`Rendered package ${pkg.id} successfully.`);
  console.log(`Canva design: ${design.id}`);
  console.log(`Supabase asset: ${asset.id}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);

  if (jobId) {
    await supabase.rpc("fail_render_job", {
      p_job_id: jobId,
      p_error_message: message,
    });
  }
  process.exit(1);
}
