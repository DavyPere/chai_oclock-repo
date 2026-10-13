# Chai O'Clock

Chai O'Clock is wired to the existing Supabase backend:

- Project ref: `jrdtelveihwusdtpgnks`
- Project URL: `https://jrdtelveihwusdtpgnks.supabase.co`

## Local setup

1. Install dependencies:

   `npm install`

2. Copy the environment template:

   `cp .env.example .env`

3. In Supabase, copy the project's publishable key into:

   `SUPABASE_PUBLISHABLE_KEY`

4. Verify connectivity:

   `npm run check:supabase`

## Supabase CLI

The repository includes `supabase/config.toml` with the Chai O'Clock project ref.

After installing the Supabase CLI, link the local repo when needed:

`supabase link --project-ref jrdtelveihwusdtpgnks`

Do not commit service-role keys or other secrets. The `.gitignore` excludes local environment files.

## Current backend

The production Update Template is registered in Supabase as `user_update_01` and points to Canva Brand Template `EAHWrOFefQg`.

### Human approval and render queue

Content remains human-gated before rendering or publishing.

The backend now includes:

- `approval_events` — immutable approval/rejection audit trail.
- `render_jobs` — rendering queue with `queued`, `rendering`, `rendered`, `failed`, and `cancelled` states.
- `content_packages.render_payload` — structured Canva fields such as `HEADLINE`, `SUBHEADLINE`, `ITEM_1`, `ITEM_2`, and `ITEM_3`.
- `content_packages.source_image_asset_id` — preserves the source portrait separately from the finished poster.
- `review-content` Edge Function — authenticated approval/rejection endpoint.

Approval request:

```http
POST /functions/v1/review-content
x-chai-key: <trusted-client-key>
content-type: application/json

{
  "content_package_id": "<uuid>",
  "decision": "approve",
  "note": "optional review note"
}
```

On approval, the database selects the active template for the package content type, records the approval, and queues one active render job. On rejection, any queued render job is cancelled.

Rendering and publishing are separate stages; approval does not publish content.
