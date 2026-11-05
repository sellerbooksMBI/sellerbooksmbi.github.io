-- SellerBooks Finance order-level storage.
-- Apply only after reviewing this migration on the finance feature branch.
-- Existing sellerbooks_user_data and historical sales snapshots are untouched.

create table if not exists public.sellerbooks_finance_orders (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null,
    store_id text not null,
    marketplace_id text not null,
    marketplace text not null default 'TikTok Shop',
    order_id text not null,
    finance_status text not null check (finance_status in ('UNSETTLED_ESTIMATE', 'SETTLED_FINAL')),
    currency text,
    components jsonb not null default '{}'::jsonb,
    seven_component_total numeric(20, 6),
    components_complete boolean not null default false,
    readiness text,
    reconciliation jsonb not null default '{}'::jsonb,
    source_audit jsonb not null default '{}'::jsonb,
    source_updated_at timestamptz,
    fetched_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint sellerbooks_finance_orders_identity
        unique (owner_user_id, store_id, marketplace_id, order_id)
);

create index if not exists sellerbooks_finance_orders_owner_date_idx
    on public.sellerbooks_finance_orders (owner_user_id, fetched_at desc);
create index if not exists sellerbooks_finance_orders_store_order_idx
    on public.sellerbooks_finance_orders (owner_user_id, store_id, order_id);
create index if not exists sellerbooks_finance_orders_status_idx
    on public.sellerbooks_finance_orders (owner_user_id, finance_status);

create or replace function public.sellerbooks_protect_settled_finance_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    -- Never let a later estimate downgrade an order already marked settled.
    if old.finance_status = 'SETTLED_FINAL'
       and new.finance_status = 'UNSETTLED_ESTIMATE' then
        return old;
    end if;

    -- Do not replace a complete settled record with an incomplete settled response.
    if old.finance_status = 'SETTLED_FINAL'
       and old.components_complete
       and new.finance_status = 'SETTLED_FINAL'
       and not new.components_complete then
        return old;
    end if;

    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists sellerbooks_finance_orders_protect_settled
    on public.sellerbooks_finance_orders;
create trigger sellerbooks_finance_orders_protect_settled
before update on public.sellerbooks_finance_orders
for each row execute function public.sellerbooks_protect_settled_finance_order();

alter table public.sellerbooks_finance_orders enable row level security;

drop policy if exists sellerbooks_finance_orders_select_own
    on public.sellerbooks_finance_orders;
create policy sellerbooks_finance_orders_select_own
on public.sellerbooks_finance_orders
for select to authenticated
using (
    owner_user_id = auth.uid()
    and exists (
        select 1
        from public.sellerbooks_stores s
        where s.id = sellerbooks_finance_orders.store_id
          and s.owner_user_id = auth.uid()
    )
);

drop policy if exists sellerbooks_finance_orders_insert_own
    on public.sellerbooks_finance_orders;
create policy sellerbooks_finance_orders_insert_own
on public.sellerbooks_finance_orders
for insert to authenticated
with check (
    owner_user_id = auth.uid()
    and exists (
        select 1
        from public.sellerbooks_stores s
        where s.id = sellerbooks_finance_orders.store_id
          and s.owner_user_id = auth.uid()
    )
);

drop policy if exists sellerbooks_finance_orders_update_own
    on public.sellerbooks_finance_orders;
create policy sellerbooks_finance_orders_update_own
on public.sellerbooks_finance_orders
for update to authenticated
using (
    owner_user_id = auth.uid()
    and exists (
        select 1
        from public.sellerbooks_stores s
        where s.id = sellerbooks_finance_orders.store_id
          and s.owner_user_id = auth.uid()
    )
)
with check (
    owner_user_id = auth.uid()
    and exists (
        select 1
        from public.sellerbooks_stores s
        where s.id = sellerbooks_finance_orders.store_id
          and s.owner_user_id = auth.uid()
    )
);

grant select, insert, update on public.sellerbooks_finance_orders to authenticated;
