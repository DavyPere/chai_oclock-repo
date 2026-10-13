import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
}

const supabase = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const suffix = crypto.randomUUID();
let runId = null;
let candidateId = null;
let packageId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const { data: run, error: runError } = await supabase
    .from("research_runs")
    .insert({
      trigger_type: "ci",
      status: "running",
      model: "fixture",
      metadata: { test_run: true },
    })
    .select("id")
    .single();

  if (runError) throw runError;
  runId = run.id;

  const { data: candidate, error: candidateError } = await supabase
    .from("research_candidates")
    .insert({
      research_run_id: runId,
      fingerprint: crypto
        .createHash("sha256")
        .update(`research-editor-fixture-${suffix}`)
        .digest("hex"),
      title: "RESEARCH EDITOR PIPELINE TEST",
      summary: "Neutral system verification candidate.",
      why_it_matters: "Verifies the sourced editorial handoff.",
      category: "general",
      location: "Kajiado County",
      locality_score: 80,
      importance_score: 50,
      freshness_score: 100,
      sensitive_topic: false,
      requires_corroboration: false,
      sources: [
        {
          source_type: "system",
          source_title: "Neutral research fixture",
          source_url: `https://example.com/chai-research-${suffix}`,
          published_at: null,
          verification_status: "verified",
          verification_notes: "CI fixture only.",
        },
      ],
      status: "candidate",
    })
    .select("id,status")
    .single();

  if (candidateError) throw candidateError;
  candidateId = candidate.id;
  assert(candidate.status === "candidate", "Candidate was not inserted.");

  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_research_candidate_for_editing",
    { p_candidate_id: candidateId }
  );

  if (claimError) throw claimError;
  assert(claimed === true, "Candidate could not be claimed for editing.");

  const { data: createdPackageId, error: packageError } = await supabase.rpc(
    "submit_content_package",
    {
      p_edition: "morning",
      p_content_type: "news_update",
      p_headline: "RESEARCH EDITOR PIPELINE TEST",
      p_poster_text: "Neutral editorial handoff verification",
      p_caption:
        "[SYSTEM TEST] Neutral Researcher and Editor pipeline verification.",
      p_template_id: "user_update_01",
      p_render_payload: {
        HEADLINE: "RESEARCH EDITOR PIPELINE TEST",
        SUBHEADLINE: "Neutral editorial handoff verification",
        ITEM_1: "Research candidate stored",
        ITEM_2: "Editor handoff recorded",
        ITEM_3: "Human approval still required",
      },
      p_sources: [
        {
          source_type: "system",
          source_title: "Neutral research fixture",
          source_reference: `research-editor-ci-${suffix}`,
          verification_status: "verified",
          verification_notes: "CI fixture only.",
        },
      ],
      p_submitted_by: "research-editor-ci",
      p_intake_metadata: {
        research_candidate_id: candidateId,
        research_run_id: runId,
        test_run: true,
      },
      p_source_image_asset_id: null,
    }
  );

  if (packageError) throw packageError;
  packageId = createdPackageId;

  const { error: linkError } = await supabase
    .from("research_candidates")
    .update({
      status: "submitted",
      content_package_id: packageId,
      editor_payload: {
        decision: "submit",
        fixture: true,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidateId);

  if (linkError) throw linkError;

  const { data: pkg, error: pkgError } = await supabase
    .from("content_packages")
    .select("status,submitted_by")
    .eq("id", packageId)
    .single();

  if (pkgError) throw pkgError;
  assert(pkg.status === "review", "Editor package bypassed human review.");
  assert(
    pkg.submitted_by === "research-editor-ci",
    "Editor attribution was not recorded."
  );

  const { data: sources, error: sourcesError } = await supabase
    .from("content_package_sources")
    .select("id,verification_status")
    .eq("content_package_id", packageId);

  if (sourcesError) throw sourcesError;
  assert(sources.length === 1, "Expected exactly one package source.");
  assert(
    sources[0].verification_status === "verified",
    "Source verification metadata was not preserved."
  );

  const { data: jobs, error: jobsError } = await supabase
    .from("render_jobs")
    .select("id")
    .eq("content_package_id", packageId);

  if (jobsError) throw jobsError;
  assert(jobs.length === 0, "Render job existed before human approval.");

  await supabase
    .from("research_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      candidate_count: 1,
      submitted_count: 1,
    })
    .eq("id", runId);

  console.log("Researcher + Editor integration test passed.");
  console.log(
    "Candidate storage, editor handoff, source trail, and human review gate verified."
  );
} finally {
  if (packageId) {
    await supabase.from("content_packages").delete().eq("id", packageId);
  }
  if (candidateId) {
    await supabase.from("research_candidates").delete().eq("id", candidateId);
  }
  if (runId) {
    await supabase.from("research_runs").delete().eq("id", runId);
  }
}
