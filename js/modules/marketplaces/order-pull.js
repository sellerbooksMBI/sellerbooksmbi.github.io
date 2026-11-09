/* =====================================================
   SELLERBOOKS MARKETPLACE ORDER PULL
   Existing function bodies relocated unchanged.
===================================================== */

function sellerBooksSetPullOrderBusy(storeId,busy,marketplace){
    const id=String(storeId||"");
    const name=String(marketplace||"").toLowerCase();
    const selector='button[onclick*="syncTikTokOrdersNow"],button[onclick*="syncShopeeOrdersNow"],button[onclick*="syncLazadaOrdersNow"],button[onclick*="syncBlibliOrdersNow"]';
    document.querySelectorAll(selector).forEach(function(button){
        const handler=String(button.getAttribute("onclick")||"").toLowerCase();
        if(id && !handler.includes(id.toLowerCase()))return;
        if(name && !handler.includes(name.toLowerCase()))return;
        if(busy){
            if(button.dataset.sellerbooksPullBusy==="true")return;
            button.dataset.sellerbooksPullBusy="true";
            button.dataset.sellerbooksPullOriginalText=button.textContent||"";
            button.dataset.sellerbooksPullWasDisabled=button.disabled?"true":"false";
            button.disabled=true;
            button.setAttribute("aria-busy","true");
            button.textContent=sellerBooksPullOrderIsEN()?"Fetching & saving…":"Sedang mengambil & menyimpan…";
        }else if(button.dataset.sellerbooksPullBusy==="true"){
            button.disabled=button.dataset.sellerbooksPullWasDisabled==="true";
            button.textContent=button.dataset.sellerbooksPullOriginalText||button.textContent;
            button.removeAttribute("aria-busy");
            delete button.dataset.sellerbooksPullBusy;
            delete button.dataset.sellerbooksPullOriginalText;
            delete button.dataset.sellerbooksPullWasDisabled;
        }
    });
}

