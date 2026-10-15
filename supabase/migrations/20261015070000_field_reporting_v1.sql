-- Chai O'Clock v1: field reporting and commitment tracking.

create table if not exists public.field_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null default current_date,
  activity_type text not null,
  activity_title text not null,
  location_name text not null,
  ward text,
  constituency text,
  participants jsonb not null default '[]'::jsonb,
  purpose text not null,
  status text not null default 'saved',
  submitted_by text,
  content_package_id uuid references public.content_packages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint field_reports_status_check
    check (status = any(array['saved','packaged','archived']::text[])),
  constraint field_reports_participants_check
    check (jsonb_typeof(participants) = 'array')
);

create table if not exists public.field_report_entries (
  id uuid primary key default gen_random_uuid(),
  field_report_id uuid not null
    references public.field_reports(id) on delete cascade,
  entry_type text not null,
  statement text not null,
  attribution text,
  verification_status text not null default 'unverified',
  created_at timestamptz not null default now(),
  constraint field_report_entries_type_check
    check (entry_type = any(array[
      'observed','reported','completed','committed','next_step'
    ]::text[])),
  constraint field_report_entries_verification_check
    check (verification_status = any(array[
      'unverified','corroborated','verified','disputed'
    ]::text[]))
);

create table if not exists public.field_report_issues (
  id uuid primary key default gen_random_uuid(),
  field_report_id uuid not null
    references public.field_reports(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'reported',
  owner text,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint field_report_issues_status_check
    check (status = any(array[
      'reported','verified','action_required','in_progress',
      'completed','follow_up_needed'
    ]::text[]))
);

create table if not exists public.field_report_evidence (
  id uuid primary key default gen_random_uuid(),
  field_report_id uuid not null
    references public.field_reports(id) on delete cascade,
  evidence_type text not null default 'other',
  title text,
  source_url text,
  source_reference text,
  notes text,
  verification_status text not null default 'unverified',
  created_at timestamptz not null default now(),
  constraint field_report_evidence_locator_check
    check (
      nullif(trim(coalesce(source_url,'')), '') is not null
      or nullif(trim(coalesce(source_reference,'')), '') is not null
    ),
  constraint field_report_evidence_type_check
    check (evidence_type = any(array[
      'photo','video','document','web','letter','meeting_note','other'
    ]::text[])),
  constraint field_report_evidence_verification_check
    check (verification_status = any(array[
      'unverified','corroborated','verified','disputed'
    ]::text[]))
);

create index if not exists field_reports_date_idx
  on public.field_reports(report_date desc, created_at desc);
create index if not exists field_report_entries_report_idx
  on public.field_report_entries(field_report_id, entry_type, created_at);
create index if not exists field_report_issues_report_idx
  on public.field_report_issues(field_report_id, status, created_at);
create index if not exists field_report_evidence_report_idx
  on public.field_report_evidence(field_report_id, created_at);

alter table public.field_reports enable row level security;
alter table public.field_report_entries enable row level security;
alter table public.field_report_issues enable row level security;
alter table public.field_report_evidence enable row level security;

revoke all on table public.field_reports from public, anon, authenticated;
revoke all on table public.field_report_entries from public, anon, authenticated;
revoke all on table public.field_report_issues from public, anon, authenticated;
revoke all on table public.field_report_evidence from public, anon, authenticated;

create or replace function public.create_field_report(
  p_report_date date,
  p_activity_type text,
  p_activity_title text,
  p_location_name text,
  p_ward text,
  p_constituency text,
  p_participants jsonb,
  p_purpose text,
  p_entries jsonb,
  p_issues jsonb,
  p_evidence jsonb,
  p_submitted_by text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_item jsonb;
begin
  if p_report_date is null then
    raise exception 'report_date is required';
  end if;
  if nullif(trim(coalesce(p_activity_type,'')), '') is null then
    raise exception 'activity_type is required';
  end if;
  if nullif(trim(coalesce(p_activity_title,'')), '') is null then
    raise exception 'activity_title is required';
  end if;
  if nullif(trim(coalesce(p_location_name,'')), '') is null then
    raise exception 'location_name is required';
  end if;
  if nullif(trim(coalesce(p_purpose,'')), '') is null then
    raise exception 'purpose is required';
  end if;
  if coalesce(jsonb_typeof(p_participants),'') <> 'array'
     or coalesce(jsonb_typeof(p_entries),'') <> 'array'
     or coalesce(jsonb_typeof(p_issues),'') <> 'array'
     or coalesce(jsonb_typeof(p_evidence),'') <> 'array' then
    raise exception 'participants, entries, issues and evidence must be arrays';
  end if;
  if jsonb_array_length(p_entries) < 1 then
    raise exception 'at least one field report entry is required';
  end if;

  insert into public.field_reports(
    report_date, activity_type, activity_title, location_name,
    ward, constituency, participants, purpose, submitted_by
  )
  values(
    p_report_date,
    trim(p_activity_type),
    trim(p_activity_title),
    trim(p_location_name),
    nullif(trim(coalesce(p_ward,'')), ''),
    nullif(trim(coalesce(p_constituency,'')), ''),
    p_participants,
    trim(p_purpose),
    nullif(trim(coalesce(p_submitted_by,'')), '')
  )
  returning id into v_report_id;

  for v_item in select value from jsonb_array_elements(p_entries)
  loop
    if nullif(trim(coalesce(v_item->>'statement','')), '') is null then
      raise exception 'each entry requires a statement';
    end if;

    insert into public.field_report_entries(
      field_report_id, entry_type, statement, attribution, verification_status
    )
    values(
      v_report_id,
      coalesce(nullif(trim(v_item->>'entry_type'), ''), 'reported'),
      trim(v_item->>'statement'),
      nullif(trim(v_item->>'attribution'), ''),
      coalesce(nullif(trim(v_item->>'verification_status'), ''), 'unverified')
    );
  end loop;

  for v_item in select value from jsonb_array_elements(p_issues)
  loop
    if nullif(trim(coalesce(v_item->>'title','')), '') is null then
      continue;
    end if;

    insert into public.field_report_issues(
      field_report_id, title, description, status, owner, due_date
    )
    values(
      v_report_id,
      trim(v_item->>'title'),
      nullif(trim(v_item->>'description'), ''),
      coalesce(nullif(trim(v_item->>'status'), ''), 'reported'),
      nullif(trim(v_item->>'owner'), ''),
      case
        when nullif(trim(v_item->>'due_date'), '') is null then null
        else (v_item->>'due_date')::date
      end
    );
  end loop;

  for v_item in select value from jsonb_array_elements(p_evidence)
  loop
    if nullif(trim(coalesce(v_item->>'source_url','')), '') is null
       and nullif(trim(coalesce(v_item->>'source_reference','')), '') is null then
      continue;
    end if;

    insert into public.field_report_evidence(
      field_report_id, evidence_type, title, source_url, source_reference,
      notes, verification_status
    )
    values(
      v_report_id,
      coalesce(nullif(trim(v_item->>'evidence_type'), ''), 'other'),
      nullif(trim(v_item->>'title'), ''),
      nullif(trim(v_item->>'source_url'), ''),
      nullif(trim(v_item->>'source_reference'), ''),
      nullif(trim(v_item->>'notes'), ''),
      coalesce(nullif(trim(v_item->>'verification_status'), ''), 'unverified')
    );
  end loop;

  return v_report_id;
end;
$$;

create or replace function public.prepare_field_report_package(
  p_field_report_id uuid,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.field_reports%rowtype;
  v_observed text;
  v_reported text;
  v_completed text;
  v_committed text;
  v_next text;
  v_caption text;
  v_item1 text;
  v_item2 text;
  v_item3 text;
  v_sources jsonb;
  v_package_id uuid;
begin
  select *
  into v_report
  from public.field_reports
  where id = p_field_report_id
  for update;

  if not found then
    raise exception 'field report not found';
  end if;

  if v_report.content_package_id is not null then
    return v_report.content_package_id;
  end if;

  select string_agg('• ' || statement ||
           case when attribution is null then '' else ' — ' || attribution end, E'\n'
           order by created_at)
  into v_observed
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'observed';

  select string_agg('• ' || statement ||
           case when attribution is null then '' else ' — ' || attribution end, E'\n'
           order by created_at)
  into v_reported
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'reported';

  select string_agg('• ' || statement, E'\n' order by created_at)
  into v_completed
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'completed';

  select string_agg('• ' || statement, E'\n' order by created_at)
  into v_committed
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'committed';

  select string_agg('• ' || statement, E'\n' order by created_at)
  into v_next
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'next_step';

  v_caption :=
    'FIELD REPORT — ' || v_report.activity_title || E'\n' ||
    'Location: ' || v_report.location_name ||
      case when v_report.ward is null then '' else ', ' || v_report.ward end ||
      case when v_report.constituency is null then '' else ', ' || v_report.constituency end || E'\n' ||
    'Date: ' || to_char(v_report.report_date, 'DD Mon YYYY') || E'\n\n' ||
    'Purpose' || E'\n' || v_report.purpose ||
    case when v_observed is null then '' else E'\n\nObserved\n' || v_observed end ||
    case when v_reported is null then '' else E'\n\nReported by participants/stakeholders\n' || v_reported end ||
    case when v_completed is null then '' else E'\n\nCompleted\n' || v_completed end ||
    case when v_committed is null then '' else E'\n\nCommitted\n' || v_committed end ||
    case when v_next is null then '' else E'\n\nNext steps\n' || v_next end;

  select 'Observed: ' || statement
  into v_item1
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'observed'
  order by created_at
  limit 1;

  if v_item1 is null then
    select 'Reported: ' || statement
    into v_item1
    from public.field_report_entries
    where field_report_id = p_field_report_id
      and entry_type = 'reported'
    order by created_at
    limit 1;
  end if;

  select 'Completed: ' || statement
  into v_item2
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type = 'completed'
  order by created_at
  limit 1;

  if v_item2 is null then
    select 'Reported: ' || statement
    into v_item2
    from public.field_report_entries
    where field_report_id = p_field_report_id
      and entry_type = 'reported'
    order by created_at
    offset 1
    limit 1;
  end if;

  select 'Next: ' || statement
  into v_item3
  from public.field_report_entries
  where field_report_id = p_field_report_id
    and entry_type in ('committed','next_step')
  order by
    case entry_type when 'committed' then 0 else 1 end,
    created_at
  limit 1;

  if v_item1 is null then v_item1 := 'Purpose: ' || v_report.purpose; end if;
  if v_item2 is null then v_item2 := 'Location: ' || v_report.location_name; end if;
  if v_item3 is null then v_item3 := 'Follow-up: field report recorded for review'; end if;

  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'source_type', 'first_party',
          'source_title', coalesce(title, 'Field report evidence'),
          'source_url', source_url,
          'source_reference', source_reference,
          'verification_status', verification_status,
          'verification_notes', notes
        )
      )
      order by created_at
    ),
    '[]'::jsonb
  )
  into v_sources
  from public.field_report_evidence
  where field_report_id = p_field_report_id;

  if jsonb_array_length(v_sources) = 0 then
    v_sources := jsonb_build_array(
      jsonb_build_object(
        'source_type','first_party',
        'source_title','Chai O''Clock field report',
        'source_reference','field-report:' || p_field_report_id::text,
        'verification_status','unverified',
        'verification_notes','Internal field report record; verify supporting evidence before publication.'
      )
    );
  end if;

  select public.submit_content_package(
    case
      when extract(hour from timezone('Africa/Nairobi', now())) < 13
        then 'morning'
      else 'evening'
    end,
    'progress_update',
    v_report.activity_title,
    v_report.location_name || ' — ' || to_char(v_report.report_date, 'DD Mon YYYY'),
    v_caption,
    'user_update_01',
    jsonb_build_object(
      'HEADLINE', v_report.activity_title,
      'SUBHEADLINE', v_report.location_name || ' — ' || to_char(v_report.report_date, 'DD Mon YYYY'),
      'ITEM_1', v_item1,
      'ITEM_2', v_item2,
      'ITEM_3', v_item3
    ),
    v_sources,
    coalesce(nullif(trim(coalesce(p_actor,'')), ''), 'field-report-dashboard'),
    jsonb_build_object(
      'field_report_id', p_field_report_id,
      'reporting_framework', 'observed_reported_completed_committed_v1'
    ),
    null
  )
  into v_package_id;

  update public.field_reports
  set status = 'packaged',
      content_package_id = v_package_id,
      updated_at = now()
  where id = p_field_report_id;

  return v_package_id;
end;
$$;

revoke all on function public.create_field_report(
  date,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,text
) from public, anon, authenticated;
revoke all on function public.prepare_field_report_package(uuid,text)
  from public, anon, authenticated;

grant execute on function public.create_field_report(
  date,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,text
) to service_role;
grant execute on function public.prepare_field_report_package(uuid,text)
  to service_role;
