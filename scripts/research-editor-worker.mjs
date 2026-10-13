import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";
const MAX_EDITOR_SUBMISSIONS = Number(process.env.MAX_EDITOR_SUBMISSIONS || 3);

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function assertJsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  if (!parts.length) {
    throw new Error("OpenAI response contained no output text.");
  }

  return parts.join("\n").trim();
}

async function callOpenAI(payload) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `OpenAI Responses API failed: ${res.status} ${JSON.stringify(body)}`
    );
  }

  return body;
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    const removable = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];
    for (const key of removable) url.searchParams.delete(key);
    const query = url.searchParams.toString();
    return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return String(raw || "").trim();
  }
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function storyFingerprint(story) {
  const primary = canonicalUrl(story.sources?.[0]?.source_url || "");
  const basis = primary || normalizeTitle(story.title);
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function distinctDomains(sources) {
  const domains = new Set();
  for (const source of sources || []) {
    try {
      const host = new URL(source.source_url).hostname
        .toLowerCase()
        .replace(/^www\./, "");
      if (host) domains.add(host);
    } catch {
      // Invalid URLs are rejected later.
    }
  }
  return domains;
}

function isPoliticsOrGovernance(story) {
  return ["politics", "governance", "elections", "public_safety"].includes(
    String(story.category || "").toLowerCase()
  );
}

function eligibility(story) {
  const sources = Array.isArray(story.sources) ? story.sources : [];
  const domains = distinctDomains(sources);

  if (!sources.length) {
    return { eligible: false, reason: "No source URLs attached." };
  }

  for (const source of sources) {
    if (!/^https?:\/\//i.test(String(source.source_url || ""))) {
      return { eligible: false, reason: "A source URL is invalid." };
    }
  }

  const corroborationRequired =
    Boolean(story.requires_corroboration) ||
    Boolean(story.sensitive_topic) ||
    isPoliticsOrGovernance(story);

  if (corroborationRequired && domains.size < 2) {
    return {
      eligible: false,
      reason: "Sensitive/governance story requires two independent source domains.",
    };
  }

  if (
    Number(story.locality_score || 0) < 40 &&
    Number(story.importance_score || 0) < 75
  ) {
    return {
      eligible: false,
      reason: "Story is neither sufficiently local nor nationally important.",
    };
  }

  return { eligible: true, reason: null };
}

function safeSourceType(value) {
  const allowed = new Set([
    "web",
    "youtube",
    "government",
    "first_party",
    "document",
    "social",
    "other",
  ]);
  return allowed.has(value) ? value : "web";
}

function toPackageSources(story) {
  return (story.sources || []).map((source) => ({
    source_type: safeSourceType(source.source_type),
    source_title: source.source_title || null,
    source_url: canonicalUrl(source.source_url),
    published_at: source.published_at || null,
    verification_status: source.verification_status || "unverified",
    verification_notes: source.verification_notes || null,
  }));
}

const researchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stories"],
  properties: {
    stories: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "summary",
          "why_it_matters",
          "category",
          "location",
          "published_at",
          "locality_score",
          "importance_score",
          "freshness_score",
          "sensitive_topic",
          "requires_corroboration",
          "sources",
        ],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          why_it_matters: { type: "string" },
          category: {
            type: "string",
            enum: [
              "local_services",
              "education",
              "health",
              "infrastructure",
              "business",
              "environment",
              "culture",
              "governance",
              "politics",
              "elections",
              "public_safety",
              "national",
              "general",
            ],
          },
          location: { type: ["string", "null"] },
          published_at: { type: ["string", "null"] },
          locality_score: { type: "integer", minimum: 0, maximum: 100 },
          importance_score: { type: "integer", minimum: 0, maximum: 100 },
          freshness_score: { type: "integer", minimum: 0, maximum: 100 },
          sensitive_topic: { type: "boolean" },
          requires_corroboration: { type: "boolean" },
          sources: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "source_type",
                "source_title",
                "source_url",
                "published_at",
                "verification_status",
                "verification_notes",
              ],
              properties: {
                source_type: {
                  type: "string",
                  enum: [
                    "web",
                    "youtube",
                    "government",
                    "first_party",
                    "document",
                    "social",
                    "other",
                  ],
                },
                source_title: { type: "string" },
                source_url: { type: "string" },
                published_at: { type: ["string", "null"] },
                verification_status: {
                  type: "string",
                  enum: ["unverified", "corroborated", "verified"],
                },
                verification_notes: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
};

const editorSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "hold_reason",
    "headline",
    "poster_text",
    "caption",
    "item_1",
    "item_2",
    "item_3",
  ],
  properties: {
    decision: { type: "string", enum: ["submit", "hold"] },
    hold_reason: { type: ["string", "null"] },
    headline: { type: "string" },
    poster_text: { type: "string" },
    caption: { type: "string" },
    item_1: { type: "string" },
    item_2: { type: "string" },
    item_3: { type: "string" },
  },
};

async function researchStories() {
  const today = new Date().toISOString();

  const response = await callOpenAI({
    model: OPENAI_MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    instructions: [
      "You are the neutral Researcher for a Kenyan public-interest media desk.",
      "Find factual, recent stories. Kajiado County is the top geographic priority, with Kajiado North the highest local priority. Broader Kenyan stories may be included only when materially important to the local audience.",
      "Prefer developments from the last 48 hours. A continuing story may be older only if there is a genuinely new development.",
      "Use reliable news outlets, official government records/statements, and direct first-party sources. Avoid rumors and unsupported social-media claims.",
      "For politics, governance, elections, public safety, allegations, or contested claims, require corroboration from at least two independent source domains before treating the item as ready for editing.",
      "Report political actors neutrally. Do not create campaign strategy, persuasion, voter targeting, slogans, endorsements, opposition messaging, or advocacy.",
      "Do not infer motives. Attribute allegations and disputed claims. Keep private personal information out unless clearly necessary to a legitimate public-interest story.",
      "Return only the structured result requested.",
    ].join("\n"),
    input: `Current timestamp: ${today}. Research up to six strong candidate stories for the next Chai O'Clock editorial review queue.`,
    text: {
      format: {
        type: "json_schema",
        name: "chai_research_candidates",
        strict: true,
        schema: researchSchema,
      },
    },
  });

  const parsed = JSON.parse(extractOutputText(response));
  assertJsonObject(parsed, "research output");

  return {
    stories: Array.isArray(parsed.stories) ? parsed.stories : [],
    responseId: response.id || null,
  };
}

async function editStory(story) {
  const response = await callOpenAI({
    model: OPENAI_MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    instructions: [
      "You are the neutral Editor for a Kenyan public-interest media desk.",
      "Verify the supplied story against current web sources before drafting.",
      "Write in simple, clear English for a broad audience. Be factual, compact, and easy to understand.",
      "Do not sensationalize. Do not invent achievements, statistics, quotes, dates, or causation.",
      "For political or governance stories, use neutral attribution and avoid persuasion, campaign language, slogans, endorsements, opposition messaging, voter targeting, or calls to political action.",
      "If the facts cannot be verified to a reasonable editorial standard, set decision to hold.",
      "If decision is submit: headline should be factual, poster_text should summarize the development, and ITEM_1 through ITEM_3 should be short factual takeaways suitable for a visual card.",
      "The caption may explain context, but it must not make unsupported claims.",
      "Return only the structured result requested.",
    ].join("\n"),
    input: JSON.stringify({
      task: "Prepare this candidate for human editorial approval.",
      story,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "chai_editor_draft",
        strict: true,
        schema: editorSchema,
      },
    },
  });

  const parsed = JSON.parse(extractOutputText(response));
  assertJsonObject(parsed, "editor output");

  return {
    draft: parsed,
    responseId: response.id || null,
  };
}

