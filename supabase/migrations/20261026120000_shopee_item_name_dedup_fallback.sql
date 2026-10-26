-- Isolated migration for review: Shopee transactions without SKU use itemName as fallback.
-- Does not alter production until this migration is deliberately applied.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'sellerbooks_operator_import_sales_internal'
    AND p.pronargs = 1;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'sellerbooks_operator_import_sales_internal(jsonb) not found';
  END IF;

  v_old := 'v_old_stock numeric; v_new_stock numeric; v_deduct numeric; v_prod_id text; v_i int;';
  v_new := 'v_old_stock numeric; v_new_stock numeric; v_deduct numeric; v_prod_id text; v_i int; v_item_key text;';
  IF position(v_new IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected routine declaration; aborting safely';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END IF;

  v_old := 'v_sku:=trim(coalesce(v_item->>''sku'','''')); v_qty:=coalesce((v_item->>''qty'')::numeric,0);';
  v_new := v_old || E'\n   v_item_key:=lower(v_sku);\n   if v_item_key='''' and lower(trim(v_marketplace))=''shopee'' and trim(coalesce(v_item->>''itemName'',''''))<>'''' then\n     v_item_key:=''item:''||lower(trim(coalesce(v_item->>''itemName'','''')));\n   end if;';
  IF position('v_item_key:=lower(v_sku);' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected transaction loop; aborting safely';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END IF;

  v_old := 'end||''|''||lower(v_sku);';
  v_new := 'end||''|''||v_item_key;';
  IF position(v_new IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected dedup identity expression; aborting safely';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END IF;

  v_old := 'end||''|''||lower(trim(coalesce(oldt->>''sku'',''''))) = v_ident) into v_existing;';
  v_new := 'end||''|''||case' || E'\n               when trim(coalesce(oldt->>''sku'',''''))<>'''' then lower(trim(coalesce(oldt->>''sku'','''')))' ||
           E'\n               when lower(trim(coalesce(oldt->>''marketplaceId'',oldt->>''marketplace'','''')))=''shopee''' ||
           E'\n                    and trim(coalesce(oldt->>''itemName'',''''))<>'''' then ''item:''||lower(trim(coalesce(oldt->>''itemName'','''')))' ||
           E'\n               else '''' end = v_ident) into v_existing;';
  IF position('then ''item:''||lower(trim(coalesce(oldt->>''itemName'','''')))' IN v_definition) = 0 THEN
    IF position(v_old IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected existing-row identity expression; aborting safely';
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END IF;

  EXECUTE v_definition;
END
$migration$;
