/* =========================================================
   SELLERBOOKS FINANCE STORAGE
   Persist order-level marketplace finance audit data.
   This module does not alter sales imports or report calculations.
========================================================= */

(function(){
    "use strict";

    const COMPONENT_KEYS = [
        "platform_commission",
        "mall_service_fee",
        "affiliate_commission",
        "dynamic_commission",
        "order_processing_fee",
        "pph_22",
        "seller_borne_logistics"
    ];

    function getCurrentUserId(){
        return sellerBooksSupabase.auth.getUser().then(function(result){
            if(result.error) throw result.error;
            const user = result.data && result.data.user;
            if(!user || !user.id) throw new Error("Sesi pengguna tidak tersedia.");
            return user.id;
        });
    }

    function selectFinanceAudit(result){
        const settled = result && result.settled_lookup;
        const unsettled = result && result.unsettled_lookup;

        if(settled && settled.found && settled.fee_component_audit){
            return settled.fee_component_audit;
        }
        if(unsettled && unsettled.found && unsettled.fee_component_audit){
            return unsettled.fee_component_audit;
        }
        return null;
    }

    function validateAudit(audit){
        if(!audit || !audit.components || !audit.admin_marketplace_total){
            throw new Error("Struktur Finance audit tidak lengkap.");
        }
        const components = {};
        COMPONENT_KEYS.forEach(function(key){
            const item = audit.components[key];
            if(!item || typeof item !== "object"){
                throw new Error("Komponen Finance tidak ditemukan: " + key);
            }
            const amount = Number(item.amount);
            if(!Number.isFinite(amount)){
                throw new Error("Nilai komponen Finance tidak valid: " + key);
            }
            components[key] = {
                amount: amount,
                found: item.found === true,
                occurrences: Number(item.occurrences) || 0,
                paths: Array.isArray(item.paths) ? item.paths : []
            };
        });
        return components;
    }

    window.sellerBooksSelectFinanceAudit = selectFinanceAudit;

    window.sellerBooksPersistFinanceAudit = async function(input){
        input = input || {};
        const storeId = String(input.storeId || "").trim();
        const marketplaceId = String(input.marketplaceId || "").trim();
        const orderId = String(input.orderId || "").trim();
        const result = input.result || {};

        if(!storeId || !marketplaceId || !orderId){
            throw new Error("Store ID, Marketplace ID, dan Order ID wajib tersedia.");
        }

        const audit = selectFinanceAudit(result);
        if(!audit){
            return { saved:false, reason:"NO_FINANCE_ROWS" };
        }

        const components = validateAudit(audit);
        const total = Number(audit.admin_marketplace_total.amount);
        if(!Number.isFinite(total)){
            throw new Error("Total tujuh komponen Finance tidak valid.");
        }

        const userId = await getCurrentUserId();
        const status = audit.source_mode === "SETTLED_FINAL"
            ? "SETTLED_FINAL"
            : "UNSETTLED_ESTIMATE";

        const payload = {
            owner_user_id: userId,
            store_id: storeId,
            marketplace_id: marketplaceId,
            marketplace: "TikTok Shop",
            order_id: orderId,
            finance_status: status,
            currency: audit.currency || null,
            components: components,
            seven_component_total: total,
            components_complete: audit.admin_marketplace_total.complete === true,
            readiness: String(audit.readiness || "UNKNOWN"),
            reconciliation: audit.reconciliation || {},
            source_audit: {
                source_mode: audit.source_mode || status,
                reported_aggregate_source: audit.reported_aggregate_source || null,
                admin_marketplace_total: audit.admin_marketplace_total,
                warnings: Array.isArray(audit.warnings) ? audit.warnings : [],
                sku_transaction_count: Number(audit.sku_transaction_count) || 0,
                order_transaction_count: Number(audit.order_transaction_count) || 0
            },
            fetched_at: new Date().toISOString()
        };

        const saved = await sellerBooksSupabase
            .from("sellerbooks_finance_orders")
            .upsert(payload, {
                onConflict: "owner_user_id,store_id,marketplace_id,order_id"
            })
            .select("id,finance_status,components_complete,seven_component_total,currency")
            .single();

        if(saved.error) throw saved.error;
        return { saved:true, record:saved.data };
    };

    window.sellerBooksLoadFinanceOrders = async function(filters){
        filters = filters || {};
        const query = sellerBooksSupabase
            .from("sellerbooks_finance_orders")
            .select("id,store_id,marketplace_id,marketplace,order_id,finance_status,currency,components,seven_component_total,components_complete,readiness,reconciliation,source_audit,fetched_at")
            .order("fetched_at",{ascending:false});

        if(Array.isArray(filters.storeIds) && filters.storeIds.length){
            query.in("store_id",filters.storeIds.map(String));
        }
        if(filters.orderIds && Array.isArray(filters.orderIds) && filters.orderIds.length){
            query.in("order_id",filters.orderIds.map(String));
        }
        if(filters.status){
            query.eq("finance_status",String(filters.status));
        }
        const result = await query;
        if(result.error) throw result.error;
        return Array.isArray(result.data) ? result.data : [];
    };

    window.sellerBooksFinanceComponentKeys = COMPONENT_KEYS.slice();
})();
