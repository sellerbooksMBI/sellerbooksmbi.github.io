# SellerBooks Finance storage and sync path

## Scope of this branch

This branch introduces an isolated, order-level Finance persistence layer for TikTok Shop's seven mapped components. It does not change sales imports, HPP, refunds, packing, daily snapshots, the legacy Admin % SKU field, or the legacy Store fee-percent field.

## Data path

1. The existing read-only `sellerbooks-tiktok-finance-audit` Edge Function retrieves settled and unsettled source records.
2. `js/modules/marketplaces/finance-storage.js` selects settled data when settled rows exist; otherwise it selects the unsettled estimate.
3. The selected audit is persisted in `sellerbooks_finance_orders`, keyed by owner, store, marketplace and Order ID.
4. The database trigger prevents an unsettled estimate from downgrading a settled record and prevents an incomplete settled response from replacing a complete settled record.
5. Report integration is deliberately a separate stage. Reports must read complete Finance records and allocate order-level fees across SKU rows without duplicating order fees.

## Seven component keys

- `platform_commission`
- `mall_service_fee`
- `affiliate_commission`
- `dynamic_commission`
- `order_processing_fee`
- `pph_22`
- `seller_borne_logistics`

The raw audit keeps each amount's source paths and reconciliation metadata. Missing components remain missing; they are never silently treated as zero.

## Deployment order

1. Review and apply `supabase/migrations/20261105090000_sellerbooks_finance_orders.sql` to the SellerBooks Supabase project.
2. Deploy the frontend branch with the new Finance storage module.
3. Run Finance audit tests on one unsettled and one settled TikTok order.
4. Confirm that repeated sync is idempotent and that settled status cannot regress.
5. Only after verified order-level records exist, implement the report adapter and run old-vs-new profit reconciliation.
6. Keep Admin % SKU and Store fee-percent fields until all report comparisons pass.

## Not included yet

- No report formula is switched to Finance in this branch.
- No production migration is applied by this change.
- No existing sales or snapshot rows are rewritten.
