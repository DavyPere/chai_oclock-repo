# Chai O'Clock

Chai O'Clock is wired to the existing Supabase backend:

- Project ref: `jrdtelveihwusdtpgnks`
- Project URL: `https://jrdtelveihwusdtpgnks.supabase.co`

## Local setup

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Add the Supabase public key as `SUPABASE_PUBLISHABLE_KEY`.
4. Run `npm run check:supabase`.

Never commit server-side secrets. Local environment files are ignored by Git.

## Approval pipeline

Content remains human-gated before rendering or publishing.

The backend includes:

- `approval_events` for the approval/rejection audit trail.
- `render_jobs` with `queued`, `rendering`, `rendered`, `failed`, and `cancelled` states.
- `content_packages.render_payload` for structured Canva fields.
- `content_packages.source_image_asset_id` for the source portrait.
- `review-content` for authenticated approve/reject actions.

Approval queues one active render job. Rejection cancels a queued job. Approval does not publish content.

The GitHub workflow `Review Content HTTP Integration` creates a temporary neutral package and temporary sync client, calls the deployed Edge Function over HTTPS, verifies queue/audit behavior, then deletes all test records.

## Canva render worker

The canonical Update Brand Template is `EAHWrOFefQg`.

That Brand Template does not expose an autofill dataset directly. The worker therefore renders from the approved autofill source design `DAHXQtM9oxY`, which exposes:

- `HEADLINE`
- `SUBHEADLINE`
- `ITEM_1`
- `ITEM_2`
- `ITEM_3`
- `PRIMARY_IMAGE`

The canonical Brand Template ID remains stored with the template record for identity and provenance.

Worker flow:

`approved content_package -> queued render_job -> claim job -> optional background removal -> Canva autofill -> PNG export -> rendered-posters bucket -> assets row -> content_package.image_asset_id`

The content package remains `approved` after rendering so the existing `latest-content` endpoint can deliver the finished poster to the iPhone staging shortcut.

### Canva OAuth

For unattended rendering, create a Canva developer integration and grant the worker the scopes needed for:

- design content read
- design content write
- asset read
- asset write

Store these GitHub repository secrets:

- `CANVA_CLIENT_ID`
- `CANVA_CLIENT_SECRET`

Obtain one Canva refresh token through the OAuth authorization flow and temporarily store it as:

- `CANVA_REFRESH_TOKEN_BOOTSTRAP`

Then manually run the GitHub workflow **Bootstrap Canva OAuth Token** once. It stores the refresh token encrypted in Supabase Vault. After that workflow succeeds, delete `CANVA_REFRESH_TOKEN_BOOTSTRAP` from GitHub.

The worker refreshes Canva access automatically and writes each newly rotated refresh token back into Supabase Vault.

For short-lived testing only, `CANVA_ACCESS_TOKEN` can be supplied instead of the refresh-token flow.

## Worker schedule

`Chai OClock Render Worker` runs every 10 minutes and can also be started manually. It processes one queued job per run. If Canva OAuth has not been configured yet, the scheduled job exits cleanly without touching the render queue.

## Supabase CLI

The repository includes `supabase/config.toml`.

`supabase link --project-ref jrdtelveihwusdtpgnks`


## One-click Canva OAuth connection

The preferred production setup uses Canva's Authorization Code flow with PKCE.

In Canva Developer Portal, create an integration and configure the redirect URL exactly as:

`https://jrdtelveihwusdtpgnks.supabase.co/functions/v1/canva-oauth-callback`

Enable these scopes:

- `design:content:read`
- `design:content:write`
- `asset:read`
- `asset:write`

Add the Canva integration credentials to GitHub repository secrets:

- `CANVA_CLIENT_ID`
- `CANVA_CLIENT_SECRET`

The **Canva OAuth Setup** workflow then:

1. stores the client credentials in Supabase Vault,
2. creates a 15-minute PKCE session,
3. prints a one-time Canva authorization URL.

Open that URL and approve Canva access. Canva redirects to the deployed `canva-oauth-callback` Edge Function, which exchanges the authorization code and stores the rotating refresh token in Supabase Vault automatically.

After OAuth succeeds, the render worker can use the Vault-backed credentials without requiring a permanent Canva access token.


## Mobile review dashboard

The private mobile review page is deployed at:

`https://jrdtelveihwusdtpgnks.supabase.co/functions/v1/review-dashboard`

A browser is authorized through a one-time setup link. The setup token is stored only as a SHA-256 hash, expires automatically, and can be used once. A successful setup creates a 30-day HttpOnly, Secure, SameSite=Strict browser session.

The dashboard shows packages in `review` or `approved` state, including:

- headline and poster copy,
- structured render fields,
- caption,
- current Canva render status,
- the finished poster preview when available.

Approve and reject actions call the same audited `review_content_package` database function used by the API. The dashboard cannot publish content.


## Sourced content intake

Prepared content enters Chai O'Clock through the `submit-content` Edge Function.

The endpoint accepts an authenticated `POST` using an enabled `sync_clients` key in the `x-chai-key` header. It always creates the package with `status = review`. It cannot approve, render, stage, or publish content.

Required fields:

- `edition`: `morning` or `evening`
- `content_type`
- `headline`
- `caption`
- `template_id`
- `render_payload`
- `sources`: at least one source

Each source must include either `source_url` or `source_reference`. Supported source types include web, YouTube, government, first-party, document, social, system, and other.

