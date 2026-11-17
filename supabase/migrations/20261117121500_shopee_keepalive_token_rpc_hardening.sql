create or replace function public.sellerbooks_verify_shopee_keepalive_token(p_token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select auth.uid() is null and exists (
    select 1 from sellerbooks_private.shopee_keepalive_auth a
    where a.id = 1 and a.token = coalesce(p_token, '')
  );
$$;
revoke all on function public.sellerbooks_verify_shopee_keepalive_token(text) from public;
grant execute on function public.sellerbooks_verify_shopee_keepalive_token(text) to anon, authenticated;
