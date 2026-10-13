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
const rawClientKey = crypto.randomBytes(32).toString("hex");
const tokenHash = crypto
  .createHash("sha256")
  .update(rawClientKey)
  .digest("hex");
const clientName = `ci-content-intake-${suffix}`;

let clientId = null;
let packageId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const { data: client, error: clientError } = await supabase
    .from("sync_clients")
    .insert({
      name: clientName,
      token_hash: tokenHash,
      enabled: true,
    })
    .select("id")
    .single();

  if (clientError) throw clientError;
  clientId = client.id;

  const fixtureRef = `neutral-system-fixture-${suffix}`;

  const res = await fetch(`${url}/functions/v1/submit-content`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chai-key": rawClientKey,
    },
    body: JSON.stringify({
      edition: "morning",
      content_type: "progress_update",
      headline: "CONTENT INTAKE TEST",
      poster_text: "Neutral sourced package verification",
      caption:
        "[SYSTEM TEST] Neutral sourced content intake verification only.",
      template_id: "user_update_01",
      render_payload: {
        HEADLINE: "CONTENT INTAKE TEST",
        SUBHEADLINE: "Neutral sourced package verification",
        ITEM_1: "Source attached",
        ITEM_2: "Review gate required",
        ITEM_3: "No automatic publishing",
      },
      sources: [
        {
          source_type: "system",
          source_title: "Neutral system integration fixture",
          source_reference: fixtureRef,
          verification_status: "verified",
          verification_notes: "Generated only for automated endpoint testing.",
        },
      ],
      intake_metadata: {
        test_run: true,
        purpose: "neutral HTTP integration verification",
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `submit-content failed: ${res.status} ${JSON.stringify(body)}`
    );
  }

  packageId = body.content_package_id;

  assert(body.status === "review", "Endpoint did not return review status.");
  assert(packageId, "Endpoint returned no content package id.");

  const { data: pkg, error: pkgError } = await supabase
    .from("content_packages")
    .select("id,status,headline,submitted_by,intake_metadata")
    .eq("id", packageId)
    .single();

  if (pkgError) throw pkgError;

  assert(pkg.status === "review", "Submitted package did not land in review.");
  assert(pkg.headline === "CONTENT INTAKE TEST", "Headline changed unexpectedly.");
  assert(pkg.submitted_by === clientName, "Submitting client was not recorded.");
  assert(pkg.intake_metadata?.test_run === true, "Intake metadata was not stored.");

  const { data: sources, error: sourcesError } = await supabase
    .from("content_package_sources")
    .select("source_type,source_title,source_reference,verification_status")
    .eq("content_package_id", packageId);

  if (sourcesError) throw sourcesError;

  assert(sources.length === 1, `Expected 1 source, got ${sources.length}.`);
  assert(sources[0].source_type === "system", "Wrong source type.");
  assert(
    sources[0].source_reference === fixtureRef,
    "Source reference was not preserved."
  );
  assert(
    sources[0].verification_status === "verified",
    "Source verification status was not preserved."
  );

  const { data: jobs, error: jobsError } = await supabase
    .from("render_jobs")
    .select("id")
    .eq("content_package_id", packageId);

  if (jobsError) throw jobsError;
  assert(
    jobs.length === 0,
    "Render job was created before human approval."
  );

  console.log("submit-content HTTP integration test passed.");
  console.log(
    "Sourced intake, review gating, attribution, and no-preapproval-render verified."
  );
} finally {
  if (packageId) {
    await supabase.from("content_packages").delete().eq("id", packageId);
  }
  if (clientId) {
    await supabase.from("sync_clients").delete().eq("id", clientId);
  }
}
