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
            order_id:order,
            order_create_time:Number(orderCreateTime||0)
        })
    });
    const result=await response.json().catch(function(){return {};});
    if(!response.ok || !result.ok) throw new Error(String(result.error||("TikTok affiliate lookup HTTP "+response.status)));
    /* Edge Function v16 returns affiliate_commission and lookup.
       Lookup eligibility is based only on exact Order ID, never order date. */
    const affiliate=result?.affiliate_commission||{};
    const lookup=result?.lookup||{};
    /* An explicit TikTok field value, including "0", is confirmed.
       An omitted field means pending, not confirmed Rp0. */
    const found=affiliate.found===true &&
        lookup.fee_field_confirmed===true &&
        Number.isFinite(Number(affiliate.amount));
    const error=found ? "" : String(lookup.error||"AFFILIATE_FEE_NOT_YET_AVAILABLE_FOR_EXACT_ORDER_ID");
    return {
        order_id:order,
        found:found,
        amount:found ? Number(affiliate.amount)||0 : null,
        source_mode:String(affiliate.source_mode||"UNSETTLED_ESTIMATE"),
        source_field:String(affiliate.source_field||""),
        diagnostic:affiliate.diagnostic||{},
        lookup_diagnostic:lookup.diagnostic||{},
        status:found ? "CONFIRMED" : "PENDING",
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
            if(!perOrder.has(orderId))perOrder.set(orderId,{
                recordId:String(record.id||""),
                index:index,
                orderId:orderId,
                orderCreateTime:Number(tx.orderCreateTime||0)
            });
        });
        perOrder.forEach(function(item){pending.push(item);});
    });
    if(!pending.length)return {checked:0,found:0,zero:0,failed:0};

    const amounts=new Map();
    const details=[];
    let found=0,failed=0,zero=0;

    /*
       Performance-only optimization:
       keep the exact same per-Order-ID Finance lookup and confirmation rules,
       but run a small bounded group concurrently instead of waiting for each
       Order ID to finish before starting the next one. A limit of 3 avoids
       flooding TikTok/Supabase and preserves the existing retry semantics.
    */
    const lookupResults=new Array(pending.length);
    let nextLookupIndex=0;
    const lookupConcurrency=Math.min(3,pending.length);
    await Promise.all(Array.from({length:lookupConcurrency},async function(){
        while(true){
            const index=nextLookupIndex++;
            if(index>=pending.length)return;
            const item=pending[index];
            try{
                lookupResults[index]={result:await window.sellerBooksFetchTikTokAffiliate(
                    item.orderId,item.orderCreateTime,storeId
                )};
            }catch(error){
                lookupResults[index]={error:error};
            }
        }
    }));

    for(let index=0;index<pending.length;index++){
        const item=pending[index];
        const lookup=lookupResults[index]||{};
        const result=lookup.result||null;
        if(lookup.error){
            failed++;
            details.push({order_id:item.orderId,status:"FAILED",error:String(lookup.error?.message||lookup.error)});
            console.warn("TikTok affiliate lookup failed for Order ID",item.orderId,lookup.error);
            continue;
        }
        if(!result || result.status!=="CONFIRMED" || result.error){
            failed++;
            details.push({order_id:item.orderId,status:"PENDING",error:String(result?.error||"No confirmed fee field")});
            if(result?.error)console.warn("TikTok affiliate lookup pending for Order ID",item.orderId,result.error);
            continue; // Missing fee data is retried later; it is not Rp0.
        }
        const amount=Math.abs(Number(result.amount)||0);
        if(amount>0)found++;
        else zero++;
        details.push({
            order_id:item.orderId,
            status:amount>0?"AFFILIATE_FOUND":"CONFIRMED_ZERO",
            amount:amount,
            source_mode:String(result.source_mode||""),
            source_field:String(result.source_field||""),
            diagnostic:result.diagnostic||{},
            lookup_diagnostic:result.lookup_diagnostic||{}
        });
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
            tx.affiliateCommissionStatus="CONFIRMED";
            tx.affiliateCommissionSource="TIKTOK_FINANCE";
            tx.affiliateCommissionSourceMode=String(details.find(function(item){return item.order_id===orderId;})?.source_mode||"");
            tx.affiliateCommissionCheckedAt=new Date().toISOString();
            if(!seen.has(orderId)){
                tx.affiliateCommissionAmount=amounts.get(key);
                seen.add(orderId);
                updated++;
            }else{
                tx.affiliateCommissionAmount=0;
            }
        });
    });

    const serializedImports=JSON.stringify(latest);
    sellerBooksStorage.setItem("sellerbooks_sales_imports",serializedImports);
    /*
       IMPORTANT: persistCloudDataStrict serializes sellerBooksCloudState, not
       the localStorage wrapper. Update the cloud snapshot before saving;
       otherwise the old snapshot overwrites the affiliate amounts on refresh.
    */
    if(sellerBooksCloudState && typeof sellerBooksCloudState==="object"){
        sellerBooksCloudState["sellerbooks_sales_imports"]=serializedImports;
    }
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
                if(amounts.has(key)&&!verify.has(key))verify.set(key,{
                    amount:Number(tx.affiliateCommissionAmount||0),
                    status:String(tx.affiliateCommissionStatus||"")
                });
            });
        });
        return Array.from(amounts.entries()).every(function(entry){
            return verify.has(entry[0])&&
                verify.get(entry[0]).status==="CONFIRMED"&&
                Math.abs(verify.get(entry[0]).amount-entry[1])<0.01;
        });
    });
    if(typeof sellerBooksRefreshActiveViewAfterSalesImport==="function")sellerBooksRefreshActiveViewAfterSalesImport();
    else if(typeof updateReports==="function")updateReports();
    return {
        checked:pending.length,
        found:found,
        zero:zero,
        failed:failed,
        updated:updated,
        details:details
    };
};
