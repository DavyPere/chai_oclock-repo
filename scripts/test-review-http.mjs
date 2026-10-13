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
const tokenHash = crypto.createHash("sha256").update(rawClientKey).digest("hex");
const clientName = `ci-http-review-${suffix}`;

let packageId = null;
let clientId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function callReview(decision) {
  const res = await fetch(`${url}/functions/v1/review-content`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chai-key": rawClientKey,
    },
    body: JSON.stringify({
      content_package_id: packageId,
      decision,
      note: "Automated neutral HTTP integration test",
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `review-content ${decision} failed: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return body;
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

  const { data: pkg, error: pkgError } = await supabase
    .from("content_packages")
    .insert({
      edition: "morning",
      content_type: "progress_update",
      headline: "HTTP PIPELINE TEST",
      poster_text: "Neutral endpoint verification",
      caption: "[SYSTEM TEST] Neutral approval endpoint verification.",
      template_id: "user_update_01",
      render_payload: {
        HEADLINE: "HTTP PIPELINE TEST",
        SUBHEADLINE: "Real HTTP endpoint verification",
        ITEM_1: "Approval endpoint reached",
        ITEM_2: "Render job queued",
        ITEM_3: "Cleanup follows",
      },
      status: "review",
    })
    .select("id")
    .single();

  if (pkgError) throw pkgError;
  packageId = pkg.id;

  const approved = await callReview("approve");
  assert(approved?.result?.status === "approved", "Package was not approved.");
  assert(approved?.result?.render_job_status === "queued", "Render job was not queued.");
  assert(
    approved?.result?.canva_brand_template_id === "EAHWrOFefQg",
    "Wrong Canva Brand Template selected."
  );

  const { data: queuedJobs, error: jobError } = await supabase
    .from("render_jobs")
    .select("id,status")
    .eq("content_package_id", packageId)
    .eq("status", "queued");

  if (jobError) throw jobError;
  assert(queuedJobs.length === 1, `Expected 1 queued render job, got ${queuedJobs.length}.`);

  const rejected = await callReview("reject");
  assert(rejected?.result?.status === "rejected", "Package was not rejected.");

  const { data: finalJob, error: finalJobError } = await supabase
    .from("render_jobs")
    .select("status")
    .eq("content_package_id", packageId)
    .single();

  if (finalJobError) throw finalJobError;
  assert(finalJob.status === "cancelled", "Queued render job was not cancelled.");

  const { data: events, error: eventsError } = await supabase
    .from("approval_events")
    .select("decision")
    .eq("content_package_id", packageId)
    .order("created_at", { ascending: true });

  if (eventsError) throw eventsError;
  assert(events.length === 2, `Expected 2 audit events, got ${events.length}.`);
  assert(events[0].decision === "approve" && events[1].decision === "reject",
    "Approval audit order is incorrect.");

  console.log("review-content HTTP integration test passed.");
  console.log("Approval, queue creation, rejection, cancellation, and audit trail verified.");
} finally {
  if (packageId) {
    await supabase.from("content_packages").delete().eq("id", packageId);
  }
  if (clientId) {
    await supabase.from("sync_clients").delete().eq("id", clientId);
  }
}
