/* =========================================================
   SELLERBOOKS TIKTOK AFFILIATE LOOKUP
   Reads only the Affiliate Commission value for one Order ID.
   No Finance table writes and no sales-engine side effects.
========================================================= */
window.sellerBooksFetchTikTokAffiliate = async function(orderId, orderCreateTime, storeId){
    const order=String(orderId||"").trim();
    if(!order) throw new Error("Order ID wajib tersedia.");

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
            order_id:order
        })
    });
    const result=await response.json().catch(function(){return {};});
    if(!response.ok || !result.ok) throw new Error(String(result.error||("TikTok affiliate lookup HTTP "+response.status)));
    /* Edge Function v16 returns affiliate_commission and lookup.
       Lookup eligibility is based only on exact Order ID, never order date. */
    const affiliate=result?.affiliate_commission||{};
    const lookup=result?.lookup||{};
    const lookupError=String(lookup.error||"");
    const exactOrderFound=lookup.unsettled_order_found===true;
    const found=affiliate.found===true && Number.isFinite(Number(affiliate.amount));
    const incomplete=!exactOrderFound;
    const error=lookupError || (incomplete ? "ORDER_LOOKUP_INCOMPLETE: exact Order ID was not verified in unsettled transactions." : "");
    return {
        order_id:order,
        found:found,
        amount:found ? Number(affiliate.amount)||0 : (exactOrderFound ? 0 : null),
        source_mode:String(affiliate.source_mode||"UNSETTLED_ESTIMATE"),
        source_field:String(affiliate.source_field||""),
        status:found ? "AFFILIATE_FOUND" : (error ? "LOOKUP_ERROR" : "AFFILIATE_NOT_AVAILABLE"),
        error:error
    };
};



/*
 * Post-import affiliate lookup. The order import is already durable before
 * this runs. Each Order ID is updated once; missing/failed lookup remains Rp0.
 */
window.sellerBooksApplyTikTokAffiliateForImportedOrders = async function(storeId, orderIds){
    const ids=Array.from(new Set((Array.isArray(orderIds)?orderIds:[])
        .map(function(value){return String(value||"").trim();}).filter(Boolean)));
    if(!ids.length)return {checked:0,found:0,zero:0,failed:0};
    if(!sellerBooksCloudReady || sellerBooksCloudLoading || !sellerBooksAuthUser){
        throw new Error("Sinkronisasi cloud belum siap.");
    }

    const keySet=new Set(ids);
    const imports=JSON.parse(sellerBooksStorage.getItem("sellerbooks_sales_imports")||"[]")||[];
    const pending=[];
    imports.forEach(function(record){
        if(String(record.storeId||"")!==String(storeId)||!/tiktok/i.test(String(record.marketplace||"")))return;
        const perOrder=new Map();
        (record.transactions||[]).forEach(function(tx,index){
            const orderId=String(tx.orderId||"").trim();
            if(!keySet.has(orderId))return;
            if(!perOrder.has(orderId))perOrder.set(orderId,{recordId:String(record.id||""),index:index,orderId:orderId});
        });
        perOrder.forEach(function(item){pending.push(item);});
    });
    if(!pending.length)return {checked:0,found:0,zero:0,failed:0};

    const amounts=new Map();
    let found=0,failed=0;
    for(const item of pending){
        let result=null;
        try{
            result=await window.sellerBooksFetchTikTokAffiliate(item.orderId,0,storeId);
        }catch(error){
            failed++;
        }
        if(!result || result.error){
            if(result?.error)console.warn("TikTok affiliate lookup incomplete for Order ID",item.orderId,result.error);
            continue; // Never overwrite finance data with Rp0 when lookup failed.
        }
        const amount=Math.abs(Number(result.amount)||0);
        if(result.found===true)found++;
        amounts.set(item.recordId+"::"+item.orderId,amount);
    }

    const latest=JSON.parse(sellerBooksStorage.getItem("sellerbooks_sales_imports")||"[]")||[];
    let updated=0;
    latest.forEach(function(record){
        if(String(record.storeId||"")!==String(storeId)||!/tiktok/i.test(String(record.marketplace||"")))return;
        const seen=new Set();
        (record.transactions||[]).forEach(function(tx){
            const orderId=String(tx.orderId||"").trim();
            const key=String(record.id||"")+"::"+orderId;
            if(!amounts.has(key))return;
            if(!seen.has(orderId)){
                tx.affiliateCommissionAmount=amounts.get(key);
                seen.add(orderId);
                updated++;
            }else{
                tx.affiliateCommissionAmount=0;
            }
        });
    });

    sellerBooksStorage.setItem("sellerbooks_sales_imports",JSON.stringify(latest));
    if(typeof sellerBooksInvalidateSalesReportCaches==="function")sellerBooksInvalidateSalesReportCaches();
    if(typeof sellerBooksCloudSaveTimer!=="undefined" && sellerBooksCloudSaveTimer){
        clearTimeout(sellerBooksCloudSaveTimer);
        sellerBooksCloudSaveTimer=null;
    }
    const expected=sellerBooksCloneCloudState(sellerBooksCloudState);
    await sellerBooksPersistCloudDataStrict(expected,function(savedData){
        let saved=[];
        try{saved=JSON.parse(savedData["sellerbooks_sales_imports"]||"[]")||[];}catch(error){return false;}
        const verify=new Map();
        saved.forEach(function(record){
            if(String(record.storeId||"")!==String(storeId))return;
            (record.transactions||[]).forEach(function(tx){
                const key=String(record.id||"")+"::"+String(tx.orderId||"").trim();
                if(amounts.has(key)&&!verify.has(key))verify.set(key,Number(tx.affiliateCommissionAmount||0));
            });
        });
        return Array.from(amounts.entries()).every(function(entry){
            return verify.has(entry[0])&&Math.abs(verify.get(entry[0])-entry[1])<0.01;
        });
    });
    if(typeof sellerBooksRefreshActiveViewAfterSalesImport==="function")sellerBooksRefreshActiveViewAfterSalesImport();
    else if(typeof updateReports==="function")updateReports();
    return {checked:pending.length,found:found,zero:Math.max(0,pending.length-found-failed),failed:failed,updated:updated};
};
