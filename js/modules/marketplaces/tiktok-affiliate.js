/* =========================================================
   SELLERBOOKS TIKTOK AFFILIATE LOOKUP
   Reads only the Affiliate Commission value for one Order ID.
   No Finance table writes and no sales-engine side effects.
========================================================= */
window.sellerBooksFetchTikTokAffiliate = async function(orderId, orderCreateTime, storeId){
    const order=String(orderId||"").trim();
    const createTime=Number(orderCreateTime||0);
    if(!order || !createTime) throw new Error("Order ID dan waktu pembuatan wajib tersedia.");

    const store=(Array.isArray(stores)?stores:[]).find(function(item){
        if(String(item.id)!==String(storeId||"")) return false;
        const marketplace=Array.isArray(marketplaces)
            ? marketplaces.find(function(mp){return String(mp.id)===String(item.marketplaceId);})
            : null;
        return /tiktok/i.test(String(marketplace?.name||item.marketplace||""));
    });
    if(!store) throw new Error("Akun toko TikTok Shop tidak ditemukan.");

    const connection=getStoreIntegrationConnection(store);
    if(!connection || String(connection.connection_status||"").toUpperCase()!=="CONNECTED"){
        throw new Error("Koneksi TikTok Shop tidak aktif.");
    }
    const session=(await sellerBooksSupabase.auth.getSession())?.data?.session;
    if(!session?.access_token) throw new Error("Sesi login tidak tersedia.");

    const response=await fetch(SELLERBOOKS_SUPABASE_URL+"/functions/v1/sellerbooks-tiktok-finance-audit",{
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
    });
    const result=await response.json().catch(function(){return {};});
    if(!response.ok || !result.ok) throw new Error(String(result.error||("TikTok affiliate lookup HTTP "+response.status)));
    const affiliate=result.affiliate_commission||{};
    return {
        order_id:order,
        found:affiliate.found===true,
        amount:affiliate.found===true ? Number(affiliate.amount)||0 : null,
        source_mode:String(affiliate.source_mode||""),
        source_field:String(affiliate.source_field||""),
        status:String(affiliate.status||"UNAVAILABLE")
    };
};

