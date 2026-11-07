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


/*
 * Repair historical TikTok imports whose affiliate lookup was skipped or
 * unavailable during the original pull. Updates only affiliateCommissionAmount
 * on one transaction row per Order ID; sales, SKU fees, QTY and COGS are untouched.
 */
window.sellerBooksReconcileMissingTikTokAffiliate = async function(){
    if(window.__sellerBooksAffiliateReconcilePromise){
        return window.__sellerBooksAffiliateReconcilePromise;
    }
    window.__sellerBooksAffiliateReconcilePromise=(async function(){
        if(!sellerBooksCloudReady || sellerBooksCloudLoading || !sellerBooksAuthUser){
            throw new Error("Sinkronisasi cloud belum siap untuk pemeriksaan affiliate lama.");
        }
        let imports=[];
        try{
            imports=JSON.parse(sellerBooksStorage.getItem("sellerbooks_sales_imports")||"[]")||[];
        }catch(error){
            throw new Error("Data import penjualan tidak dapat dibaca.");
        }

        const orderGroups=new Map();
        imports.forEach(function(record){
            if(!/tiktok/i.test(String(record.marketplace||"")))return;
            (record.transactions||[]).forEach(function(tx,index){
                const orderId=String(tx.orderId||"").trim();
                if(!orderId)return;
                const storeId=String(tx.storeId||record.storeId||"");
                const key=storeId+"::"+orderId;
                if(!orderGroups.has(key)){
                    orderGroups.set(key,{
                        storeId:storeId,
                        orderId:orderId,
                        orderCreateTime:Number(tx.orderCreateTime||0) || (function(){
                            const rawDate=tx.transactionDate||tx.reportDate||record.reportDate||tx.importedAt||record.importedAt;
                            if(!rawDate)return 0;
                            const parsed=Date.parse(String(rawDate));
                            return Number.isFinite(parsed)&&parsed>0?Math.floor(parsed/1000):0;
                        })(),
                        recordId:String(record.id||""),
                        transactionIndex:index,
                        alreadyHasAffiliate:false
                    });
                }
                if(Number(tx.affiliateCommissionAmount||0)>0){
                    orderGroups.get(key).alreadyHasAffiliate=true;
                }
            });
        });
        const pending=new Map();
        orderGroups.forEach(function(item,key){
            if(!item.alreadyHasAffiliate)pending.set(key,item);
        });
        if(!pending.size)return {checked:0,updated:0};

        const resolved=[];
        const failed=[];
        for(const item of pending.values()){
            if(!item.orderCreateTime){
                failed.push(item.orderId+" (waktu pembuatan order tidak tersimpan)");
                continue;
            }
            let result=null;
            let lastError=null;
            for(let attempt=1;attempt<=3;attempt++){
                try{
                    result=await window.sellerBooksFetchTikTokAffiliate(
                        item.orderId,item.orderCreateTime,item.storeId
                    );
                    if(result.found===true && Number.isFinite(Number(result.amount)))break;
                    lastError=new Error("Affiliate belum tersedia");
                }catch(error){
                    lastError=error;
                }
                if(attempt<3)await new Promise(function(resolve){setTimeout(resolve,attempt*1000);});
            }
            if(!result || result.found!==true || !Number.isFinite(Number(result.amount))){
                failed.push(item.orderId+" ("+(lastError?.message||"lookup gagal")+")");
                continue;
            }
            resolved.push({item:item,amount:Math.abs(Number(result.amount)||0)});
        }

        if(!resolved.length){
            if(typeof sellerBooksAlert==="function"){
                const en=typeof sellerBooksCurrentLanguage==="function"&&sellerBooksCurrentLanguage()==="en";
                sellerBooksAlert(
                    (en?"No TikTok affiliate amounts could be recovered.\\n":"Belum ada biaya affiliate TikTok yang berhasil ditemukan.\\n")+
                    failed.join("\\n"),
                    en?"Affiliate repair needs attention":"Affiliate belum ditemukan"
                );
            }
            return {checked:pending.size,updated:0,failed:failed};
        }

        const updatedImports=imports.map(function(record){
            const copy={...record,transactions:(record.transactions||[]).map(function(tx){return {...tx};})};
            return copy;
        });
        let updated=0;
        resolved.forEach(function(entry){
            const target=updatedImports.find(function(record){return String(record.id||"")===entry.item.recordId;});
            if(!target)return;
            const tx=target.transactions[entry.item.transactionIndex];
            if(!tx || String(tx.orderId||"").trim()!==entry.item.orderId)return;
            tx.affiliateCommissionAmount=entry.amount;
            updated++;
        });
        if(!updated)return {checked:pending.size,updated:0,failed:failed};

        sellerBooksStorage.setItem("sellerbooks_sales_imports",JSON.stringify(updatedImports));
        if(typeof sellerBooksInvalidateSalesReportCaches==="function"){
            sellerBooksInvalidateSalesReportCaches();
        }
        const expected=sellerBooksCloneCloudState(sellerBooksCloudState);
        await sellerBooksPersistCloudDataStrict(expected,function(savedData){
            let saved=[];
            try{saved=JSON.parse(savedData["sellerbooks_sales_imports"]||"[]")||[];}catch(error){return false;}
            const byId=new Map(saved.map(function(record){return [String(record.id||""),record];}));
            return resolved.every(function(entry){
                const record=byId.get(entry.item.recordId);
                const tx=record?.transactions?.[entry.item.transactionIndex];
                return tx && String(tx.orderId||"").trim()===entry.item.orderId &&
                    Math.abs(Number(tx.affiliateCommissionAmount||0)-entry.amount)<0.01;
            });
        });
        if(typeof sellerBooksRefreshActiveViewAfterSalesImport==="function"){
            sellerBooksRefreshActiveViewAfterSalesImport();
        }else if(typeof updateReports==="function"){
            updateReports();
        }
        if(typeof sellerBooksAlert==="function"){
            const en=typeof sellerBooksCurrentLanguage==="function"&&sellerBooksCurrentLanguage()==="en";
            sellerBooksAlert(
                en
                    ? "TikTok affiliate repair saved: "+updated+" order(s)."+(failed.length?"\\nStill unavailable: "+failed.join(", "):"")
                    : "Perbaikan biaya affiliate TikTok berhasil disimpan untuk "+updated+" order."+(failed.length?"\\nMasih belum tersedia: "+failed.join(", "):""),
                en?"Affiliate repair":"Perbaikan Affiliate"
            );
        }
        return {checked:pending.size,updated:updated,failed:failed};
    })();
    try{
        return await window.__sellerBooksAffiliateReconcilePromise;
    }finally{
        window.__sellerBooksAffiliateReconcilePromise=null;
    }
};
