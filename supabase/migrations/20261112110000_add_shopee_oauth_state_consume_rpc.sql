-- Restores the one-time OAuth state consumer used by the proven legacy Shopee flow.
-- Only the Edge Function service role may consume state hashes.
CREATE OR REPLACE FUNCTION public.sellerbooks_api_consume_oauth_state(p_state_hash text)
RETURNS TABLE(owner_user_id uuid, store_id text, connection_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF nullif(trim(p_state_hash), '') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.sellerbooks_api_oauth_states AS s
     SET consumed_at = now()
   WHERE s.state_hash = trim(p_state_hash)
     AND s.consumed_at IS NULL
     AND s.expires_at > now()
  RETURNING s.owner_user_id, s.store_id, s.connection_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.sellerbooks_api_consume_oauth_state(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sellerbooks_api_consume_oauth_state(text) TO service_role;
