-- Chai O'Clock v1: photographer Drive handoff + direct photo uploads.

alter table public.field_reports
  add column if not exists photographer_name text,
  add column if not exists photographer_drive_url text;

alter table public.field_report_evidence
  add column if not exists asset_id uuid
    references public.assets(id) on delete set null;

create index if not exists field_report_evidence_asset_idx
  on public.field_report_evidence(asset_id)
  where asset_id is not null;

alter table public.field_reports
  drop constraint if exists field_reports_photographer_drive_url_check;

alter table public.field_reports
  add constraint field_reports_photographer_drive_url_check
  check (
    photographer_drive_url is null
    or photographer_drive_url ~* '^https://drive\.google\.com/'
  );

create or replace function public.create_field_report_v2(
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
  p_submitted_by text,
  p_photographer_name text default null,
  p_photographer_drive_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_item jsonb;
  v_drive_url text;
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

  v_drive_url := nullif(trim(coalesce(p_photographer_drive_url,'')), '');
  if v_drive_url is not null
     and v_drive_url !~* '^https://drive\.google\.com/' then
    raise exception 'photographer Drive URL must use drive.google.com';
  end if;

  insert into public.field_reports(
    report_date, activity_type, activity_title, location_name,
    ward, constituency, participants, purpose, submitted_by,
    photographer_name, photographer_drive_url
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
    nullif(trim(coalesce(p_submitted_by,'')), ''),
    nullif(trim(coalesce(p_photographer_name,'')), ''),
    v_drive_url
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

  if v_drive_url is not null then
    insert into public.field_report_evidence(
      field_report_id,
      evidence_type,
      title,
      source_url,
      notes,
      verification_status
    )
    values(
      v_report_id,
      'photo',
      case
        when nullif(trim(coalesce(p_photographer_name,'')), '') is null
          then 'Photographer Google Drive folder'
        else trim(p_photographer_name) || ' — Google Drive folder'
      end,
      v_drive_url,
      'Photographer media handoff folder for this field report.',
      'unverified'
    );
  end if;

  return v_report_id;
end;
$$;

revoke all on function public.create_field_report_v2(
  date,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,text,text,text
) from public, anon, authenticated;

grant execute on function public.create_field_report_v2(
  date,text,text,text,text,text,jsonb,text,jsonb,jsonb,jsonb,text,text,text
) to service_role;
