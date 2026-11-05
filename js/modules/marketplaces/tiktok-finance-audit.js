/* =====================================================
   SELLERBOOKS TIKTOK FINANCE AUDIT
   Read-only diagnostic. Does not write sales/import data.
===================================================== */
window.sellerBooksAuditTikTokOrder = async function(orderId, orderCreateTime, storeId){
    const order=String(orderId||"").trim();
    const createTime=Number(orderCreateTime||0);
    if(!order || !createTime){
        throw new Error("Order ID dan waktu pembuatan Unix (detik) wajib diisi.");
    }

    const candidates=(Array.isArray(stores)?stores:[]).filter(function(store){
        if(storeId && String(store.id)!==String(storeId))return false;
        const marketplace=Array.isArray(marketplaces)
            ? marketplaces.find(function(item){return String(item.id)===String(store.marketplaceId);})
            : null;
        return /tiktok/i.test(String(marketplace?.name||store.marketplace||""));
    });
    const store=candidates.find(function(item){
        const connection=getStoreIntegrationConnection(item);
        return String(connection?.connection_status||"").toUpperCase()==="CONNECTED";
    });
    if(!store)throw new Error("Akun toko TikTok Shop yang terhubung tidak ditemukan.");

    const connection=getStoreIntegrationConnection(store);
    const sessionResult=await sellerBooksSupabase.auth.getSession();
    const session=sessionResult?.data?.session;
    if(!session?.access_token)throw new Error("Sesi login tidak tersedia. Silakan login kembali.");

    const response=await fetch(
        SELLERBOOKS_SUPABASE_URL+"/functions/v1/sellerbooks-tiktok-finance-audit",
        {
            method:"POST",
            headers:{
                "apikey":SELLERBOOKS_SUPABASE_KEY,
                "Authorization":"Bearer "+session.access_token,
                "Content-Type":"application/json"
            },
            body:JSON.stringify({
                connection_id:String(connection.id),
                store_id:String(store.id),
                order_id:order,
                order_create_time:createTime
            })
        }
    );
    const result=await response.json().catch(function(){return {};});
    if(!response.ok || !result.ok){
        throw new Error(String(result.error||("Finance audit HTTP "+response.status)));
    }

    console.group("SellerBooks TikTok Finance Audit — "+order);
    console.log(result);
    console.groupEnd();

    const settled=result.settled_lookup?.fee_component_audit;
    const unsettled=result.unsettled_lookup?.fee_component_audit;
    const settledHasRows=Boolean(result.settled_lookup?.found);
    const unsettledFound=Boolean(result.unsettled_lookup?.found);
    const audit=settledHasRows ? settled : (unsettledFound ? unsettled : settled);
    let financePersistence={saved:false,reason:"PERSISTENCE_NOT_AVAILABLE"};
    if(audit && typeof window.sellerBooksPersistFinanceAudit==="function"){
        try{
            financePersistence=await window.sellerBooksPersistFinanceAudit({
                storeId:String(store.id),
                marketplaceId:String(store.marketplaceId||"tiktok_shop"),
                orderId:order,
                result:result
            });
        }catch(persistError){
            financePersistence={saved:false,error:String(persistError?.message||persistError)};
            console.error("Finance audit berhasil dibaca tetapi belum tersimpan:",persistError);
        }
    }
    const complete=Boolean(audit?.admin_marketplace_total?.complete);
    const reconciliation=audit?.reconciliation;
    const message=complete
        ? (audit?.source_mode==="UNSETTLED_ESTIMATE"
            ? "Rincian tujuh komponen ditemukan pada data estimasi unsettled. Nilai masih dapat berubah setelah settlement."
            : "Audit Finance TikTok selesai. Tujuh komponen ditemukan pada data settled.")
        : (unsettledFound
            ? "Data estimasi unsettled ditemukan. Ada komponen yang belum tersedia pada sumber ini; lihat rincian dan selisih rekonsiliasi di Console."
            : "Respons settled diterima tetapi belum memiliki baris transaksi. Periksa hasil audit di Console.");
    console.info("TikTok Finance audit selected source:", audit?.source_mode || "NONE",
        "seven-component amount:", audit?.admin_marketplace_total?.amount,
        "reconciliation:", reconciliation || "not available");
    if(typeof sellerBooksAlert==="function"){
        const persistenceMessage=financePersistence.saved
            ? " Data Finance tersimpan ke cloud."
            : " Data audit belum tersimpan ke cloud: "+String(financePersistence.error||financePersistence.reason||"modul penyimpanan belum tersedia")+".";
        sellerBooksAlert(message+persistenceMessage,"Audit Finance TikTok");
    }
    return result;
}
