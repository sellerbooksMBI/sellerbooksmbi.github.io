create schema if not exists extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists sellerbooks_private;
revoke all on schema sellerbooks_private from public, anon, authenticated;

create table if not exists sellerbooks_private.shopee_keepalive_auth (
  id smallint primary key check (id = 1),
  token text not null,
  updated_at timestamptz not null default now()
);
revoke all on table sellerbooks_private.shopee_keepalive_auth from public, anon, authenticated;

create or replace function public.sellerbooks_verify_shopee_keepalive_token(p_token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from sellerbooks_private.shopee_keepalive_auth a
    where a.id = 1 and a.token = coalesce(p_token, '')
  );
$$;
revoke all on function public.sellerbooks_verify_shopee_keepalive_token(text) from public;
grant execute on function public.sellerbooks_verify_shopee_keepalive_token(text) to anon, authenticated;

do $$
declare v_token text := encode(gen_random_bytes(32), 'hex');
begin
  insert into sellerbooks_private.shopee_keepalive_auth(id, token, updated_at)
  values (1, v_token, now())
  on conflict (id) do update set token = excluded.token, updated_at = now();
  perform vault.create_secret(
    v_token,
    'sellerbooks_shopee_keepalive_token',
    'Internal token for scheduled Shopee OAuth token maintenance'
  );
end;
$$;

select cron.schedule(
  'sellerbooks-shopee-token-keepalive',
  '0 */12 * * *',
  $job$
    select net.http_post(
      url := 'https://vrgiwzxwnfjhpmxcahwo.supabase.co/functions/v1/sellerbooks-shopee-token-keepalive',
      headers := jsonb_build_object('Content-Type','application/json'),
      body := jsonb_build_object(
        'token',
        (select decrypted_secret from vault.decrypted_secrets where name='sellerbooks_shopee_keepalive_token' limit 1)
      )
    ) as request_id;
  $job$
);
