/* Tokopedia affiliate adapter.
 * Isolated adapter is registered, but no verified seller-side per-order
 * affiliate fee endpoint/credential mapping is wired in this SellerBooks repo.
 * Never convert a missing field/API into Rp0.
 */
(function(){
  const api=window.SellerBooksAffiliate;
  if(!api)return;
  api.register("Tokopedia",{
    source:"TOKOPEDIA_AFFILIATE",
    supportsLookup:false,
    lookup:async function(orderId){
      return {order_id:orderId,status:"PENDING",found:false,amount:null,
        source:"TOKOPEDIA_AFFILIATE",error:"TOKOPEDIA_AFFILIATE_SOURCE_NOT_CONFIGURED"};
    }
  });
})();