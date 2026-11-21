create or replace function public.sellerbooks_api_complete_lazada_oauth(
  p_connection_id uuid,
  p_store_id text,
  p_seller_id text,
  p_credential text
)
returns public.sellerbooks_api_connections
language plpgsql
security definer
set search_path=public,vault
as $function$
declare
  v_row public.sellerbooks_api_connections;
  v_store public.sellerbooks_stores;
  v_secret_id uuid;
begin
  if p_connection_id is null
     or nullif(trim(p_store_id),'') is null
     or nullif(trim(p_seller_id),'') is null
     or nullif(trim(p_credential),'') is null then
    raise exception 'Lazada OAuth completion parameters are required';
  end if;

  select * into v_store
    from public.sellerbooks_stores
   where id=trim(p_store_id);

  if not found then
    raise exception 'Store not found';
  end if;

  if lower(trim(v_store.marketplace_id)) <> 'lazada' then
    raise exception 'Store is not configured for Lazada';
  end if;

  select * into v_row
    from public.sellerbooks_api_connections
   where id=p_connection_id
     and store_id=v_store.id
     and owner_user_id=v_store.owner_user_id
     and lower(trim(marketplace_id))='lazada'
   for update;

  if not found then
    raise exception 'API connection does not match the Lazada store owner';
  end if;

  if v_row.vault_secret_id is not null then
    perform vault.update_secret(
      v_row.vault_secret_id,
      p_credential,
      'sellerbooks_api_'||replace(v_row.id::text,'-',''),
      'SellerBooks Lazada OAuth credential'
    );
    v_secret_id:=v_row.vault_secret_id;
  else
    v_secret_id:=vault.create_secret(
      p_credential,
      'sellerbooks_api_'||replace(v_row.id::text,'-',''),
      'SellerBooks Lazada OAuth credential'
    );
  end if;

  update public.sellerbooks_api_connections
     set vault_secret_id=v_secret_id,
         external_store_id=trim(p_seller_id),
         connection_status='CONNECTED',
         sync_enabled=true,
         last_success_at=now(),
         last_error=null,
         updated_at=now()
   where id=v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all on function public.sellerbooks_api_complete_lazada_oauth(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.sellerbooks_api_complete_lazada_oauth(uuid,text,text,text) to service_role;