async function insertCandidate(runId, story, researchResponseId) {
  const fingerprint = storyFingerprint(story);

  const { data, error } = await supabase
    .from("research_candidates")
    .upsert(
      {
        research_run_id: runId,
        fingerprint,
        title: story.title,
        summary: story.summary,
        why_it_matters: story.why_it_matters,
        category: story.category || "general",
        location: story.location || null,
        published_at: story.published_at || null,
        locality_score: Number(story.locality_score || 0),
        importance_score: Number(story.importance_score || 0),
        freshness_score: Number(story.freshness_score || 0),
        sensitive_topic: Boolean(story.sensitive_topic),
        requires_corroboration: Boolean(story.requires_corroboration),
        sources: story.sources,
        model_metadata: {
          research_response_id: researchResponseId,
          model: OPENAI_MODEL,
        },
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "fingerprint",
        ignoreDuplicates: true,
      }
    )
    .select(
      "id,status,fingerprint,title,summary,why_it_matters,category,location,published_at,locality_score,importance_score,freshness_score,sensitive_topic,requires_corroboration,sources,content_package_id"
    )
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function holdCandidate(candidateId, reason, editorPayload = null) {
  const { error } = await supabase
    .from("research_candidates")
    .update({
      status: "held",
      editorial_notes: reason,
      editor_payload: editorPayload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidateId);

  if (error) throw error;
}

async function submitDraft(candidate, story, edited) {
  const draft = edited.draft;

  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_research_candidate_for_editing",
    { p_candidate_id: candidate.id }
  );

  if (claimError) throw claimError;
  if (!claimed) return null;

  if (draft.decision !== "submit") {
    await holdCandidate(
      candidate.id,
      draft.hold_reason || "Editor held the story.",
      draft
    );
    return null;
  }

  const packageSources = toPackageSources(story);

  const { data: packageId, error: submitError } = await supabase.rpc(
    "submit_content_package",
    {
      p_edition:
        new Date().getUTCHours() < 13 ? "morning" : "evening",
      p_content_type: "news_update",
      p_headline: draft.headline,
      p_poster_text: draft.poster_text,
      p_caption: draft.caption,
      p_template_id: "user_update_01",
      p_render_payload: {
        HEADLINE: draft.headline,
        SUBHEADLINE: draft.poster_text,
        ITEM_1: draft.item_1,
        ITEM_2: draft.item_2,
        ITEM_3: draft.item_3,
      },
      p_sources: packageSources,
      p_submitted_by: "research-editor-worker",
      p_intake_metadata: {
        research_candidate_id: candidate.id,
        research_run_id: candidate.research_run_id,
        researcher_model: OPENAI_MODEL,
        editor_response_id: edited.responseId,
        neutral_editorial_pipeline: true,
      },
      p_source_image_asset_id: null,
    }
  );

  if (submitError) {
    await holdCandidate(
      candidate.id,
      `Package submission failed: ${submitError.message}`,
      draft
    );
    throw submitError;
  }

  const { error: updateError } = await supabase
    .from("research_candidates")
    .update({
      status: "submitted",
      editor_payload: draft,
      editorial_notes: null,
      content_package_id: packageId,
      model_metadata: {
        ...(candidate.model_metadata || {}),
        editor_response_id: edited.responseId,
        model: OPENAI_MODEL,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidate.id);

  if (updateError) throw updateError;

  return packageId;
}

async function main() {
  if (!OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY is not configured; researcher/editor run skipped.");
    return;
  }

  const triggerType = process.env.GITHUB_EVENT_NAME || "manual";

  const { data: run, error: runError } = await supabase
    .from("research_runs")
    .insert({
      trigger_type: triggerType,
      status: "running",
      model: OPENAI_MODEL,
      metadata: {
        max_editor_submissions: MAX_EDITOR_SUBMISSIONS,
        priority: "Kajiado North > Kajiado County > Kenya",
      },
    })
    .select("id")
    .single();

  if (runError) throw runError;

  let candidateCount = 0;
  let submittedCount = 0;
  let heldCount = 0;

  try {
    const research = await researchStories();

    const inserted = [];
    for (const story of research.stories) {
      const candidate = await insertCandidate(
        run.id,
        story,
        research.responseId
      );

      // Duplicate fingerprints produce no row when ignoreDuplicates is true.
      if (!candidate) continue;

      candidateCount += 1;
      inserted.push({ candidate, story });
    }

    inserted.sort((a, b) => {
      const scoreA =
        a.story.locality_score * 0.5 +
        a.story.importance_score * 0.3 +
        a.story.freshness_score * 0.2;
      const scoreB =
        b.story.locality_score * 0.5 +
        b.story.importance_score * 0.3 +
        b.story.freshness_score * 0.2;
      return scoreB - scoreA;
    });

    let editorSlots = MAX_EDITOR_SUBMISSIONS;

    for (const { candidate, story } of inserted) {
      const gate = eligibility(story);

      if (!gate.eligible) {
        await holdCandidate(candidate.id, gate.reason);
        heldCount += 1;
        continue;
      }

      if (editorSlots <= 0) {
        continue;
      }

      const edited = await editStory(story);

      if (edited.draft.decision !== "submit") {
        await holdCandidate(
          candidate.id,
          edited.draft.hold_reason || "Editor held the story.",
          edited.draft
        );
        heldCount += 1;
        continue;
      }

      const packageId = await submitDraft(candidate, story, edited);
      if (packageId) {
        submittedCount += 1;
        editorSlots -= 1;
        console.log(
          `Submitted neutral review package ${packageId} from candidate ${candidate.id}.`
        );
      }
    }

    const { error: finishError } = await supabase
      .from("research_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        candidate_count: candidateCount,
        submitted_count: submittedCount,
        held_count: heldCount,
      })
      .eq("id", run.id);

    if (finishError) throw finishError;

    console.log(
      `Research/editor run completed: ${candidateCount} new candidates, ${submittedCount} submitted for human review, ${heldCount} held.`
    );
  } catch (error) {
    await supabase
      .from("research_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        candidate_count: candidateCount,
        submitted_count: submittedCount,
        held_count: heldCount,
        error_message: String(error?.message || error).slice(0, 2000),
      })
      .eq("id", run.id);

    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
