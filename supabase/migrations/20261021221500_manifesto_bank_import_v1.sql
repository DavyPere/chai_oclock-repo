-- Chai O'Clock: language-aware Messaging Bank + official manifesto import.

alter table public.message_bank_items
  add column if not exists language_code text not null default 'en';

alter table public.message_bank_items
  drop constraint if exists message_bank_language_code_check;

alter table public.message_bank_items
  add constraint message_bank_language_code_check
  check (language_code = any(array['en','sw','mixed','other']::text[]));

-- Replace placeholder active taxonomy with the four official manifesto pillars.
update public.message_pillars
set active = false,
    updated_at = now()
where active = true;

insert into public.message_pillars(slug,name,description,sort_order,active)
values
  (
    'honest-ng-cdf-fair-access',
    'Honest NG-CDF and Fair Access',
    'Official Fresh Agenda Pillar 1 from the user-provided manifesto.',
    10,
    true
  ),
  (
    'skills-youth-opportunity',
    'Skills, Youth, and Opportunity',
    'Official Fresh Agenda Pillar 2 from the user-provided manifesto.',
    20,
    true
  ),
  (
    'infrastructure-security-livability',
    'Infrastructure, Security, and Livability',
    'Official Fresh Agenda Pillar 3 from the user-provided manifesto.',
    30,
    true
  ),
  (
    'local-economic-transformation',
    'Local Economic Transformation',
    'Official Fresh Agenda Pillar 4 from the user-provided manifesto.',
    40,
    true
  )
on conflict (slug) do update
set name = excluded.name,
    description = excluded.description,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

-- Canonical English manifesto commitments. Keep them planned; the document states agenda items, not completed work.
insert into public.manifesto_items(pillar,promise_text,area,status,source_reference,notes)
select v.pillar, v.promise_text, 'Kajiado North', 'planned',
       'DAVID PERE (5).pdf — page 3 — The Fresh Agenda',
       'Imported verbatim from the official manifesto PDF supplied by the user on 21 Oct 2026. Swahili counterpart appears on page 2.'
from (values
  ('Honest NG-CDF and Fair Access','Classrooms'),
  ('Honest NG-CDF and Fair Access','School infrastructure'),
  ('Honest NG-CDF and Fair Access','Equitable bursary distribution'),
  ('Honest NG-CDF and Fair Access','Transparent bursary allocation'),

  ('Skills, Youth, and Opportunity','TVET expansion and access'),
  ('Skills, Youth, and Opportunity','Market-linked vocational skills'),
  ('Skills, Youth, and Opportunity','Sports development'),
  ('Skills, Youth, and Opportunity','Sports scholarships'),
  ('Skills, Youth, and Opportunity','Rongai–Ngong Tech Corridor'),

  ('Infrastructure, Security, and Livability','Strategic roads'),
  ('Infrastructure, Security, and Livability','Lighting'),
  ('Infrastructure, Security, and Livability','Safer neighborhoods'),
  ('Infrastructure, Security, and Livability','Growth-supporting infrastructure'),
  ('Infrastructure, Security, and Livability','Water access partnerships'),

  ('Local Economic Transformation','SEZ readiness'),
  ('Local Economic Transformation','Developer confidence and investment readiness'),
  ('Local Economic Transformation','Support for Mama Mboga and boda ecosystem'),
  ('Local Economic Transformation','Local processing, branding, and enterprise growth')
) as v(pillar,promise_text)
where not exists (
  select 1
  from public.manifesto_items mi
  where mi.pillar = v.pillar
    and mi.promise_text = v.promise_text
    and mi.source_reference = 'DAVID PERE (5).pdf — page 3 — The Fresh Agenda'
);

-- Import exact English and Swahili manifesto wording into Messaging Bank as Draft.
do $$
declare
  rec record;
  v_pillar_id uuid;
  v_item_id uuid;
