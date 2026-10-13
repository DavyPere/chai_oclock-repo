-- Chai O'Clock: one-time browser OAuth setup for Canva Connect API.

create table if not exists public.canva_oauth_sessions (
  state text primary key,
  code_verifier text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists canva_oauth_sessions_expires_idx
  on public.canva_oauth_sessions(expires_at);

alter table public.canva_oauth_sessions enable row level security;

create or replace function public.set_canva_oauth_credentials(
  p_client_id text,
  p_client_secret text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_client_id_secret uuid;
  v_client_secret_secret uuid;
begin
  if p_client_id is null or length(trim(p_client_id)) < 8 then
    raise exception 'invalid Canva client id';
  end if;

  if p_client_secret is null or length(trim(p_client_secret)) < 20 then
    raise exception 'invalid Canva client secret';
  end if;

  select id into v_client_id_secret
  from vault.secrets
  where name = 'chai_oclock_canva_client_id'
  order by updated_at desc
  limit 1;

  if v_client_id_secret is null then
    perform vault.create_secret(
      trim(p_client_id),
      'chai_oclock_canva_client_id',
      'Canva OAuth client ID for Chai O''Clock'
    );
  else
    perform vault.update_secret(
      secret_id := v_client_id_secret,
      new_secret := trim(p_client_id)
    );
  end if;

  select id into v_client_secret_secret
  from vault.secrets
  where name = 'chai_oclock_canva_client_secret'
  order by updated_at desc
  limit 1;

  if v_client_secret_secret is null then
    perform vault.create_secret(
      trim(p_client_secret),
      'chai_oclock_canva_client_secret',
      'Canva OAuth client secret for Chai O''Clock'
    );
  else
    perform vault.update_secret(
      secret_id := v_client_secret_secret,
      new_secret := trim(p_client_secret)
    );
  end if;
end;
$$;

create or replace function public.get_canva_oauth_credentials()
returns table(client_id text, client_secret text)
language sql
security definer
set search_path = public, vault
as $$
  select
    (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'chai_oclock_canva_client_id'
      order by updated_at desc
      limit 1
    ) as client_id,
    (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'chai_oclock_canva_client_secret'
      order by updated_at desc
      limit 1
    ) as client_secret;
$$;

create or replace function public.create_canva_oauth_session(
  p_state text,
  p_code_verifier text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_state is null or length(p_state) < 20 then
    raise exception 'invalid OAuth state';
  end if;

  if p_code_verifier is null or length(p_code_verifier) < 43 then
    raise exception 'invalid PKCE code verifier';
  end if;

  if p_redirect_uri is null or p_redirect_uri not like 'https://%.supabase.co/functions/v1/canva-oauth-callback' then
    raise exception 'invalid redirect URI';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '30 minutes' then
    raise exception 'invalid OAuth session expiry';
  end if;

  delete from public.canva_oauth_sessions
  where expires_at < now() - interval '1 hour';

  insert into public.canva_oauth_sessions(
    state,
    code_verifier,
    redirect_uri,
    expires_at
  )
  values (
    p_state,
    p_code_verifier,
    p_redirect_uri,
    p_expires_at
  );
end;
$$;

create or replace function public.consume_canva_oauth_session(
  p_state text
)
returns table(code_verifier text, redirect_uri text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.canva_oauth_sessions
  set used_at = now()
  where state = p_state
    and used_at is null
    and expires_at > now()
  returning canva_oauth_sessions.code_verifier,
            canva_oauth_sessions.redirect_uri;
end;
$$;

revoke all on table public.canva_oauth_sessions from public, anon, authenticated;

revoke all on function public.set_canva_oauth_credentials(text,text) from public, anon, authenticated;
revoke all on function public.get_canva_oauth_credentials() from public, anon, authenticated;
revoke all on function public.create_canva_oauth_session(text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.consume_canva_oauth_session(text) from public, anon, authenticated;

grant execute on function public.set_canva_oauth_credentials(text,text) to service_role;
grant execute on function public.get_canva_oauth_credentials() to service_role;
grant execute on function public.create_canva_oauth_session(text,text,text,timestamptz) to service_role;
grant execute on function public.consume_canva_oauth_session(text) to service_role;
