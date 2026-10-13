-- Secure OpenAI API key storage for Chai O'Clock researcher/editor runtime.

create or replace function public.get_openai_api_key()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'chai_oclock_openai_api_key'
  order by updated_at desc
  limit 1;
$$;

create or replace function public.set_openai_api_key(p_api_key text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if p_api_key is null
     or length(trim(p_api_key)) < 40
     or trim(p_api_key) !~ '^sk-' then
    raise exception 'invalid OpenAI API key';
  end if;

  select id into v_secret_id
  from vault.secrets
  where name = 'chai_oclock_openai_api_key'
  order by updated_at desc
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      trim(p_api_key),
      'chai_oclock_openai_api_key',
      'OpenAI API key for Chai O''Clock Researcher + Editor runtime'
    );
  else
    perform vault.update_secret(
      secret_id := v_secret_id,
      new_secret := trim(p_api_key)
    );
  end if;
end;
$$;

create or replace function public.get_openai_setup_private_key()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'chai_oclock_openai_setup_private_key'
  order by updated_at desc
  limit 1;
$$;

create or replace function public.set_openai_setup_private_key(p_private_key text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if p_private_key is null or length(trim(p_private_key)) < 100 then
    raise exception 'invalid setup private key';
  end if;

  select id into v_secret_id
  from vault.secrets
  where name = 'chai_oclock_openai_setup_private_key'
  order by updated_at desc
  limit 1;

  if v_secret_id is null then
    perform vault.create_secret(
      p_private_key,
      'chai_oclock_openai_setup_private_key',
      'Temporary RSA private key for encrypted OpenAI API key handoff'
    );
  else
    perform vault.update_secret(
      secret_id := v_secret_id,
      new_secret := p_private_key
    );
  end if;
end;
$$;

create or replace function public.retire_openai_setup_private_key()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  select id into v_secret_id
  from vault.secrets
  where name = 'chai_oclock_openai_setup_private_key'
  order by updated_at desc
  limit 1;

  if v_secret_id is not null then
    perform vault.update_secret(
      secret_id := v_secret_id,
      new_secret := 'retired:' || gen_random_uuid()::text
    );
  end if;
end;
$$;

revoke all on function public.get_openai_api_key() from public, anon, authenticated;
revoke all on function public.set_openai_api_key(text) from public, anon, authenticated;
revoke all on function public.get_openai_setup_private_key() from public, anon, authenticated;
revoke all on function public.set_openai_setup_private_key(text) from public, anon, authenticated;
revoke all on function public.retire_openai_setup_private_key() from public, anon, authenticated;

grant execute on function public.get_openai_api_key() to service_role;
grant execute on function public.set_openai_api_key(text) to service_role;
grant execute on function public.get_openai_setup_private_key() to service_role;
grant execute on function public.set_openai_setup_private_key(text) to service_role;
grant execute on function public.retire_openai_setup_private_key() to service_role;
