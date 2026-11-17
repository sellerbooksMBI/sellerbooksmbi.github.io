/* Shopee affiliate adapter: source is Shopee Escrow API.
 * This adapter only normalizes exact Order ID results returned by the
 * sellerbooks-shopee-sync-orders Edge Function; it does not call other APIs.
 */
(function(){
  const api=window.SellerBooksAffiliate;if(!api)return;
  api.register("Shopee",{
    source:"SHOPEE_ESCROW",
    supportsLookup:true,
    normalizeBatch:function(map,ids){return api.normalizeBatch("Shopee",map,ids);}
  });
})();