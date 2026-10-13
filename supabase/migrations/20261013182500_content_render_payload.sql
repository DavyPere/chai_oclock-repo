-- Structured Canva input for rendering.
alter table public.content_packages
  add column if not exists render_payload jsonb not null default '{}'::jsonb;

alter table public.content_packages
  add column if not exists source_image_asset_id uuid
    references public.assets(id) on delete set null;

create or replace function public.review_content_package(
  p_content_package_id uuid,
  p_decision text,
  p_note text default null,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.content_packages%rowtype;
  v_template public.poster_templates%rowtype;
  v_job public.render_jobs%rowtype;
begin
  if p_decision not in ('approve','reject') then
    raise exception 'decision must be approve or reject';
  end if;

  select *
  into v_package
  from public.content_packages
  where id = p_content_package_id
  for update;

  if not found then
    raise exception 'content package not found';
  end if;

  if p_decision = 'reject' then
    if v_package.status = 'published' then
      raise exception 'published content cannot be rejected';
    end if;

    update public.content_packages
    set status = 'rejected',
        approved_at = null,
        updated_at = now()
    where id = p_content_package_id
    returning * into v_package;

    update public.render_jobs
    set status = 'cancelled',
        completed_at = now(),
        updated_at = now()
    where content_package_id = p_content_package_id
      and status = 'queued';

    insert into public.approval_events(content_package_id, decision, note, actor)
    values (p_content_package_id, 'reject', p_note, p_actor);

    return jsonb_build_object(
      'content_package_id', v_package.id,
      'decision', 'reject',
      'status', v_package.status
    );
  end if;

  if v_package.status in ('staged','published','rejected') then
    raise exception 'content package in status % cannot be approved', v_package.status;
  end if;

  if v_package.template_id is not null then
    select *
    into v_template
    from public.poster_templates
    where active = true
      and template_key = v_package.template_id
    order by updated_at desc
    limit 1;
  else
    select *
    into v_template
    from public.poster_templates
    where active = true
      and content_type = v_package.content_type
    order by updated_at desc
    limit 1;
  end if;

  if v_template.id is null then
    raise exception 'no active poster template for content_type %', v_package.content_type;
  end if;

  update public.content_packages
  set status = 'approved',
      approved_at = coalesce(approved_at, now()),
      template_id = v_template.template_key,
      updated_at = now()
  where id = p_content_package_id
  returning * into v_package;

  insert into public.approval_events(content_package_id, decision, note, actor)
  values (p_content_package_id, 'approve', p_note, p_actor);

  select *
  into v_job
  from public.render_jobs
  where content_package_id = p_content_package_id
    and status in ('queued','rendering')
  order by created_at desc
  limit 1;

  if v_job.id is null then
    insert into public.render_jobs(
      content_package_id,
      poster_template_id,
      status,
      input_payload
    )
    values (
      p_content_package_id,
      v_template.id,
      'queued',
      jsonb_build_object(
        'headline', v_package.headline,
        'poster_text', v_package.poster_text,
        'caption', v_package.caption,
        'content_type', v_package.content_type,
        'edition', v_package.edition,
        'render_payload', v_package.render_payload,
        'source_image_asset_id', v_package.source_image_asset_id,
        'template_key', v_template.template_key,
        'canva_brand_template_id', v_template.canva_brand_template_id,
        'autofill_schema', v_template.autofill_schema
      )
    )
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'content_package_id', v_package.id,
    'decision', 'approve',
    'status', v_package.status,
    'render_job_id', v_job.id,
    'render_job_status', v_job.status,
    'template_key', v_template.template_key,
    'canva_brand_template_id', v_template.canva_brand_template_id
  );
end;
$$;

revoke all on function public.review_content_package(uuid,text,text,text) from public;
revoke all on function public.review_content_package(uuid,text,text,text) from anon;
revoke all on function public.review_content_package(uuid,text,text,text) from authenticated;
grant execute on function public.review_content_package(uuid,text,text,text) to service_role;
