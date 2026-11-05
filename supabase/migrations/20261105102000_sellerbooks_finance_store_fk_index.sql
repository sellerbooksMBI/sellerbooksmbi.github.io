-- Cover the composite store foreign key for efficient store deletes/updates.
create index if not exists sellerbooks_finance_orders_store_fk_idx
    on public.sellerbooks_finance_orders (owner_user_id, marketplace_id, store_id);