async function syncTikTokOrdersNowInternal(storeId){
    const store=stores.find(function(item){
        return String(item.id)===String(storeId);
    });

    if(!store){
        sellerBooksAlert(
            sellerBooksPullOrderText("missingStore","TikTok"),
            sellerBooksPullOrderText("loadingTitle","TikTok")
        );
        return;
    }

    const connection=getStoreIntegrationConnection(store);

    if(
        !connection ||
        String(connection.connection_status||"").toUpperCase()!=="CONNECTED"
    ){
        sellerBooksAlert(
            sellerBooksPullOrderText("notConnected","TikTok"),
            sellerBooksPullOrderText("loadingTitle","TikTok")
        );
        return;
    }

    try{
        sellerBooksSetPullOrderBusy(storeId,true,"TikTok");
        sellerBooksAlert(
            sellerBooksPullOrderText("loading","TikTok"),
            sellerBooksPullOrderText("loadingTitle","TikTok")
        );

        const sessionResult=
            await sellerBooksSupabase.auth.getSession();

        const session=sessionResult?.data?.session;

        if(!session?.access_token){
            throw new Error(
                sellerBooksPullOrderText("noSession","TikTok")
            );
        }

        const response=await fetch(
            SELLERBOOKS_SUPABASE_URL+
            "/functions/v1/sellerbooks-tiktok-sync-orders",
            {
                method:"POST",
                headers:{
                    "apikey":SELLERBOOKS_SUPABASE_KEY,
                    "Authorization":"Bearer "+session.access_token,
                    "Content-Type":"application/json"
                },
                body:JSON.stringify({
                    connection_id:String(connection.id),
                    store_id:String(store.id)
                })
            }
        );

        const data=await response.json().catch(function(){
            return {};
        });

        if(!response.ok||!data.ok){
            let message=
                data.error ||
                sellerBooksPullOrderText("failedFetch","TikTok");

            if(data.diagnostic){
                message+=
                    "\n\nDIAGNOSTIC:\n"+
                    JSON.stringify(
                        data.diagnostic,
                        null,
                        2
                    );
            }

            throw new Error(message);
        }

        const result=Array.isArray(data.results)
            ? data.results.find(function(x){
                return String(x.connection_id||"")===
                    String(connection.id);
            })||data.results[0]
            : null;

        if(!result){
            throw new Error(
                sellerBooksPullOrderText("noFile","TikTok")
            );
        }

        if(result.status==="ERROR"){
            throw new Error(
                String(
                    result.error||
                    sellerBooksPullOrderText("apiError","TikTok")
                )
            );
        }

        if(result.status==="NO_ORDERS"){
            /* Walau tidak ada order baru dari marketplace, retry Order ID
               lama yang affiliate-nya belum terkonfirmasi. */
            const pendingAffiliateIds=new Set();
            try{
                const savedImports=JSON.parse(sellerBooksStorage.getItem("sellerbooks_sales_imports")||"[]")||[];
                const orderStates=new Map();
                savedImports.forEach(function(record){
                    if(String(record.storeId||"")!==String(store.id)||!/tiktok/i.test(String(record.marketplace||"")))return;
                    (record.transactions||[]).forEach(function(tx){
                        const id=String(tx.orderId||"").trim();
                        if(!id)return;
                        const confirmed=String(tx.affiliateCommissionStatus||"").toUpperCase()==="CONFIRMED" ||
                            Math.abs(Number(tx.affiliateCommissionAmount)||0)>0;
                        if(confirmed)orderStates.set(id,true);
                        else if(!orderStates.has(id))orderStates.set(id,false);
                    });
                });
                orderStates.forEach(function(confirmed,id){if(!confirmed)pendingAffiliateIds.add(id);});
            }catch(storageError){
                console.warn("Tidak dapat membaca antrean affiliate pending:",storageError);
            }

            if(pendingAffiliateIds.size && typeof window.sellerBooksApplyTikTokAffiliateForImportedOrders==="function"){
                try{
                    const outcome=await window.sellerBooksApplyTikTokAffiliateForImportedOrders(
                        String(store.id),Array.from(pendingAffiliateIds)
                    );
                    const en=sellerBooksPullOrderIsEN();
                    sellerBooksAlert(
                        en
                            ? "No new orders. Retried affiliate for "+outcome.checked+" pending Order IDs; "+
                              outcome.found+" fees found, "+outcome.zero+" confirmed Rp0, and "+
                              outcome.failed+" still pending/failed."
                            : "Tidak ada order baru. Pemeriksaan ulang affiliate untuk "+outcome.checked+" Order ID tertunda; "+
                              outcome.found+" biaya ditemukan, "+outcome.zero+" dipastikan Rp0, dan "+
                              outcome.failed+" masih menunggu/gagal.",
                        en ? "TikTok Affiliate Recheck" : "Pemeriksaan Ulang Affiliate TikTok"
                    );
                }catch(affiliateError){
                    sellerBooksAlert(
                        "Tidak ada order baru. Pemeriksaan ulang affiliate belum selesai: "+
                        String(affiliateError?.message||affiliateError),
                        "Pemeriksaan Affiliate TikTok"
                    );
                }
            }else{
                sellerBooksAlert(
                    sellerBooksPullOrderText("noOrders","TikTok",Number(result.orders_found||0)),
                    sellerBooksPullOrderText("resultTitle","TikTok")
                );
            }
            return;
        }

        if(result.status==="RAW_FILE_READY"){
            /* Tahap 1: masukkan semua order ke mesin Import Penjualan terlebih dahulu.
               Affiliate tidak boleh menahan order; nilai awal setiap order adalah Rp0. */
            await sellerBooksDispatchExcelQueue({showResult:true});

            /*
             * Tahap 2: finance_orders adalah daftar Order ID yang benar-benar
             * dikembalikan oleh Tarik Order saat ini. Periksa SEMUA ID tersebut,
             * termasuk yang dianggap duplikat oleh mesin import. Menghapus laporan
             * atau mengimpor ulang tidak boleh membuat pemeriksaan affiliate terlewati.
             * Penulisan biaya tetap idempotent: satu nominal per Order ID.
             */
            const financeOrders=Array.isArray(result.finance_orders)?result.finance_orders:[];
            const uniqueOrderIds=[];
            const seenOrderIds=new Set();
            financeOrders.forEach(function(item){
                const id=String(item?.order_id||"").trim();
                if(!id||seenOrderIds.has(id))return;
                seenOrderIds.add(id);
                uniqueOrderIds.push(id);
            });

            /* Tambahkan Order ID lama yang memang masih pending, agar bisa retry
               meskipun tidak muncul lagi pada daftar order yang baru ditarik. */
            try{
                const savedImports=JSON.parse(sellerBooksStorage.getItem("sellerbooks_sales_imports")||"[]")||[];
                const orderStates=new Map();
                savedImports.forEach(function(record){
                    if(String(record.storeId||"")!==String(store.id)||!/tiktok/i.test(String(record.marketplace||"")))return;
                    (record.transactions||[]).forEach(function(tx){
                        const id=String(tx.orderId||"").trim();
                        if(!id)return;
                        const confirmed=String(tx.affiliateCommissionStatus||"").toUpperCase()==="CONFIRMED" ||
                            Math.abs(Number(tx.affiliateCommissionAmount)||0)>0;
                        if(confirmed)orderStates.set(id,true);
                        else if(!orderStates.has(id))orderStates.set(id,false);
                    });
                });
                orderStates.forEach(function(confirmed,id){
                    if(!confirmed&&!seenOrderIds.has(id)){
                        seenOrderIds.add(id);
                        uniqueOrderIds.push(id);
                    }
                });
            }catch(storageError){
                console.warn("Tidak dapat membaca antrean affiliate pending:",storageError);
            }

            if(uniqueOrderIds.length && typeof window.sellerBooksApplyTikTokAffiliateForImportedOrders==="function"){
                try{
                    const outcome=await window.sellerBooksApplyTikTokAffiliateForImportedOrders(
                        String(store.id),uniqueOrderIds
                    );
                    console.info("TikTok affiliate batch result:",outcome);
                    const en=sellerBooksPullOrderIsEN();
                    sellerBooksAlert(
                        en
                            ? "Orders imported. Affiliate checked for "+outcome.checked+" new Order IDs; "+
                              outcome.found+" found, "+outcome.zero+" confirmed unavailable (Rp0), and "+
                              outcome.failed+" lookup failures."
                            : "Order berhasil masuk. Affiliate diperiksa untuk "+outcome.checked+" Order ID baru; "+
                              outcome.found+" ditemukan, "+outcome.zero+" dipastikan tidak tersedia (Rp0), dan "+
                              outcome.failed+" pemeriksaan gagal.",
                        en ? "TikTok Affiliate Check Results" : "Hasil Pemeriksaan Affiliate TikTok"
                    );
                }catch(affiliateError){
                    console.error("Pemeriksaan affiliate setelah import gagal:",affiliateError);
                    sellerBooksAlert(
                        "Order tetap berhasil masuk. Pemeriksaan affiliate belum selesai; nilai sementara tetap Rp0. "+
                        (affiliateError?.message||"Silakan coba lagi nanti."),
                        "Pemeriksaan Affiliate TikTok"
                    );
                }
            }
            return;
        }

        sellerBooksAlert(
            sellerBooksPullOrderText("status","TikTok")+
            String(result.status||"UNKNOWN"),
            sellerBooksPullOrderText("resultTitle","TikTok")
        );

    }catch(error){
        console.error(
            "Tarik order TikTok gagal:",
            error
        );

        sellerBooksAlert(
            sellerBooksPullOrderText("failedOrders","TikTok")+"\n\n"+
            (error?.message||
                sellerBooksPullOrderText("unexpected","TikTok")),
            sellerBooksPullOrderText("loadingTitle","TikTok")
        );
    }
}

