-- Chai O'Clock v1: render worker state and secure Canva token rotation.

alter table public.render_jobs
  add column if not exists canva_design_id text,
  add column if not exists canva_edit_url text,
  add column if not exists canva_view_url text;

update public.poster_templates
set canva_design_id = 'DAHXQtM9oxY',
    autofill_schema = jsonb_set(
      autofill_schema,
      '{PRIMARY_IMAGE,default_asset_id}',
      '"MAHXQ_4Bn1A"'::jsonb,
      true
    ),
    updated_at = now()
where template_key = 'user_update_01'
  and canva_brand_template_id = 'EAHWrOFefQg';

create or replace function public.claim_next_render_job()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  with next_job as (
    select rj.id
    from public.render_jobs rj
    join public.content_packages cp on cp.id = rj.content_package_id
    where rj.status = 'queued'
      and cp.status = 'approved'
    order by rj.queued_at asc
    for update of rj skip locked
    limit 1
  )
  update public.render_jobs rj
  set status = 'rendering',
      started_at = coalesce(rj.started_at, now()),
      attempt_count = rj.attempt_count + 1,
      error_message = null,
      updated_at = now()
  from next_job
  where rj.id = next_job.id
  returning rj.id into v_job_id;

  return v_job_id;
end;
$$;

create or replace function public.complete_render_job(
  p_job_id uuid,
  p_output_asset_id uuid,
  p_canva_design_id text,
  p_canva_edit_url text default null,
  p_canva_view_url text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package_id uuid;
  v_package_status text;
begin
  select content_package_id
  into v_package_id
  from public.render_jobs
  where id = p_job_id
  for update;

  if v_package_id is null then
    raise exception 'render job not found';
  end if;

  select status
  into v_package_status
  from public.content_packages
  where id = v_package_id
  for update;

  if v_package_status <> 'approved' then
    update public.render_jobs
    set status = 'cancelled',
        output_asset_id = p_output_asset_id,
        canva_design_id = p_canva_design_id,
        canva_edit_url = p_canva_edit_url,
        canva_view_url = p_canva_view_url,
        completed_at = now(),
        updated_at = now()
    where id = p_job_id;

    return false;
  end if;

  update public.render_jobs
  set status = 'rendered',
      output_asset_id = p_output_asset_id,
      canva_design_id = p_canva_design_id,
      canva_edit_url = p_canva_edit_url,
      canva_view_url = p_canva_view_url,
      completed_at = now(),
      updated_at = now()
  where id = p_job_id;

  update public.content_packages
  set image_asset_id = p_output_asset_id,
      updated_at = now()
  where id = v_package_id;

  return true;
end;
$$;

create or replace function public.fail_render_job(
  p_job_id uuid,
  p_error_message text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.render_jobs
  set status = 'failed',
      error_message = left(coalesce(p_error_message, 'unknown render failure'), 2000),
      completed_at = now(),
      updated_at = now()
  where id = p_job_id
    and status = 'rendering';
$$;

create or replace function public.get_canva_refresh_token()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'chai_oclock_canva_refresh_token'
  order by updated_at desc
  limit 1;
$$;

create or replace function public.set_canva_refresh_token(p_refresh_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if p_refresh_token is null or length(trim(p_refresh_token)) < 20 then
    raise exception 'invalid Canva refresh token';
  end if;

  select id into v_secret_id
  from vault.secrets
  where name = 'chai_oclock_canva_refresh_token'
  order by updated_at desc
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      trim(p_refresh_token),
      'chai_oclock_canva_refresh_token',
      'Rotating Canva OAuth refresh token for Chai O''Clock render worker'
    );
  else
    perform vault.update_secret(
      secret_id := v_secret_id,
      new_secret := trim(p_refresh_token)
    );
  end if;
end;
$$;

revoke all on function public.claim_next_render_job() from public, anon, authenticated;
revoke all on function public.complete_render_job(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.fail_render_job(uuid,text) from public, anon, authenticated;
revoke all on function public.get_canva_refresh_token() from public, anon, authenticated;
revoke all on function public.set_canva_refresh_token(text) from public, anon, authenticated;

grant execute on function public.claim_next_render_job() to service_role;
grant execute on function public.complete_render_job(uuid,uuid,text,text,text) to service_role;
grant execute on function public.fail_render_job(uuid,text) to service_role;
grant execute on function public.get_canva_refresh_token() to service_role;
grant execute on function public.set_canva_refresh_token(text) to service_role;
