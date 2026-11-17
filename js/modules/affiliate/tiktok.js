/* TikTok affiliate adapter: Finance API, exact Order ID lookup. */
(function(){
  const api=window.SellerBooksAffiliate;if(!api)return;
  api.register("TikTok",{
    source:"TIKTOK_FINANCE",
    supportsLookup:true,
    lookup:async function(orderId,context){
      if(typeof window.sellerBooksFetchTikTokAffiliate!=="function")
        return {status:"PENDING",found:false,amount:null,error:"TIKTOK_FINANCE_ADAPTER_NOT_READY"};
      const result=await window.sellerBooksFetchTikTokAffiliate(orderId,context?.orderCreateTime,context?.storeId);
      return {status:result?.status,found:result?.found===true,amount:result?.found===true?result.amount:null,
        source:"TIKTOK_FINANCE",source_field:result?.source_field||"",error:result?.error||""};
    }
  });
})();