import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");

const supabase = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const rawSession = crypto.randomBytes(32).toString("hex");
const sessionHash = crypto.createHash("sha256").update(rawSession).digest("hex");
let sessionId = null;
let reportId = null;
let packageId = null;
let uploadedAssetId = null;
let uploadedStoragePath = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(action, method = "GET", body = null) {
  const res = await fetch(`${url}/functions/v1/review-dashboard-api?action=${encodeURIComponent(action)}`, {
    method,
    headers: {
      ...(body ? {"content-type":"application/json"} : {}),
      "x-chai-dashboard-session": rawSession,
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${action} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function uploadFixturePhoto(fieldReportId) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2YQAAAABJRU5ErkJggg==",
    "base64"
  );
  const form = new FormData();
  form.append("field_report_id", fieldReportId);
  form.append(
    "file",
    new File([png], "field-report-test.png", { type: "image/png" }),
    "field-report-test.png"
  );

  const res = await fetch(
    `${url}/functions/v1/review-dashboard-api?action=field-report-photo-upload`,
    {
      method: "POST",
      headers: {
        "x-chai-dashboard-session": rawSession,
      },
      body: form,
    }
  );

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `field-report-photo-upload failed: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

try {
  const { data: session, error: sessionError } = await supabase
    .from("dashboard_sessions")
    .insert({
      token_hash: sessionHash,
      actor: "mobile-review-dashboard-v3",
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      last_used_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (sessionError) throw sessionError;
  sessionId = session.id;

  const driveUrl = `https://drive.google.com/drive/folders/field-report-test-${crypto.randomUUID()}`;

  const created = await call("field-report", "POST", {
    report_date: new Date().toISOString().slice(0, 10),
    activity_type: "Site visit",
    activity_title: "FIELD REPORT PIPELINE TEST",
    location_name: "Neutral system test location",
    ward: "Test Ward",
    constituency: "Test Constituency",
    participants: ["System test participant"],
    purpose: "Verify the field reporting workflow.",
    photographer_name: "System Photographer",
    photographer_drive_url: driveUrl,
    entries: [
      {
        entry_type: "observed",
        statement: "A neutral test condition was recorded.",
        attribution: null,
        verification_status: "verified",
      },
      {
        entry_type: "reported",
        statement: "A neutral test concern was reported.",
        attribution: "System test participant",
        verification_status: "unverified",
      },
      {
        entry_type: "completed",
        statement: "The field report was recorded.",
        attribution: null,
        verification_status: "verified",
      },
      {
        entry_type: "committed",
        statement: "A follow-up check will be completed.",
        attribution: null,
        verification_status: "unverified",
      },
    ],
    issues: [
      {
        title: "Neutral test issue",
        description: "Used only to verify status tracking.",
        status: "reported",
        owner: "System test",
        due_date: null,
      },
    ],
    evidence: [
      {
        evidence_type: "meeting_note",
        title: "Neutral integration fixture",
        source_url: null,
        source_reference: `field-report-ci-${crypto.randomUUID()}`,
        notes: "Automated system test only.",
        verification_status: "verified",
      },
    ],
  });

  reportId = created.field_report_id;
  assert(created.status === "saved", "Field report did not land in saved state.");

  const upload = await uploadFixturePhoto(reportId);
  uploadedAssetId = upload.evidence?.asset_id;
  assert(uploadedAssetId, "Uploaded photo returned no asset id.");

  const { data: uploadedAsset, error: uploadedAssetError } = await supabase
    .from("assets")
    .select("storage_bucket,storage_path,mime_type")
    .eq("id", uploadedAssetId)
    .single();

  if (uploadedAssetError) throw uploadedAssetError;
  uploadedStoragePath = uploadedAsset.storage_path;

  assert(
    uploadedAsset.storage_bucket === "source-media",
    "Uploaded photo used the wrong storage bucket."
  );
  assert(
    uploadedAsset.mime_type === "image/png",
    "Uploaded photo MIME type was not preserved."
  );

  const reports = await call("field-reports");
  const report = reports.items.find((item) => item.id === reportId);
  assert(report, "Created field report was not returned by dashboard API.");
  assert(report.entries.length === 4, "Field report entries were not preserved.");
  assert(report.issues.length === 1, "Field report issue was not preserved.");
  assert(
    report.photographer_name === "System Photographer",
    "Photographer attribution was not preserved."
  );
  assert(
    report.photographer_drive_url === driveUrl,
    "Photographer Google Drive URL was not preserved."
  );

  const driveEvidence = report.evidence.find((item) => item.source_url === driveUrl);
  assert(driveEvidence, "Google Drive folder was not attached as report evidence.");

  const uploadedEvidence = report.evidence.find(
    (item) => item.asset_id === uploadedAssetId
  );
  assert(uploadedEvidence, "Uploaded photo was not attached as evidence.");
  assert(
    uploadedEvidence.asset?.signed_url,
    "Uploaded photo did not receive a private signed preview URL."
  );

  const issueId = report.issues[0].id;
  const issueUpdate = await call("field-report-issue-status", "POST", {
    issue_id: issueId,
    status: "verified",
  });
  assert(issueUpdate.issue.status === "verified", "Issue status update failed.");

  const prepared = await call("field-report-package", "POST", {
    field_report_id: reportId,
  });
  packageId = prepared.content_package_id;
  assert(prepared.status === "review", "Prepared package did not enter review.");

  const { data: pkg, error: pkgError } = await supabase
    .from("content_packages")
    .select("status,headline,caption,intake_metadata")
    .eq("id", packageId)
    .single();

  if (pkgError) throw pkgError;
  assert(pkg.status === "review", "Package bypassed human review.");
  assert(pkg.headline === "FIELD REPORT PIPELINE TEST", "Headline changed unexpectedly.");
  assert(
    String(pkg.caption).includes("Observed") &&
    String(pkg.caption).includes("Reported by participants/stakeholders") &&
    String(pkg.caption).includes("Completed") &&
    String(pkg.caption).includes("Committed"),
    "Reporting distinctions were not preserved in the neutral package."
  );
  assert(
    pkg.intake_metadata?.field_report_id === reportId,
    "Field report provenance was not attached."
  );

  const { data: packageSources, error: sourceError } = await supabase
    .from("content_package_sources")
    .select("source_url,source_reference")
    .eq("content_package_id", packageId);

  if (sourceError) throw sourceError;
  assert(
    packageSources.some((source) => source.source_url === driveUrl),
    "Photographer Drive folder did not flow into the review package sources."
  );

  const { data: jobs, error: jobsError } = await supabase
    .from("render_jobs")
    .select("id")
    .eq("content_package_id", packageId);

  if (jobsError) throw jobsError;
  assert(jobs.length === 0, "A render job existed before human approval.");

  console.log("Field reporting integration test passed.");
  console.log(
    "Drive handoff, direct photo upload, private preview, issue tracking, packaging and approval gate verified."
  );
} finally {
  if (reportId) {
    await supabase.from("field_reports").delete().eq("id", reportId);
  }
  if (packageId) {
    await supabase.from("content_packages").delete().eq("id", packageId);
  }
  if (uploadedStoragePath) {
    await supabase.storage.from("source-media").remove([uploadedStoragePath]);
  }
  if (uploadedAssetId) {
    await supabase.from("assets").delete().eq("id", uploadedAssetId);
  }
  if (sessionId) {
    await supabase.from("dashboard_sessions").delete().eq("id", sessionId);
  }
}
