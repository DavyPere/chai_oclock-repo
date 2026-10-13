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
