-- SellerBooks Finance order-level storage.
-- SellerBooksMBI only. Legacy SellerBooks production is not touched.
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
        unique (owner_user_id, store_id, marketplace_id, order_id),
    constraint sellerbooks_finance_orders_store_fkey
        foreign key (owner_user_id, marketplace_id, store_id)
        references public.sellerbooks_stores (owner_user_id, marketplace_id, id)
        on update cascade on delete cascade
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
    -- A later estimate must never downgrade a settled order.
    if old.finance_status = 'SETTLED_FINAL'
       and new.finance_status = 'UNSETTLED_ESTIMATE' then
        return old;
    end if;

    -- An incomplete settled response must not replace a complete settled record.
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

-- Match SellerBooks' existing client-data approval and Core Admin access model.
drop policy if exists sellerbooks_finance_orders_select_own
    on public.sellerbooks_finance_orders;
create policy sellerbooks_finance_orders_select_own
on public.sellerbooks_finance_orders
for select to authenticated
using (
    public.sellerbooks_can_access_client_data()
    and (
        owner_user_id = (select auth.uid())
        or public.sellerbooks_is_core_admin()
    )
);

drop policy if exists sellerbooks_finance_orders_insert_own
    on public.sellerbooks_finance_orders;
create policy sellerbooks_finance_orders_insert_own
on public.sellerbooks_finance_orders
for insert to authenticated
with check (
    public.sellerbooks_can_access_client_data()
    and (
        owner_user_id = (select auth.uid())
        or public.sellerbooks_is_core_admin()
    )
);

drop policy if exists sellerbooks_finance_orders_update_own
    on public.sellerbooks_finance_orders;
create policy sellerbooks_finance_orders_update_own
on public.sellerbooks_finance_orders
for update to authenticated
using (
    public.sellerbooks_can_access_client_data()
    and (
        owner_user_id = (select auth.uid())
        or public.sellerbooks_is_core_admin()
    )
)
with check (
    public.sellerbooks_can_access_client_data()
    and (
        owner_user_id = (select auth.uid())
        or public.sellerbooks_is_core_admin()
    )
);

-- Explicit Data API grants are required for newly-created public tables.
grant select, insert, update on public.sellerbooks_finance_orders to authenticated;
