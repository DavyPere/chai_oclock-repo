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
let itemId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(action, method = "GET", body = null) {
  const res = await fetch(
    `${url}/functions/v1/review-dashboard-api?action=${encodeURIComponent(action)}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        "x-chai-dashboard-session": rawSession,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${action} failed: ${res.status} ${JSON.stringify(json)}`
    );
  }
  return json;
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

  const bank = await call("messaging-bank");
  assert(Array.isArray(bank.pillars), "Messaging Bank returned no pillars.");

  const created = await call("message-bank-item", "POST", {
    internal_label: "SYSTEM MESSAGE BANK TEST",
    category: "other",
    pillar_id: null,
    exact_text: "Neutral system wording registry test.",
    caption_exact: null,
    attribution: null,
    claim_type: "opinion",
    verification_status: "not_required",
    source_url: null,
    source_reference: "messaging-bank-integration-test",
    source_notes: "Neutral automated test only.",
    template_key: null,
    image_guidance: null,
    notes: "Temporary CI fixture.",
  });

  itemId = created.message_bank_item_id;
  assert(created.status === "draft", "New wording did not enter Draft.");

  await call("message-bank-status", "POST", {
    id: itemId,
    status: "review",
    note: "Neutral CI fixture submitted for review.",
  });

  await call("message-bank-status", "POST", {
    id: itemId,
    status: "approved",
    note: "Neutral CI fixture approved.",
  });

  let { data: approved, error: approvedError } = await supabase
    .from("message_bank_items")
    .select("status,wording_locked,exact_text")
    .eq("id", itemId)
    .single();

  if (approvedError) throw approvedError;
  assert(approved.status === "approved", "Approved status was not stored.");
  assert(approved.wording_locked === true, "Approved wording was not locked.");

  await call("message-bank-item-update", "POST", {
    id: itemId,
    internal_label: "SYSTEM MESSAGE BANK TEST",
    category: "other",
    pillar_id: null,
    exact_text: "Neutral system wording registry test — edited.",
    caption_exact: null,
    attribution: null,
    claim_type: "opinion",
    verification_status: "not_required",
    source_url: null,
    source_reference: "messaging-bank-integration-test",
    source_notes: "Neutral automated test only.",
    template_key: null,
    image_guidance: null,
    notes: "Temporary CI fixture.",
  });

  const { data: edited, error: editedError } = await supabase
    .from("message_bank_items")
    .select("status,wording_locked,reviewed_by,reviewed_at")
    .eq("id", itemId)
    .single();

  if (editedError) throw editedError;
  assert(
    edited.status === "draft",
    "Editing approved wording did not return the item to Draft."
  );
  assert(
    edited.wording_locked === false,
    "Editing approved wording did not clear the wording lock."
  );
  assert(
    edited.reviewed_by === null && edited.reviewed_at === null,
    "Editing approved wording did not clear approval metadata."
  );

  const { data: events, error: eventsError } = await supabase
    .from("message_bank_events")
    .select("event_type")
    .eq("message_bank_item_id", itemId)
    .order("created_at", { ascending: true });

  if (eventsError) throw eventsError;

  const eventTypes = events.map((event) => event.event_type);
  for (const expected of [
    "created",
    "submitted_for_review",
    "approved",
    "returned_to_draft",
  ]) {
    assert(
      eventTypes.includes(expected),
      `Missing Messaging Bank audit event: ${expected}`
    );
  }

  console.log("Messaging Bank integration test passed.");
  console.log(
    "Create, review, approval lock, edit reset, and audit history verified."
  );
} finally {
  if (itemId) {
    await supabase.from("message_bank_items").delete().eq("id", itemId);
  }
  if (sessionId) {
    await supabase.from("dashboard_sessions").delete().eq("id", sessionId);
  }
}
