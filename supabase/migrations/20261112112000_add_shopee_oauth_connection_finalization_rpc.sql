
CREATE OR REPLACE FUNCTION public.sellerbooks_api_complete_shopee_oauth(
  p_connection_id uuid,
  p_store_id text,
  p_shop_id text,
  p_credential text,
  p_shop_name text DEFAULT NULL::text
)
RETURNS public.sellerbooks_api_connections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_row public.sellerbooks_api_connections;
  v_store public.sellerbooks_stores;
  v_secret_id uuid;
BEGIN
  IF p_connection_id IS NULL
     OR nullif(trim(p_store_id), '') IS NULL
     OR nullif(trim(p_shop_id), '') IS NULL
     OR nullif(trim(p_credential), '') IS NULL THEN
    RAISE EXCEPTION 'OAuth completion parameters are required';
  END IF;

  SELECT * INTO v_store
    FROM public.sellerbooks_stores
   WHERE id = trim(p_store_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Store not found';
  END IF;

  IF lower(trim(v_store.marketplace_id)) <> 'shopee' THEN
    RAISE EXCEPTION 'Store is not configured for Shopee';
  END IF;

  SELECT * INTO v_row
    FROM public.sellerbooks_api_connections
   WHERE id = p_connection_id
     AND store_id = v_store.id
     AND owner_user_id = v_store.owner_user_id
     AND lower(trim(marketplace_id)) = 'shopee'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'API connection does not match the Shopee store owner';
  END IF;

  IF v_row.vault_secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(
      v_row.vault_secret_id,
      p_credential,
      'sellerbooks_api_' || replace(v_row.id::text, '-', ''),
      'SellerBooks Shopee OAuth credential'
    );
    v_secret_id := v_row.vault_secret_id;
  ELSE
    v_secret_id := vault.create_secret(
      p_credential,
      'sellerbooks_api_' || replace(v_row.id::text, '-', ''),
      'SellerBooks Shopee OAuth credential'
    );
  END IF;

  UPDATE public.sellerbooks_api_connections
     SET vault_secret_id = v_secret_id,
         external_store_id = trim(p_shop_id),
         connection_status = 'CONNECTED',
         sync_enabled = true,
         last_success_at = now(),
         last_error = null,
         updated_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.sellerbooks_api_complete_shopee_oauth(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sellerbooks_api_complete_shopee_oauth(uuid, text, text, text, text) TO service_role;
