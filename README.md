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

The app should continue to use human approval before publishing content.
