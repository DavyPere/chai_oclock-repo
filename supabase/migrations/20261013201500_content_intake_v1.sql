-- Chai O'Clock v1: sourced content intake.

alter table public.content_packages
  add column if not exists submitted_by text,
  add column if not exists intake_metadata jsonb not null default '{}'::jsonb;

create table if not exists public.content_package_sources (
  id uuid primary key default gen_random_uuid(),
  content_package_id uuid not null
    references public.content_packages(id) on delete cascade,
  source_type text not null default 'web',
  source_title text,
  source_url text,
  source_reference text,
  published_at timestamptz,
  verification_status text not null default 'unverified',
  verification_notes text,
  created_at timestamptz not null default now(),
  constraint content_package_sources_locator_check
    check (
      nullif(trim(coalesce(source_url, '')), '') is not null
      or nullif(trim(coalesce(source_reference, '')), '') is not null
    ),
  constraint content_package_sources_type_check
    check (
      source_type = any(array[
        'web','youtube','government','first_party',
        'document','social','system','other'
      ]::text[])
    ),
  constraint content_package_sources_verification_check
    check (
      verification_status = any(array[
        'unverified','corroborated','verified','disputed'
      ]::text[])
    )
);

create index if not exists content_package_sources_package_idx
  on public.content_package_sources(content_package_id, created_at);

alter table public.content_package_sources enable row level security;

revoke all on table public.content_package_sources
  from public, anon, authenticated;

create or replace function public.submit_content_package(
  p_edition text,
  p_content_type text,
  p_headline text,
  p_poster_text text,
  p_caption text,
  p_template_id text,
  p_render_payload jsonb,
  p_sources jsonb,
  p_submitted_by text,
  p_intake_metadata jsonb default '{}'::jsonb,
  p_source_image_asset_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package_id uuid;
  v_schema jsonb;
  v_key text;
  v_spec jsonb;
  v_source jsonb;
  v_source_url text;
  v_source_reference text;
begin
  if p_edition not in ('morning','evening') then
    raise exception 'invalid edition';
  end if;

  if nullif(trim(coalesce(p_content_type,'')), '') is null then
    raise exception 'content_type is required';
  end if;

  if nullif(trim(coalesce(p_headline,'')), '') is null then
    raise exception 'headline is required';
  end if;

  if nullif(trim(coalesce(p_caption,'')), '') is null then
    raise exception 'caption is required';
  end if;

  if nullif(trim(coalesce(p_template_id,'')), '') is null then
    raise exception 'template_id is required';
  end if;

  if nullif(trim(coalesce(p_submitted_by,'')), '') is null then
    raise exception 'submitted_by is required';
  end if;

  if coalesce(jsonb_typeof(p_render_payload), '') <> 'object' then
    raise exception 'render_payload must be an object';
  end if;

  if coalesce(jsonb_typeof(p_intake_metadata), '') <> 'object' then
    raise exception 'intake_metadata must be an object';
  end if;

  if coalesce(jsonb_typeof(p_sources), '') <> 'array'
     or jsonb_array_length(p_sources) < 1 then
    raise exception 'at least one source is required';
  end if;

  select autofill_schema
  into v_schema
  from public.poster_templates
  where template_key = p_template_id
    and active = true;

  if v_schema is null then
    raise exception 'active template not found';
  end if;

  for v_key, v_spec in
    select key, value from jsonb_each(v_schema)
  loop
    if v_spec->>'type' = 'text' then
      if v_key = 'HEADLINE' then
        if nullif(trim(coalesce(p_render_payload->>v_key, p_headline, '')), '') is null then
          raise exception 'missing render field %', v_key;
        end if;
      elsif v_key = 'SUBHEADLINE' then
        if nullif(trim(coalesce(p_render_payload->>v_key, p_poster_text, '')), '') is null then
          raise exception 'missing render field %', v_key;
        end if;
      elsif nullif(trim(coalesce(p_render_payload->>v_key, '')), '') is null then
        raise exception 'missing render field %', v_key;
      end if;
    end if;
  end loop;

  for v_source in
    select value from jsonb_array_elements(p_sources)
  loop
    if jsonb_typeof(v_source) <> 'object' then
      raise exception 'each source must be an object';
    end if;

    v_source_url := nullif(trim(coalesce(v_source->>'source_url','')), '');
    v_source_reference := nullif(trim(coalesce(v_source->>'source_reference','')), '');

    if v_source_url is null and v_source_reference is null then
      raise exception 'each source requires source_url or source_reference';
    end if;

    if v_source_url is not null
       and v_source_url !~* '^https?://' then
      raise exception 'source_url must begin with http:// or https://';
    end if;
  end loop;

  insert into public.content_packages(
    edition,
    content_type,
    headline,
    poster_text,
    caption,
    template_id,
    render_payload,
    source_image_asset_id,
    submitted_by,
    intake_metadata,
    status
  )
  values(
    p_edition,
    p_content_type,
    trim(p_headline),
    nullif(trim(coalesce(p_poster_text,'')), ''),
    p_caption,
    p_template_id,
    p_render_payload,
    p_source_image_asset_id,
    trim(p_submitted_by),
    p_intake_metadata,
    'review'
  )
  returning id into v_package_id;

  for v_source in
    select value from jsonb_array_elements(p_sources)
  loop
    insert into public.content_package_sources(
      content_package_id,
      source_type,
      source_title,
      source_url,
      source_reference,
      published_at,
      verification_status,
      verification_notes
    )
    values(
      v_package_id,
      coalesce(nullif(trim(v_source->>'source_type'), ''), 'web'),
      nullif(trim(v_source->>'source_title'), ''),
      nullif(trim(v_source->>'source_url'), ''),
      nullif(trim(v_source->>'source_reference'), ''),
      case
        when nullif(trim(v_source->>'published_at'), '') is null then null
        else (v_source->>'published_at')::timestamptz
      end,
      coalesce(nullif(trim(v_source->>'verification_status'), ''), 'unverified'),
      nullif(trim(v_source->>'verification_notes'), '')
    );
  end loop;

  return v_package_id;
end;
$$;

revoke all on function public.submit_content_package(
  text,text,text,text,text,text,jsonb,jsonb,text,jsonb,uuid
) from public, anon, authenticated;

grant execute on function public.submit_content_package(
  text,text,text,text,text,text,jsonb,jsonb,text,jsonb,uuid
) to service_role;
