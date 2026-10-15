-- Chai O'Clock v1: controlled Messaging Bank registry.

create table if not exists public.message_pillars (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.message_pillars(slug,name,description,sort_order)
values
  ('education','Education','Education access, school conditions and learning support.',10),
  ('water-sanitation','Water & Sanitation','Water access, sanitation and related public services.',20),
  ('infrastructure','Roads & Infrastructure','Roads, transport links and public infrastructure.',30),
  ('youth-livelihoods','Youth & Livelihoods','Youth opportunity, skills, enterprise and livelihoods.',40),
  ('public-accountability','Public Accountability','Service delivery, transparency and public accountability.',50)
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description,
    sort_order = excluded.sort_order,
    updated_at = now();

create table if not exists public.message_bank_items (
  id uuid primary key default gen_random_uuid(),
  internal_label text not null,
  category text not null default 'other',
  pillar_id uuid references public.message_pillars(id) on delete set null,
  exact_text text not null,
  caption_exact text,
  attribution text,
  claim_type text not null default 'opinion',
  verification_status text not null default 'not_required',
  source_url text,
  source_reference text,
  source_notes text,
  template_key text,
  image_guidance text,
  status text not null default 'draft',
  wording_locked boolean not null default false,
  created_by text,
  reviewed_by text,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_bank_category_check
    check (category = any(array[
      'manifesto_commitment','factual_statement','attributed_quote',
      'values_statement','issue_position','public_information','other'
    ]::text[])),
  constraint message_bank_claim_type_check
    check (claim_type = any(array[
      'factual_claim','commitment','opinion','aspiration','quotation','public_information'
    ]::text[])),
  constraint message_bank_verification_check
    check (verification_status = any(array[
      'not_required','unverified','corroborated','verified','disputed'
    ]::text[])),
  constraint message_bank_status_check
    check (status = any(array[
      'draft','review','approved','paused','retired'
    ]::text[])),
  constraint message_bank_source_url_check
    check (
      source_url is null
      or source_url ~* '^https?://'
    )
);

create index if not exists message_bank_status_idx
  on public.message_bank_items(status, updated_at desc);
create index if not exists message_bank_pillar_idx
  on public.message_bank_items(pillar_id, status, updated_at desc);

create table if not exists public.message_bank_events (
  id uuid primary key default gen_random_uuid(),
  message_bank_item_id uuid not null
    references public.message_bank_items(id) on delete cascade,
  event_type text not null,
  actor text,
  note text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint message_bank_event_type_check
    check (event_type = any(array[
      'created','edited','submitted_for_review','approved',
      'paused','retired','returned_to_draft'
    ]::text[]))
);

alter table public.message_pillars enable row level security;
alter table public.message_bank_items enable row level security;
alter table public.message_bank_events enable row level security;

revoke all on table public.message_pillars from public, anon, authenticated;
revoke all on table public.message_bank_items from public, anon, authenticated;
revoke all on table public.message_bank_events from public, anon, authenticated;

create or replace function public.create_message_bank_item(
  p_internal_label text,
  p_category text,
  p_pillar_id uuid,
  p_exact_text text,
  p_caption_exact text,
  p_attribution text,
  p_claim_type text,
  p_verification_status text,
  p_source_url text,
  p_source_reference text,
  p_source_notes text,
  p_template_key text,
  p_image_guidance text,
  p_notes text,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if nullif(trim(coalesce(p_internal_label,'')), '') is null then
    raise exception 'internal_label is required';
  end if;

  if nullif(trim(coalesce(p_exact_text,'')), '') is null then
    raise exception 'exact_text is required';
  end if;

  if p_claim_type in ('factual_claim','quotation')
     and nullif(trim(coalesce(p_source_url,'')), '') is null
     and nullif(trim(coalesce(p_source_reference,'')), '') is null then
    raise exception 'factual claims and quotations require a source URL or source reference';
  end if;

  insert into public.message_bank_items(
    internal_label,
    category,
    pillar_id,
    exact_text,
    caption_exact,
    attribution,
    claim_type,
    verification_status,
    source_url,
    source_reference,
    source_notes,
    template_key,
    image_guidance,
    notes,
    created_by,
    status,
    wording_locked
  )
  values(
    trim(p_internal_label),
    p_category,
    p_pillar_id,
    trim(p_exact_text),
    nullif(trim(coalesce(p_caption_exact,'')), ''),
    nullif(trim(coalesce(p_attribution,'')), ''),
    p_claim_type,
    p_verification_status,
    nullif(trim(coalesce(p_source_url,'')), ''),
    nullif(trim(coalesce(p_source_reference,'')), ''),
    nullif(trim(coalesce(p_source_notes,'')), ''),
    nullif(trim(coalesce(p_template_key,'')), ''),
    nullif(trim(coalesce(p_image_guidance,'')), ''),
    nullif(trim(coalesce(p_notes,'')), ''),
    nullif(trim(coalesce(p_actor,'')), ''),
    'draft',
    false
  )
  returning id into v_id;

  insert into public.message_bank_events(
    message_bank_item_id,event_type,actor,snapshot
  )
  select
    id,
    'created',
    p_actor,
    to_jsonb(mbi)
  from public.message_bank_items mbi
  where id = v_id;

  return v_id;
end;
$$;

create or replace function public.update_message_bank_item(
  p_item_id uuid,
  p_internal_label text,
  p_category text,
  p_pillar_id uuid,
  p_exact_text text,
  p_caption_exact text,
  p_attribution text,
  p_claim_type text,
  p_verification_status text,
  p_source_url text,
  p_source_reference text,
  p_source_notes text,
  p_template_key text,
  p_image_guidance text,
  p_notes text,
  p_actor text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.message_bank_items%rowtype;
  v_changed boolean;
begin
  select *
  into v_old
  from public.message_bank_items
  where id = p_item_id
  for update;

  if not found then
    raise exception 'message bank item not found';
  end if;

  if nullif(trim(coalesce(p_internal_label,'')), '') is null
     or nullif(trim(coalesce(p_exact_text,'')), '') is null then
    raise exception 'internal_label and exact_text are required';
  end if;

  if p_claim_type in ('factual_claim','quotation')
     and nullif(trim(coalesce(p_source_url,'')), '') is null
     and nullif(trim(coalesce(p_source_reference,'')), '') is null then
    raise exception 'factual claims and quotations require a source URL or source reference';
  end if;

  v_changed :=
    v_old.internal_label is distinct from trim(p_internal_label)
    or v_old.category is distinct from p_category
    or v_old.pillar_id is distinct from p_pillar_id
    or v_old.exact_text is distinct from trim(p_exact_text)
    or v_old.caption_exact is distinct from nullif(trim(coalesce(p_caption_exact,'')), '')
    or v_old.attribution is distinct from nullif(trim(coalesce(p_attribution,'')), '')
    or v_old.claim_type is distinct from p_claim_type
    or v_old.verification_status is distinct from p_verification_status
    or v_old.source_url is distinct from nullif(trim(coalesce(p_source_url,'')), '')
    or v_old.source_reference is distinct from nullif(trim(coalesce(p_source_reference,'')), '')
    or v_old.source_notes is distinct from nullif(trim(coalesce(p_source_notes,'')), '')
    or v_old.template_key is distinct from nullif(trim(coalesce(p_template_key,'')), '')
    or v_old.image_guidance is distinct from nullif(trim(coalesce(p_image_guidance,'')), '')
    or v_old.notes is distinct from nullif(trim(coalesce(p_notes,'')), '');

  update public.message_bank_items
  set internal_label = trim(p_internal_label),
      category = p_category,
      pillar_id = p_pillar_id,
      exact_text = trim(p_exact_text),
      caption_exact = nullif(trim(coalesce(p_caption_exact,'')), ''),
      attribution = nullif(trim(coalesce(p_attribution,'')), ''),
      claim_type = p_claim_type,
      verification_status = p_verification_status,
      source_url = nullif(trim(coalesce(p_source_url,'')), ''),
      source_reference = nullif(trim(coalesce(p_source_reference,'')), ''),
      source_notes = nullif(trim(coalesce(p_source_notes,'')), ''),
      template_key = nullif(trim(coalesce(p_template_key,'')), ''),
      image_guidance = nullif(trim(coalesce(p_image_guidance,'')), ''),
      notes = nullif(trim(coalesce(p_notes,'')), ''),
      status = case
        when v_changed and v_old.status = 'approved' then 'draft'
        else v_old.status
      end,
      wording_locked = case
        when v_changed and v_old.status = 'approved' then false
        else v_old.wording_locked
      end,
      reviewed_by = case
        when v_changed and v_old.status = 'approved' then null
        else v_old.reviewed_by
      end,
      reviewed_at = case
        when v_changed and v_old.status = 'approved' then null
        else v_old.reviewed_at
      end,
      updated_at = now()
  where id = p_item_id;

  if v_changed then
    insert into public.message_bank_events(
      message_bank_item_id,event_type,actor,note,snapshot
    )
    select
      id,
      case
        when v_old.status = 'approved' then 'returned_to_draft'
        else 'edited'
      end,
      p_actor,
      case
        when v_old.status = 'approved'
          then 'Approved wording changed; item automatically returned to draft.'
        else null
      end,
      to_jsonb(mbi)
    from public.message_bank_items mbi
    where id = p_item_id;
  end if;

  return true;
end;
$$;

create or replace function public.set_message_bank_status(
  p_item_id uuid,
  p_status text,
  p_note text,
  p_actor text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.message_bank_items%rowtype;
  v_event text;
begin
  if p_status not in ('draft','review','approved','paused','retired') then
    raise exception 'invalid status';
  end if;

  select *
  into v_item
  from public.message_bank_items
  where id = p_item_id
  for update;

  if not found then
    raise exception 'message bank item not found';
  end if;

  if p_status = 'approved' then
    if v_item.claim_type = 'factual_claim'
       and v_item.verification_status not in ('corroborated','verified') then
      raise exception 'factual claim must be corroborated or verified before approval';
    end if;

    if v_item.claim_type = 'quotation'
       and v_item.verification_status <> 'verified' then
      raise exception 'quotation must be verified before approval';
    end if;
  end if;

  v_event := case p_status
    when 'draft' then 'returned_to_draft'
    when 'review' then 'submitted_for_review'
    when 'approved' then 'approved'
    when 'paused' then 'paused'
    when 'retired' then 'retired'
  end;

  update public.message_bank_items
  set status = p_status,
      wording_locked = (p_status = 'approved'),
      reviewed_by = case
        when p_status = 'approved' then p_actor
        else reviewed_by
      end,
      reviewed_at = case
        when p_status = 'approved' then now()
        else reviewed_at
      end,
      updated_at = now()
  where id = p_item_id;

  insert into public.message_bank_events(
    message_bank_item_id,event_type,actor,note,snapshot
  )
  select id,v_event,p_actor,p_note,to_jsonb(mbi)
  from public.message_bank_items mbi
  where id = p_item_id;

  return true;
end;
$$;

revoke all on function public.create_message_bank_item(
  text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;
revoke all on function public.update_message_bank_item(
  uuid,text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;
revoke all on function public.set_message_bank_status(uuid,text,text,text)
  from public, anon, authenticated;

grant execute on function public.create_message_bank_item(
  text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) to service_role;
grant execute on function public.update_message_bank_item(
  uuid,text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text
) to service_role;
grant execute on function public.set_message_bank_status(uuid,text,text,text)
  to service_role;
