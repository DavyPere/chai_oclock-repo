-- Chai O'Clock Step 1: neutral presentation structure for approved manifesto wording.

alter table public.message_bank_items
  add column if not exists presentation_type text,
  add column if not exists manifesto_pair_key text;

alter table public.message_bank_items
  drop constraint if exists message_bank_presentation_type_check;

alter table public.message_bank_items
  add constraint message_bank_presentation_type_check
  check (
    presentation_type is null
    or presentation_type = any(array[
      'short_commitment',
      'standard_commitment',
      'extended_commitment',
      'named_initiative',
      'slogan'
    ]::text[])
  );

create index if not exists message_bank_pair_key_idx
  on public.message_bank_items(manifesto_pair_key)
  where manifesto_pair_key is not null;

-- Link the English and Swahili versions using the Pn.n identifier already present in internal_label.
update public.message_bank_items
set manifesto_pair_key = substring(internal_label from 'P[0-9]+\.[0-9]+')
where source_reference like 'DAVID PERE (5).pdf%'
  and internal_label like 'Manifesto % P%.%'
  and manifesto_pair_key is null;

-- Slogan is its own presentation type.
update public.message_bank_items
set presentation_type = 'slogan'
where source_reference = 'DAVID PERE (5).pdf — pages 1–3'
  and exact_text = 'Pere fresh, Kazi ianze!';

-- Named initiative: use the bilingual pair so EN/SW counterparts stay together.
update public.message_bank_items
set presentation_type = 'named_initiative'
where source_reference like 'DAVID PERE (5).pdf%'
  and manifesto_pair_key = 'P2.5';

-- Compact lines: short enough for a compact design without rewriting.
update public.message_bank_items
set presentation_type = 'short_commitment'
where source_reference like 'DAVID PERE (5).pdf%'
  and presentation_type is null
  and (
    language_code = 'en'
    and manifesto_pair_key in (
      'P1.1','P1.2','P1.3','P1.4',
      'P2.1','P2.2','P2.3','P2.4',
      'P3.1','P3.2','P3.3','P3.4','P3.5',
      'P4.1'
    )
    or
    language_code = 'sw'
    and manifesto_pair_key in (
      'P1.2','P1.4',
      'P2.3',
      'P3.1','P3.3',
      'P4.2'
    )
  );

-- Standard lines: medium-length exact wording.
update public.message_bank_items
set presentation_type = 'standard_commitment'
where source_reference like 'DAVID PERE (5).pdf%'
  and presentation_type is null
  and (
    language_code = 'en'
    and manifesto_pair_key in ('P4.2','P4.3','P4.4')
    or
    language_code = 'sw'
    and manifesto_pair_key in (
      'P1.1','P1.3',
      'P2.1','P2.4',
      'P3.2','P3.4','P3.5',
      'P4.1','P4.3'
    )
  );

-- Extended lines: exact wording that needs a larger text area.
update public.message_bank_items
set presentation_type = 'extended_commitment'
where source_reference like 'DAVID PERE (5).pdf%'
  and presentation_type is null
  and language_code = 'sw'
  and manifesto_pair_key in ('P2.2','P4.4');

comment on column public.message_bank_items.presentation_type is
  'Neutral layout classification based on exact wording length/structure; not a persuasion score or priority.';
comment on column public.message_bank_items.manifesto_pair_key is
  'Links exact English/Swahili counterparts from the official manifesto, e.g. P2.5.';
