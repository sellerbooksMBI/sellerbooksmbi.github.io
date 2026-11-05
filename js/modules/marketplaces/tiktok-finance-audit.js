/* =====================================================
   SELLERBOOKS TIKTOK FINANCE AUDIT
   Read-only diagnostic. Does not write sales/import data.
===================================================== */
async function sellerBooksAuditTikTokOrder(orderId, orderCreateTime, storeId){
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
    const audit=settled || unsettled;
    const complete=Boolean(audit?.admin_marketplace_total?.complete);
    const message=complete
        ? "Audit Finance TikTok selesai. Tujuh komponen ditemukan. Buka Console browser untuk melihat rincian."
        : "Audit Finance TikTok berhasil dipanggil, tetapi data komponen belum lengkap. Buka Console browser untuk melihat hasil dan error.";
    if(typeof sellerBooksAlert==="function"){
        sellerBooksAlert(message,"Audit Finance TikTok");
    }
    return result;
}