async function syncTikTokOrdersNow(storeId){
    const key=String(storeId||"");
    if(window.__sellerBooksPullBusyStore===key && key)return;
    window.__sellerBooksPullBusyStore=key;
    const store=stores.find(function(item){return String(item.id)===key;});
    try{
        return await syncTikTokOrdersNowInternal(storeId);
    }finally{
        sellerBooksSetPullOrderBusy(storeId,false,"TikTok");
        if(window.__sellerBooksPullBusyStore===key)window.__sellerBooksPullBusyStore=null;
    }
}

async function syncShopeeOrdersNowInternal(storeId){
    const store=stores.find(item=>String(item.id)===String(storeId));
    if(!store){sellerBooksAlert(sellerBooksPullOrderText("missingStore","Shopee"),"Tarik Order Shopee");return;}
    const marketplace=marketplaces.find(item=>item.id===store.marketplaceId);
    if(!String(marketplace?.name||"").toLowerCase().replace(/\s+/g,"").includes("shopee")){sellerBooksAlert(sellerBooksPullOrderText("wrongMarketplace","Shopee"),"Tarik Order Shopee");return;}
    const connection=getStoreIntegrationConnection(store);
    if(!connection||String(connection.connection_status||"").toUpperCase()!=="CONNECTED"){sellerBooksAlert(sellerBooksPullOrderText("notConnected","Shopee"),"Tarik Order Shopee");return;}
    try{
        sellerBooksSetPullOrderBusy(storeId,true,"Shopee");
        sellerBooksAlert(sellerBooksPullOrderText("loading","Shopee"),sellerBooksPullOrderText("errorTitle","Shopee"));
        const session=(await sellerBooksSupabase.auth.getSession())?.data?.session;
        if(!session?.access_token)throw new Error(sellerBooksPullOrderText("noSession","Shopee"));
        const now=Date.now(),timeFrom=new Date(now-7*86400000).toISOString(),timeTo=new Date(now).toISOString();
        const response=await fetch(SELLERBOOKS_SUPABASE_URL+"/functions/v1/sellerbooks-shopee-sync-orders",{method:"POST",headers:{apikey:SELLERBOOKS_SUPABASE_KEY,Authorization:"Bearer "+session.access_token,"Content-Type":"application/json"},body:JSON.stringify({connection_id:String(connection.id),store_id:String(store.id),time_from:timeFrom,time_to:timeTo})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok||!data.ok)throw new Error(data.error||sellerBooksPullOrderText("failedFetch","Shopee"));
        if(data.status==="NO_ORDERS"){sellerBooksAlert(sellerBooksPullOrderText("noOrders","Shopee",Number(data.orders_found||0)),sellerBooksPullOrderText("resultTitle","Shopee"));return;}
        if(data.status==="RAW_FILE_READY"){await sellerBooksDispatchExcelQueue({showResult:true});return;}
        throw new Error(sellerBooksPullOrderText("status","Shopee")+String(data.status||"UNKNOWN"));
    }catch(error){console.error("Tarik order Shopee gagal:",error);sellerBooksAlert(sellerBooksPullOrderText("failedOrders","Shopee")+"\n\n"+(error?.message||"Terjadi kesalahan."),sellerBooksPullOrderText("errorTitle","Shopee"));}
}

async function syncShopeeOrdersNow(storeId){
    const key=String(storeId||"");
    if(window.__sellerBooksPullBusyStore===key && key)return;
    window.__sellerBooksPullBusyStore=key;
    const store=stores.find(function(item){return String(item.id)===key;});
    try{
        return await syncShopeeOrdersNowInternal(storeId);
    }finally{
        sellerBooksSetPullOrderBusy(storeId,false,"Shopee");
        if(window.__sellerBooksPullBusyStore===key)window.__sellerBooksPullBusyStore=null;
    }
}

async function syncLazadaOrdersNowInternal(storeId){
    const store=stores.find(item=>String(item.id)===String(storeId));
    if(!store){sellerBooksAlert(sellerBooksPullOrderText("missingStore","Lazada"),"Tarik Order Lazada");return;}
    const marketplace=marketplaces.find(item=>item.id===store.marketplaceId);
    if(!String(marketplace?.name||"").toLowerCase().replace(/\s+/g,"").includes("lazada")){sellerBooksAlert(sellerBooksPullOrderText("wrongMarketplace","Lazada"),"Tarik Order Lazada");return;}
    const connection=getStoreIntegrationConnection(store);
    if(!connection||String(connection.connection_status||"").toUpperCase()!=="CONNECTED"){sellerBooksAlert(sellerBooksPullOrderText("notConnected","Lazada"),"Tarik Order Lazada");return;}
    try{
        sellerBooksSetPullOrderBusy(storeId,true,"Lazada");
        sellerBooksAlert(sellerBooksPullOrderText("loading","Lazada"),sellerBooksPullOrderText("errorTitle","Lazada"));
        const session=(await sellerBooksSupabase.auth.getSession())?.data?.session;
        if(!session?.access_token)throw new Error(sellerBooksPullOrderText("noSession","Lazada"));
        const now=Math.floor(Date.now()/1000),timeFrom=now-7*86400,timeTo=now;
        const response=await fetch(SELLERBOOKS_SUPABASE_URL+"/functions/v1/sellerbooks-lazada-sync-orders",{method:"POST",headers:{apikey:SELLERBOOKS_SUPABASE_KEY,Authorization:"Bearer "+session.access_token,"Content-Type":"application/json"},body:JSON.stringify({connection_id:String(connection.id),store_id:String(store.id),time_from:timeFrom,time_to:timeTo})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok||!data.ok)throw new Error(data.error||sellerBooksPullOrderText("failedFetch","Lazada"));
        const result=Array.isArray(data.results)?data.results.find(x=>String(x.connection_id||"")===String(connection.id))||data.results[0]:null;
        if(!result)throw new Error(sellerBooksPullOrderText("noFile","Lazada"));
        if(result.status==="ERROR")throw new Error(String(result.error||sellerBooksPullOrderText("apiError","Lazada")));
        if(result.status==="NO_ORDERS"){sellerBooksAlert(sellerBooksPullOrderText("noOrders","Lazada",Number(result.orders_found||0)),sellerBooksPullOrderText("resultTitle","Lazada"));return;}
        if(result.status==="RAW_FILE_READY"){await sellerBooksDispatchExcelQueue({showResult:true});return;}
        throw new Error(sellerBooksPullOrderText("status","Lazada")+String(result.status||"UNKNOWN"));
    }catch(error){console.error("Tarik order Lazada gagal:",error);sellerBooksAlert(sellerBooksPullOrderText("failedOrders","Lazada")+"\n\n"+(error?.message||"Terjadi kesalahan."),sellerBooksPullOrderText("errorTitle","Lazada"));}
}

async function syncLazadaOrdersNow(storeId){
    const key=String(storeId||"");
    if(window.__sellerBooksPullBusyStore===key && key)return;
    window.__sellerBooksPullBusyStore=key;
    const store=stores.find(function(item){return String(item.id)===key;});
    try{
        return await syncLazadaOrdersNowInternal(storeId);
    }finally{
        sellerBooksSetPullOrderBusy(storeId,false,"Lazada");
        if(window.__sellerBooksPullBusyStore===key)window.__sellerBooksPullBusyStore=null;
    }
}

async function syncBlibliOrdersNowInternal(storeId){
    const store=stores.find(item=>String(item.id)===String(storeId));
    if(!store){sellerBooksAlert(sellerBooksPullOrderText("missingStore","Blibli"),sellerBooksPullOrderText("loadingTitle","Blibli"));return;}
    const marketplace=marketplaces.find(item=>item.id===store.marketplaceId);
    if(!String(marketplace?.name||"").toLowerCase().replace(/\s+/g,"").includes("blibli")){sellerBooksAlert(sellerBooksPullOrderText("wrongMarketplace","Blibli"),sellerBooksPullOrderText("loadingTitle","Blibli"));return;}
    const connection=getStoreIntegrationConnection(store);
    if(!connection||String(connection.connection_status||"").toUpperCase()!=="CONNECTED"){sellerBooksAlert(sellerBooksPullOrderText("notConnected","Blibli"),sellerBooksPullOrderText("loadingTitle","Blibli"));return;}
    try{
        sellerBooksSetPullOrderBusy(storeId,true,"Blibli");
        sellerBooksAlert(sellerBooksPullOrderText("loading","Blibli"),sellerBooksPullOrderText("loadingTitle","Blibli"));
        const session=(await sellerBooksSupabase.auth.getSession())?.data?.session;
        if(!session?.access_token)throw new Error(sellerBooksPullOrderText("noSession","Blibli"));
        const now=Math.floor(Date.now()/1000),timeFrom=now-7*86400,timeTo=now;
        const response=await fetch(SELLERBOOKS_SUPABASE_URL+"/functions/v1/sellerbooks-blibli-sync-orders",{method:"POST",headers:{apikey:SELLERBOOKS_SUPABASE_KEY,Authorization:"Bearer "+session.access_token,"Content-Type":"application/json"},body:JSON.stringify({connection_id:String(connection.id),store_id:String(store.id),time_from:timeFrom,time_to:timeTo})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok||!data.ok)throw new Error(data.error||sellerBooksPullOrderText("failedFetch","Blibli"));
        if(data.status==="NO_ORDERS"){sellerBooksAlert(sellerBooksPullOrderText("noOrders","Blibli",Number(data.orders_found||0)),sellerBooksPullOrderText("resultTitle","Blibli"));return;}
        if(data.status==="RAW_FILE_READY"){await sellerBooksDispatchExcelQueue({showResult:true});return;}
        throw new Error(sellerBooksPullOrderText("status","Blibli")+String(data.status||"UNKNOWN"));
    }catch(error){console.error("Tarik order Blibli gagal:",error);sellerBooksAlert(sellerBooksPullOrderText("failedOrders","Blibli")+"\n\n"+(error?.message||"Terjadi kesalahan."),sellerBooksPullOrderText("loadingTitle","Blibli"));}
}

async function syncBlibliOrdersNow(storeId){
    const key=String(storeId||"");
    if(window.__sellerBooksPullBusyStore===key && key)return;
    window.__sellerBooksPullBusyStore=key;
    try{
        return await syncBlibliOrdersNowInternal(storeId);
    }finally{
        sellerBooksSetPullOrderBusy(storeId,false,"Blibli");
        if(window.__sellerBooksPullBusyStore===key)window.__sellerBooksPullBusyStore=null;
    }
}