The intake transaction:

1. validates the active poster template,
2. checks all required Canva text fields,
3. records the submitting client,
4. stores package-level intake metadata,
5. attaches the source trail,
6. inserts the package into `review`,
7. creates no render job.

Only a later human approval through the review dashboard can create the Canva render job.


## Researcher + Editor engine

The scheduled Researcher + Editor workflow is deliberately source-first and human-gated.

The Researcher uses the OpenAI Responses API with web search to discover up to six recent public-interest stories per run. Geographic priority is:

1. Kajiado North
2. Kajiado County
3. Kenya-wide stories only when materially important

The Researcher stores every new candidate with:

- source URLs and verification notes,
- category and location,
- freshness, locality, and importance scores,
- whether the story is sensitive or requires corroboration.

Politics, governance, elections, public safety, allegations, and other sensitive stories require at least two independent source domains before the Editor may prepare a draft.

The Editor performs a second verification pass and either holds the story or creates a neutral factual content package. Editor packages always enter `review` through the existing sourced intake RPC. The worker cannot approve, render, stage, or publish a package.

The scheduled workflow is `.github/workflows/research-editor.yml` and runs every two hours when `OPENAI_API_KEY` is configured in GitHub Actions secrets. The default model is `gpt-6-luna`; it can be changed through the workflow environment.

No political persuasion, campaign strategy, voter targeting, endorsements, opposition messaging, or automatic publishing is part of this pipeline.


## Field Reporting module

Chai O'Clock Field Reporting is the factual activity-recording layer for visits, meetings, inspections, deliveries and community engagements.

The permanent field report separates statements into five classes:

- `observed`: something the reporting team directly saw,
- `reported`: something a participant or stakeholder said,
- `completed`: an action that actually happened,
- `committed`: a promise or future action that is not yet complete,
- `next_step`: an operational follow-up.

These classes must not be collapsed. In particular, a `committed` item must never be represented as `completed` unless the underlying field report is updated with evidence of completion.

Each report can also contain:

- participants and stakeholders,
- location, ward and constituency,
- issue/follow-up records,
- owners and due dates,
- evidence links or references,
- verification status.

Issue states are:

`reported → verified → action_required → in_progress → completed`

and `follow_up_needed` is available when a completed or progressing issue requires another check.

The mobile screen is `docs/field-reports.html` and shares the same private browser session as the review dashboard.

Saving a field report does not create content. The explicit **Prepare for Approval** action deterministically creates a neutral review package from the recorded facts, labels facts by their reporting class, attaches field-report provenance, and leaves the package in `review`.

Only the existing human approval action may create a Canva render job. Field Reporting does not publish content.


### Photographer media handoff

Field reports support two complementary photo workflows:

1. **Google Drive full-shoot handoff** — the report can store the photographer's name and a `https://drive.google.com/` folder link. The folder is recorded as first-party evidence and flows into the later review package source trail.
2. **Direct selected-photo upload** — JPEG, PNG and WebP images can be uploaded from the private field-report dashboard. Direct uploads are capped at 12 MB per photo and are stored privately in the existing `source-media` bucket.

Direct photo uploads create both an `assets` record and a `field_report_evidence` record. Dashboard previews use short-lived signed URLs; the storage bucket remains private.

Full-resolution sets, large batches and videos should stay in the photographer's Google Drive folder. Selected photos needed for reporting or Canva can be uploaded directly into Chai O'Clock.

Saved field reports also include an **Add photos** control so media can be attached after the initial report is created.


## Messaging Bank

The Messaging Bank is a controlled registry for user-authored campaign wording. It stores exact text and supporting provenance; it does not generate or rewrite political persuasion.

The bank includes five editable neutral pillars:

- Education
- Water & Sanitation
- Roads & Infrastructure
- Youth & Livelihoods
- Public Accountability

Each bank item records:

- internal label,
- category,
- pillar,
- exact poster wording,
- optional exact caption,
- attribution,
- claim type,
- verification status,
- source URL/reference and source notes,
- optional template key,
- optional image guidance,
- internal notes,
- approval status and audit history.

Statuses are:

`draft → review → approved`

with `paused` and `retired` available for lifecycle control.

Important controls:

- factual claims and quotations require a source URL or reference,
- factual claims must be corroborated or verified before approval,
- quotations must be verified before approval,
- approved wording is marked `wording_locked = true`,
- editing an approved item automatically returns it to Draft and clears approval metadata,
- every create/edit/status change is written to `message_bank_events`.

The private UI is `docs/messaging-bank.html` and shares the existing dashboard browser session.

Messaging Bank v1 deliberately stops at approved registry content. It does not automatically create posters, render Canva designs, schedule posts, target audiences, or publish content. Any later design connection should copy user-approved wording exactly and retain the existing human review gate.


### Manifesto presentation structure

Approved manifesto wording can carry two neutral organization fields:

- `manifesto_pair_key`: links exact English/Swahili counterparts such as `P1.1` or `P3.5`.
- `presentation_type`: layout-fit classification only:
  - `short_commitment`
  - `standard_commitment`
  - `extended_commitment`
  - `named_initiative`
  - `slogan`

Presentation type is not a persuasion score, priority ranking, audience-targeting signal, or recommendation. It exists only so exact approved wording can be filtered and later placed into designs with enough text space without rewriting it.