begin
  for rec in
    select *
    from (values
      ('en',1,1,'Honest NG-CDF and Fair Access','Classrooms','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 1'),
      ('en',1,2,'Honest NG-CDF and Fair Access','School infrastructure','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 1'),
      ('en',1,3,'Honest NG-CDF and Fair Access','Equitable bursary distribution','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 1'),
      ('en',1,4,'Honest NG-CDF and Fair Access','Transparent bursary allocation','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 1'),

      ('en',2,1,'Skills, Youth, and Opportunity','TVET expansion and access','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 2'),
      ('en',2,2,'Skills, Youth, and Opportunity','Market-linked vocational skills','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 2'),
      ('en',2,3,'Skills, Youth, and Opportunity','Sports development','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 2'),
      ('en',2,4,'Skills, Youth, and Opportunity','Sports scholarships','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 2'),
      ('en',2,5,'Skills, Youth, and Opportunity','Rongai–Ngong Tech Corridor','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 2'),

      ('en',3,1,'Infrastructure, Security, and Livability','Strategic roads','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 3'),
      ('en',3,2,'Infrastructure, Security, and Livability','Lighting','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 3'),
      ('en',3,3,'Infrastructure, Security, and Livability','Safer neighborhoods','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 3'),
      ('en',3,4,'Infrastructure, Security, and Livability','Growth-supporting infrastructure','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 3'),
      ('en',3,5,'Infrastructure, Security, and Livability','Water access partnerships','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 3'),

      ('en',4,1,'Local Economic Transformation','SEZ readiness','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 4'),
      ('en',4,2,'Local Economic Transformation','Developer confidence and investment readiness','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 4'),
      ('en',4,3,'Local Economic Transformation','Support for Mama Mboga and boda ecosystem','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 4'),
      ('en',4,4,'Local Economic Transformation','Local processing, branding, and enterprise growth','DAVID PERE (5).pdf — page 3 — The Fresh Agenda — Pillar 4'),

      ('sw',1,1,'Honest NG-CDF and Fair Access','Ujenzi wa vyumba vya madarasa','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 1'),
      ('sw',1,2,'Honest NG-CDF and Fair Access','Miundombinu ya shule','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 1'),
      ('sw',1,3,'Honest NG-CDF and Fair Access','Bursari zenye usawa (zinazotolewa kwa haki bila upendeleo)','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 1'),
      ('sw',1,4,'Honest NG-CDF and Fair Access','Uwazi wa kupeana bursari','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 1'),

      ('sw',2,1,'Skills, Youth, and Opportunity','Upanuzi wa TVET na kuongeza upatikanaji wake','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 2'),
      ('sw',2,2,'Skills, Youth, and Opportunity','Ujuzi wa ufundi unaoendana na mahitaji ya soko la ajira','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 2'),
      ('sw',2,3,'Skills, Youth, and Opportunity','Maendeleo ya michezo','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 2'),
      ('sw',2,4,'Skills, Youth, and Opportunity','Udhamini wa masomo kupitia michezo','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 2'),
      ('sw',2,5,'Skills, Youth, and Opportunity','Ukanda wa Teknolojia','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 2'),

      ('sw',3,1,'Infrastructure, Security, and Livability','Barabara za kimkakati','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 3'),
      ('sw',3,2,'Infrastructure, Security, and Livability','Taa za barabarani na maeneo ya umma','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 3'),
      ('sw',3,3,'Infrastructure, Security, and Livability','Mitaa salama zaidi','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 3'),
      ('sw',3,4,'Infrastructure, Security, and Livability','Miundombinu inayochochea ukuaji na maendeleo','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 3'),
      ('sw',3,5,'Infrastructure, Security, and Livability','Ushirikiano wa miradi ya maji','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 3'),

      ('sw',4,1,'Local Economic Transformation','Uwezo na maandalizi ya kuvutia SEZ','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 4'),
      ('sw',4,2,'Local Economic Transformation','Kuongeza imani ya wawekezaji','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 4'),
      ('sw',4,3,'Local Economic Transformation','Kuimarisha mfumo wa “Mama Mboga” na “Boda boda”','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 4'),
      ('sw',4,4,'Local Economic Transformation','Uongezaji thamani: uchakataji wa bidhaa, uundaji chapa (branding), na kukuza biashara na ujasiriamali','DAVID PERE (5).pdf — page 2 — The Fresh Agenda — Pillar 4')
    ) as t(language_code,pillar_no,item_no,pillar_name,exact_text,source_reference)
  loop
    select id into v_pillar_id
    from public.message_pillars
    where name = rec.pillar_name
      and active = true
    limit 1;

    if not exists (
      select 1
      from public.message_bank_items mbi
      where mbi.exact_text = rec.exact_text
        and mbi.language_code = rec.language_code
        and mbi.source_reference = rec.source_reference
    ) then
      v_item_id := public.create_message_bank_item(
        'Manifesto ' || upper(rec.language_code) || ' P' || rec.pillar_no || '.' || rec.item_no,
        'manifesto_commitment',
        v_pillar_id,
        rec.exact_text,
        null,
        null,
        'commitment',
        'not_required',
        null,
        rec.source_reference,
        'Imported verbatim from the official manifesto PDF supplied by the user. No rewriting applied.',
        null,
        null,
        'Official manifesto import. Keep in Draft until human review.',
        'manifesto-import'
      );

      update public.message_bank_items
      set language_code = rec.language_code
      where id = v_item_id;
    end if;
  end loop;

  if not exists (
    select 1
    from public.message_bank_items
    where exact_text = 'Pere fresh, Kazi ianze!'
      and source_reference = 'DAVID PERE (5).pdf — pages 1–3'
  ) then
    v_item_id := public.create_message_bank_item(
      'Manifesto slogan',
      'values_statement',
      null,
      'Pere fresh, Kazi ianze!',
      null,
      null,
      'aspiration',
      'not_required',
      null,
      'DAVID PERE (5).pdf — pages 1–3',
      'Existing campaign slogan printed in the official manifesto PDF supplied by the user.',
      null,
      null,
      'Imported verbatim. No rewriting applied.',
      'manifesto-import'
    );

    update public.message_bank_items
    set language_code = 'mixed'
    where id = v_item_id;
  end if;
end;
$$;
