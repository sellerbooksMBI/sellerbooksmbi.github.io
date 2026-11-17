/* SellerBooks Affiliate Adapter Registry.
 * Marketplace API acquisition stays isolated in each adapter.
 * Shared contract: {order_id, found, amount, status, source, source_field, error}.
 * Missing data is PENDING. Rp0 is confirmed only when the source explicitly
 * returns a numeric zero for the exact Order ID.
 */
(function(){
  const key=v=>String(v||"").trim().toLowerCase().replace(/[ _-]+/g,"");
  const adapters=window.SellerBooksAffiliateAdapters=window.SellerBooksAffiliateAdapters||{};
  function normalize(orderId,raw,source){
    const id=String(orderId||"").trim();
    if(!id)return {order_id:"",found:false,amount:null,status:"PENDING",source:source||"",error:"ORDER_ID_REQUIRED"};
    if(raw&&typeof raw==="object"&&String(raw.status||"").toUpperCase()==="CONFIRMED"&&
       raw.amount!==undefined&&raw.amount!==null&&String(raw.amount).trim()!==""&&Number.isFinite(Number(raw.amount))){
      return {order_id:id,found:true,amount:Math.abs(Number(raw.amount)),status:"CONFIRMED",
        source:String(raw.source||source||""),source_field:String(raw.source_field||""),source_mode:String(raw.source_mode||""),
        diagnostic:raw.diagnostic||{},lookup_diagnostic:raw.lookup_diagnostic||{},error:""};
    }
    return {order_id:id,found:false,amount:null,status:"PENDING",source:source||"",
      source_field:String(raw?.source_field||""),source_mode:String(raw?.source_mode||""),
      diagnostic:raw?.diagnostic||{},lookup_diagnostic:raw?.lookup_diagnostic||{},
      error:String(raw?.error||"AFFILIATE_DATA_NOT_CONFIRMED")};
  }
  window.SellerBooksAffiliate={
    register:function(name,adapter){
      const id=key(name);
      if(!id||!adapter||typeof adapter!=="object")throw new Error("Invalid affiliate adapter registration");
      adapters[id]=Object.assign({marketplace:id,source:"",supportsLookup:false},adapter);
      return adapters[id];
    },
    get:function(name){return adapters[key(name)]||null;},
    normalize:normalize,
    normalizeBatch:function(name,map,orderIds){
      const adapter=adapters[key(name)],source=adapter?.source||String(name||"").toUpperCase();
      const raw=map&&typeof map==="object"?map:{};
      const ids=Array.from(new Set((Array.isArray(orderIds)?orderIds:Object.keys(raw)).map(x=>String(x||"").trim()).filter(Boolean)));
      const out={};
      ids.forEach(id=>{out[id]=normalize(id,Object.prototype.hasOwnProperty.call(raw,id)?raw[id]:null,source);});
      return out;
    },
    lookup:function(name,orderId,context){
      const adapter=adapters[key(name)];
      if(!adapter||typeof adapter.lookup!=="function")return Promise.resolve(normalize(orderId,null,String(name||"").toUpperCase()));
      return Promise.resolve(adapter.lookup(String(orderId||"").trim(),context||{}))
        .then(result=>normalize(orderId,result,adapter.source||String(name||"").toUpperCase()))
        .catch(error=>normalize(orderId,{error:String(error?.message||error)},adapter.source||String(name||"").toUpperCase()));
    }
  };
})();