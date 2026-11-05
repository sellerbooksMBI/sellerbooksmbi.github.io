# SellerBooks Finance storage and sync path

## Scope

The seven-component Finance storage foundation is integrated into SellerBooksMBI `main`. The legacy SellerBooks production repository and database are not modified.

The first connected source is TikTok Shop's Finance audit. The storage schema is order-level and marketplace-aware so later marketplace adapters can use the same persistence model. It does not change sales imports, HPP, refunds, packing, daily snapshots, report calculations, the legacy Admin % SKU field, or the legacy Store fee-percent field.

## Data path

1. The existing read-only `sellerbooks-tiktok-finance-audit` Edge Function retrieves settled and unsettled source records.
2. `js/modules/marketplaces/finance-storage.js` selects settled data when settled rows exist; otherwise it selects the unsettled estimate.
3. The selected audit is persisted in `sellerbooks_finance_orders`, keyed by owner, store, marketplace and Order ID.
4. The database trigger prevents an unsettled estimate from downgrading a settled record and prevents an incomplete settled response from replacing a complete settled record.
5. Report integration remains a separate stage. Reports must read complete Finance records and allocate order-level fees across SKU rows without duplicating order fees.

## Seven component keys

- `platform_commission`
- `mall_service_fee`
- `affiliate_commission`
- `dynamic_commission`
- `order_processing_fee`
- `pph_22`
- `seller_borne_logistics`

The audit keeps each amount's source paths and reconciliation metadata. Missing components remain missing; they are never silently treated as zero.

## Database deployment

- `supabase/migrations/20261105101526_sellerbooks_finance_orders.sql` was applied to the SellerBooks-only Supabase project.
- `supabase/migrations/20261105101554_sellerbooks_finance_store_fk_index.sql` adds the index for the composite store foreign key.
- The table has RLS enabled, explicit `authenticated` Data API grants, owner/Core Admin policies aligned with SellerBooks approval rules, and a composite foreign key to the matching owner, marketplace and store.
- No existing sales rows, snapshots, or legacy fee settings were rewritten.

## Validation performed

- Confirmed the table exists with RLS enabled and the composite store foreign key.
- Tested an authenticated owner's insert and read under RLS inside a rolled-back transaction.
- Tested that an unsettled estimate cannot replace an existing complete settled record inside a rolled-back transaction.
- Supabase performance advisor no longer reports the Finance store foreign key as unindexed. New-table indexes may still appear as unused until actual Finance records are synced.

## Manual audit UI

Connected TikTok Shop stores now show a **Uji Finance / Finance Audit** action. Enter one TikTok Order ID and its order-creation date/time to run the read-only audit. The panel displays the seven component amounts and the selected settled/estimate source; the audit helper reports whether cloud persistence succeeded.

## Next steps

1. Run one unsettled and one settled TikTok Shop Finance audit through the SellerBooksMBI UI.
2. Confirm repeated sync is idempotent and the saved component amounts match the audit response.
3. Implement the report adapter only after source data is verified; reconcile old-vs-new profit by order and SKU.
4. Keep Admin % SKU and Store fee-percent fields as fallback until all report comparisons pass. Remove those controls from the UI only after the seven-component model is proven accurate.
