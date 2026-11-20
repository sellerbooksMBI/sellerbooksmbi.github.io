import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const S=Deno.env.get("SUPABASE_URL")||"",B="https://open-api.tiktokglobalshop.com",K=Deno.env.get("TIKTOK_SHOP_APP_KEY")||"";
const out=(x:any,n=200)=>new Response(JSON.stringify(x),{status:n,headers:{...CORS,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const h=r.headers.get("Authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():""};
const hex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
async function mac(k:string,s:string){const x=await crypto.subtle.importKey("raw",new TextEncoder().encode(k),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(new Uint8Array(await crypto.subtle.sign("HMAC",x,new TextEncoder().encode(s))))}
async function api(c:any,path:string,body:any){const secret=Deno.env.get("TIKTOK_SHOP_APP_SECRET");if(!secret)throw Error("TIKTOK_SHOP_APP_SECRET_MISSING");const q=(body&&body.__query)||{};if(body&&body.__query)delete body.__query;const b=JSON.stringify(body),p:any={app_key:c.app_key||K,timestamp:String(Math.floor(Date.now()/1000)),shop_cipher:c.shop_cipher,...q};let s=path;for(const k of Object.keys(p).sort())s+=k+p[k];s+=b;p.sign=await mac(secret,secret+s+secret);const u=new URL((c.api_base_url||B)+path);Object.entries(p).forEach(([k,v])=>u.searchParams.set(k,String(v)));const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json","x-tts-access-token":c.access_token},body:b}),raw=await r.text();let d:any;try{d=JSON.parse(raw)}catch{d={raw}}if(!r.ok||Number(d?.code??-1)!==0)throw Error("TIKTOK_API_ERROR:"+String(d?.message||r.status));return d}
const auth=async(t:string,k:string)=>{const r=await fetch(S+"/auth/v1/user",{headers:{apikey:k,Authorization:"Bearer "+t}});return r.ok?r.json():null};
const rest=async(k:string,p:string,i:RequestInit={})=>{const h=new Headers(i.headers);h.set("apikey",k);h.set("Authorization","Bearer "+k);h.set("Content-Type","application/json");return fetch(S+"/rest/v1/"+p,{...i,headers:h})};
const txt=async(r:Response)=>{try{return await r.text()}catch{return ""}};
const oid=(o:any)=>String(o?.order_id??o?.id??"").trim();
const arr=(v:any)=>{
  if(Array.isArray(v)) return v;
  if(!v||typeof v!=="object") return [];
  return v.orders||v.order_list||v.line_items||v.item_list||v.items||v.sku_list||v.skus||[];
};
const oneOrArray=(v:any)=>Array.isArray(v)?v:(v&&typeof v==="object"?[v]:[]);
const extractOrders=(d:any)=>{
  const data=d?.data??d;
  const direct=arr(data);
  if(direct.length) return direct;
  if(data?.order) return oneOrArray(data.order);
  if(data?.order_detail) return oneOrArray(data.order_detail);
  if(data?.order_info) return oneOrArray(data.order_info);
  if(data?.id||data?.order_id) return [data];
  return [];
};
const extractItems=(order:any)=>{
  const candidates=[
    order?.line_items,order?.item_list,order?.items,order?.skus,
    order?.sku_list,order?.order_items,order?.order_item_list,
    order?.order_line_items,order?.order_line_list
  ];
  for(const v of candidates){ const a=arr(v); if(a.length) return a; }
  return [];
};
const normalizeItemsForExcel=(items:any[])=>{
  const groups=new Map<string,any>();
  for(const item of items){
    const skuIdKey=String(item?.sku_id??item?.sku_id_str??item?.sku?.id??item?.model_id??"").trim();
    const sellerSkuKey=String(item?.seller_sku??item?.sku?.seller_sku??item?.sku??"").trim();
    const productIdKey=String(item?.product_id??item?.product?.id??"").trim();
    const originalKey=String(item?.original_price??item?.sku_original_price??"").trim();
    const saleKey=String(item?.sale_price??item?.sku_sale_price??"").trim();
    const platformKey=String(item?.platform_discount??item?.sku_platform_discount??"").trim();
    const sellerKey=String(item?.seller_discount??item?.sku_seller_discount??"").trim();
    const key=[skuIdKey,sellerSkuKey,productIdKey,originalKey,saleKey,platformKey,sellerKey].join("|");
    const explicitQty=Number(item?.quantity??item?.sku_quantity??item?.item_quantity??item?.qty??item?.quantity_purchased??item?.order_item?.quantity??item?.sku?.quantity);
    const addQty=Number.isFinite(explicitQty)&&explicitQty>0?explicitQty:1;
    const previous=groups.get(key);
    if(previous){
      previous.__sellerbooks_quantity=(Number(previous.__sellerbooks_quantity)||0)+addQty;
    }else{
      groups.set(key,{...item,__sellerbooks_quantity:addQty});
    }
  }
  return [...groups.values()].map(item=>{
    const q=Number(item.__sellerbooks_quantity)||1;
    const copy={...item};
    copy.quantity=q;
    delete copy.__sellerbooks_quantity;
    return copy;
  });
};
const productId=(i:any)=>String(i?.product_id??i?.product_id_str??i?.product?.id??i?.product?.product_id??"").trim();
const skuId=(i:any)=>String(i?.sku_id??i?.sku_id_str??i?.sku?.id??i?.model_id??i?.model?.id??"").trim();
const sellerSku=(i:any)=>String(i?.seller_sku??i?.sku??i?.item_sku??i?.model_sku??"").trim();
const sku=(i:any)=>sellerSku(i);
const iso=(v:any)=>{const n=Number(v);if(Number.isFinite(n)&&n>100000000)return new Date(n*1000).toISOString();const d=new Date(String(v||""));return Number.isNaN(d.getTime())?new Date().toISOString():d.toISOString()};
async function financeGet(c:any,path:string,query:Record<string,string>={}){
  const secret=Deno.env.get("TIKTOK_SHOP_APP_SECRET");
  if(!secret) throw Error("TIKTOK_SHOP_APP_SECRET_MISSING");
  const params:Record<string,string>={...query,app_key:c.app_key||K,timestamp:String(Math.floor(Date.now()/1000)),shop_cipher:c.shop_cipher};
  let canonical=path;
  for(const key of Object.keys(params).sort()) canonical+=key+params[key];
  params.sign=await mac(secret,secret+canonical+secret);
  const apiBase=String(c.api_base_url||B);
  const url=new URL((apiBase.endsWith("/")?apiBase.slice(0,-1):apiBase)+path);
  Object.entries(params).forEach(([key,value])=>url.searchParams.set(key,value));
  const response=await fetch(url,{method:"GET",headers:{"content-type":"application/json","x-tts-access-token":c.access_token}});
  const raw=await txt(response); let payload:any;
  try{payload=JSON.parse(raw)}catch{payload={}};
  if(!response.ok||Number(payload?.code??-1)!==0) throw Error("TIKTOK_FINANCE_PRICE_API_ERROR:"+String(payload?.message||response.status));
  return payload?.data||{};
}
const financeSellerSubtotal=(row:any):number|null=>{
  const rb=row?.revenue_breakdown||{};
  const direct=row?.after_seller_discounts_subtotal_amount??rb?.after_seller_discounts_subtotal_amount;
  if(direct!==undefined&&direct!==null&&String(direct).trim()!==""){
    const n=Number(direct); return Number.isFinite(n)?n:null;
  }
  const subtotal=Number(rb?.subtotal_before_discount_amount);
  const sellerDiscount=Number(rb?.seller_discount_amount);
  if(Number.isFinite(subtotal)&&Number.isFinite(sellerDiscount)) return subtotal+sellerDiscount;
  return null;
};
const itemFinanceWeight=(item:any):number=>{
  const qty=Math.max(1,Number(item?.quantity??item?.sku_quantity??item?.item_quantity??item?.qty??1)||1);
  const original=Number(item?.sku_original_price??item?.original_price??item?.unit_original_price??0)||0;
  const sellerDiscount=Number(item?.sku_seller_discount??item?.seller_discount??item?.unit_seller_discount??0)||0;
  return Math.max(0,original*qty-Math.abs(sellerDiscount)*qty);
};
const financeAmount=(value:any):number=>{
  if(value===null||value===undefined||value==="")return 0;
  const n=Number(String(value).replace(/,/g,"").trim());
  return Number.isFinite(n)?n:0;
};
const financePath=(root:any,path:string):any=>path.split(".").reduce((v:any,k)=>v&&typeof v==="object"?v[k]:undefined,root);
const financeSum=(rows:any[],path:string)=>{
  const values=rows.map(row=>financePath(row,path)).filter(v=>v!==undefined&&v!==null&&v!=="");
  return {found:values.length>0,amount:values.reduce((sum,v)=>sum+financeAmount(v),0)};
};
const extractFinanceAffiliate=(data:any,mode:"UNSETTLED_ESTIMATE"|"SETTLED_FINAL")=>{
  const orderRows=Array.isArray(data?.transactions)?data.transactions:
    (mode==="UNSETTLED_ESTIMATE"&&data?.order_id?[data]:[]);
  const skuRows=Array.isArray(data?.sku_transactions)?data.sku_transactions:[];
  const pick=(path:string)=>{
    const skuValue=financeSum(skuRows,path),orderValue=financeSum(orderRows,path);
    if(skuValue.found&&skuValue.amount!==0)return skuValue;
    if(orderValue.found&&orderValue.amount!==0)return orderValue;
    return skuValue.found?skuValue:orderValue;
  };
  const ads=pick("fee_tax_breakdown.fee.affiliate_ads_commission_amount");
  const primary=pick("fee_tax_breakdown.fee.affiliate_commission_amount");
  const selected=ads.found&&ads.amount!==0?{...ads,field:"fee_tax_breakdown.fee.affiliate_ads_commission_amount"}:
    primary.found&&primary.amount!==0?{...primary,field:"fee_tax_breakdown.fee.affiliate_commission_amount"}:
    ads.found?{...ads,field:"fee_tax_breakdown.fee.affiliate_ads_commission_amount"}:
    {...primary,field:"fee_tax_breakdown.fee.affiliate_commission_amount"};
  return selected.found?{found:true,amount:Math.abs(selected.amount),source_field:selected.field,source_mode:mode}:null;
};
async function getFinanceSubtotalsForOrder(c:any,orderId:string,items:any[],affiliateByOrderId:Record<string,any>){
  const data=await financeGet(c,"/finance/202501/orders/"+encodeURIComponent(orderId)+"/statement_transactions");
  const affiliate=extractFinanceAffiliate(data,"SETTLED_FINAL");
  if(affiliate)affiliateByOrderId[String(c.store_id)+"::"+orderId]=affiliate;
  const skuRows=Array.isArray(data?.sku_transactions)?data.sku_transactions:[];
  if(skuRows.length){
    const bySku=new Map<string,number>();
    for(const row of skuRows){
      const id=String(row?.sku_id||"").trim();
      const amount=financeSellerSubtotal(row);
      if(!id||amount===null) continue;
      bySku.set(id,(bySku.get(id)||0)+amount);
    }
    const mapped=items.map(item=>bySku.get(skuId(item))??null);
    if(mapped.every(value=>value!==null)) return mapped as number[];
    if(items.length===1&&skuRows.length===1){
      const amount=financeSellerSubtotal(skuRows[0]);
      if(amount!==null)return [amount];
    }
    throw Error("TIKTOK_FINANCE_SKU_SUBTOTAL_INCOMPLETE:"+orderId);
  }
  return null;
}
async function detail(c:any,id:string){const secret=Deno.env.get("TIKTOK_SHOP_APP_SECRET")!;const path="/order/202309/orders";const p:any={app_key:c.app_key||K,timestamp:String(Math.floor(Date.now()/1000)),shop_cipher:c.shop_cipher,ids:id};let s=path;for(const k of Object.keys(p).sort())s+=k+p[k];const signParams={app_key:p.app_key,timestamp:p.timestamp,shop_cipher:p.shop_cipher,ids:p.ids};let sig=path;for(const k of Object.keys(signParams).sort())sig+=k+signParams[k];sig+="";p.sign=await mac(secret,secret+sig+secret);const u=new URL((c.api_base_url||B)+path);Object.entries(p).forEach(([k,v])=>u.searchParams.set(k,String(v)));const r=await fetch(u,{method:"GET",headers:{"content-type":"application/json","x-tts-access-token":c.access_token}});const raw=await txt(r);let d:any;try{d=JSON.parse(raw)}catch{d={}}if(!r.ok||Number(d?.code??-1)!==0)throw Error("TIKTOK_DETAIL_ERROR:"+String(d?.message||r.status));
  return d}

const TIKTOK_EXCEL_HEADERS=["Order ID","Order Status","Order Substatus","Cancelation/Return Type","Normal or Pre-order","SKU ID","Seller SKU","Product Name","Variation","Quantity","Sku Quantity of return","SKU Unit Original Price","SKU Subtotal Before Discount","SKU Platform Discount","SKU Seller Discount","SKU Subtotal After Discount","Shipping Fee After Discount","Original Shipping Fee","Shipping Fee Seller Discount","Shipping Fee Platform Discount","Distance Shipping Fee","Distance Fee","Order Refund Amount","Payment platform discount","Buyer Service Fee","Handling Fee","Shipping Insurance","Item Insurance","Order Amount","Created Time","Paid Time","RTS Time","Shipped Time","Delivered Time","Cancelled Time","Cancel By","Cancel Reason","Fulfillment Type","Warehouse Name","Tracking ID","Delivery Option","Shipping Provider Name","Buyer Message","Buyer Username","Recipient","Phone #","Zipcode","Country","Province","Regency and City","Districts","Villages","Detail Address","Additional address information","Payment Method","Weight(kg)","Product Category","Package ID","Purchase Channel","Seller Note","Checked Status","Checked Marked by","Tokopedia Invoice Number","Order Channel","Creator Handle","Finance Subtotal After Seller Discount"];

const rawText=(...values:any[])=>{
  for(const v of values){
    if(v!==undefined&&v!==null&&String(v).trim()!=="") return String(v);
  }
  return "";
};

const rawNumber=(...values:any[])=>{
  for(const v of values){
    if(v!==undefined&&v!==null&&String(v).trim()!==""){
      const n=Number(v);
      return Number.isFinite(n)?n:v;
    }
  }
  return "";
};

const rawTime=(...values:any[])=>{
  for(const v of values){
    if(v===undefined||v===null||String(v).trim()==="") continue;
    const n=Number(v);
    if(Number.isFinite(n)&&n>100000000){
      const d=new Date(n*1000);
      if(!Number.isNaN(d.getTime())){
        const pad=(x:number)=>String(x).padStart(2,"0");
        return pad(d.getUTCDate())+"/"+pad(d.getUTCMonth()+1)+"/"+d.getUTCFullYear()+" "+pad(d.getUTCHours())+":"+pad(d.getUTCMinutes())+":"+pad(d.getUTCSeconds());
      }
    }
    return String(v);
  }
  return "";
};

const firstPackage=(order:any)=>{
  const p=Array.isArray(order?.packages)?order.packages[0]:null;
  return rawText(p?.id,p?.package_id);
};

function makeTikTokExcelRow(order:any,item:any,financeSubtotal:number){
  const row=new Array(TIKTOK_EXCEL_HEADERS.length).fill("");
  const num=(...values:any[])=>{
    for(const v of values){
      if(v===undefined||v===null||String(v).trim()==="") continue;
      const n=Number(v);
      if(Number.isFinite(n)) return n;
    }
    return null;
  };
  const qty=Math.max(1,Number(num(
    item?.quantity,item?.sku_quantity,item?.item_quantity,item?.qty,item?.quantity_purchased,
    item?.order_item?.quantity,item?.order_item?.qty,
    item?.sku?.quantity,item?.sku?.qty,
    item?.model?.quantity,item?.model?.qty,
    item?.sku_info?.quantity,item?.sku_info?.qty
  )||1));
  const unitOriginal=num(
    item?.sku_original_price,item?.original_price,item?.unit_original_price,
    item?.sku?.sku_original_price,item?.sku?.original_price,item?.sku?.unit_original_price,
    item?.model?.original_price,item?.model?.sku_original_price
  );
  const unitSale=num(
    item?.sku_sale_price,item?.sale_price,item?.unit_sale_price,
    item?.sku?.sku_sale_price,item?.sku?.sale_price,item?.sku?.unit_sale_price,
    item?.model?.sale_price,item?.model?.sku_sale_price
  );
  const unitPlatformDiscount=num(
    item?.sku_platform_discount,item?.platform_discount,item?.unit_platform_discount,
    item?.sku?.sku_platform_discount,item?.sku?.platform_discount,item?.sku?.unit_platform_discount,
    item?.model?.platform_discount,item?.model?.sku_platform_discount
  )??0;
  const unitSellerDiscount=num(
    item?.sku_seller_discount,item?.seller_discount,item?.unit_seller_discount,
    item?.sku?.sku_seller_discount,item?.sku?.seller_discount,item?.sku?.unit_seller_discount,
    item?.model?.seller_discount,item?.model?.sku_seller_discount
  )??0;
  const subtotalBefore=unitOriginal===null?num(item?.sku_subtotal_before_discount,item?.subtotal_before_discount,item?.sku_list_price,item?.sku?.list_price,item?.sku?.sku_list_price):unitOriginal*qty;
  const platformDiscountTotal=unitPlatformDiscount*qty;
  const sellerDiscountTotal=unitSellerDiscount*qty;
  const subtotalAfter=unitSale!==null?unitSale*qty:(subtotalBefore===null?num(item?.sku_subtotal_after_discount,item?.subtotal_after_discount,item?.sku?.subtotal_after_discount):subtotalBefore-platformDiscountTotal-sellerDiscountTotal);
  row[0]=rawText(order?.id,order?.order_id); row[1]=rawText(order?.order_status,order?.status); row[2]=rawText(order?.order_substatus); row[3]=rawText(order?.cancelation_return_type,order?.cancellation_return_type); row[4]=rawText(order?.normal_or_pre_order,order?.order_type);
  row[5]=rawText(item?.sku_id,item?.sku_id_str,item?.sku?.id,item?.sku?.sku_id); row[6]=rawText(item?.seller_sku,item?.sku?.seller_sku); row[7]=rawText(item?.product_name,item?.sku?.product_name); row[8]=rawText(item?.sku_name,item?.variation,item?.model_name,item?.sku?.sku_name,item?.sku?.name);
  row[9]=qty; row[10]=rawNumber(item?.sku_quantity_of_return,item?.returned_quantity,item?.return_quantity); row[11]=unitOriginal===null?"":unitOriginal; row[12]=subtotalBefore===null?"":subtotalBefore; row[13]=platformDiscountTotal; row[14]=sellerDiscountTotal; row[15]=subtotalAfter===null?"":subtotalAfter;
  row[16]=rawNumber(item?.shipping_fee_after_discount,order?.payment?.shipping_fee); row[17]=rawNumber(item?.original_shipping_fee,order?.payment?.original_shipping_fee); row[18]=rawNumber(item?.shipping_fee_seller_discount,order?.payment?.shipping_fee_seller_discount); row[19]=rawNumber(item?.shipping_fee_platform_discount,order?.payment?.shipping_fee_platform_discount); row[20]=rawNumber(item?.distance_shipping_fee,order?.payment?.distance_shipping_fee); row[21]=rawNumber(item?.distance_fee,order?.payment?.distance_fee); row[22]=rawNumber(item?.order_refund_amount,order?.order_refund_amount); row[23]=rawNumber(item?.payment_platform_discount,order?.payment?.platform_discount); row[24]=rawNumber(item?.buyer_service_fee,order?.payment?.buyer_service_fee); row[25]=rawNumber(item?.handling_fee,order?.payment?.handling_fee); row[26]=rawNumber(item?.shipping_insurance,order?.payment?.shipping_insurance); row[27]=rawNumber(item?.item_insurance,order?.payment?.item_insurance); row[28]=rawNumber(item?.order_amount,order?.payment?.total_amount,order?.order_amount);
  row[65]=financeSubtotal;
  row[29]=rawTime(item?.create_time,item?.created_time,order?.create_time,order?.created_time); row[30]=rawTime(item?.paid_time,order?.paid_time); row[31]=rawTime(item?.rts_time,order?.rts_time); row[32]=rawTime(item?.shipped_time,order?.shipped_time); row[33]=rawTime(item?.delivered_time,order?.delivered_time); row[34]=rawTime(item?.cancelled_time,item?.canceled_time,order?.cancelled_time,order?.canceled_time); row[35]=rawText(item?.cancel_by,item?.cancel_user,order?.cancel_by,order?.cancellation_initiator); row[36]=rawText(item?.cancel_reason,item?.sku_cancel_reason,order?.cancel_reason); row[37]=rawText(item?.fulfillment_type,order?.fulfillment_type); row[38]=rawText(item?.warehouse_name,order?.warehouse_name); row[39]=rawText(item?.tracking_id,item?.tracking_number,order?.tracking_number); row[40]=rawText(item?.delivery_option_type,order?.delivery_option_type); row[41]=rawText(item?.shipping_provider_name,order?.shipping_provider_name,order?.shipping_provider); row[42]=rawText(item?.buyer_message,order?.buyer_message); row[43]=rawText(item?.buyer_username,order?.buyer_username); row[44]=rawText(item?.recipient,order?.recipient); row[45]=rawText(item?.phone,item?.phone_number,order?.recipient_address?.phone_number); row[46]=rawText(item?.zipcode,order?.recipient_address?.zipcode); row[47]=rawText(item?.country,order?.recipient_address?.country); row[48]=rawText(item?.province,order?.recipient_address?.province); row[49]=rawText(item?.regency_and_city,order?.recipient_address?.city); row[50]=rawText(item?.district,order?.recipient_address?.district); row[51]=rawText(item?.villages,order?.recipient_address?.town); row[52]=rawText(item?.detail_address,order?.recipient_address?.full_address); row[53]=rawText(item?.additional_address_information,order?.recipient_address?.address_detail); row[54]=rawText(item?.payment_method,order?.payment_method); row[55]=rawNumber(item?.weight,order?.weight); row[56]=rawText(item?.product_category); row[57]=rawText(item?.package_id,item?.package_id_str,order?.package_id,firstPackage(order)); row[58]=rawText(item?.purchase_channel,order?.purchase_channel); row[59]=rawText(item?.seller_note,order?.seller_note); row[60]=rawText(item?.checked_status,order?.checked_status); row[61]=rawText(item?.checked_marked_by,order?.checked_marked_by); row[62]=rawText(item?.tokopedia_invoice_number,order?.tokopedia_invoice_number); row[63]=rawText(item?.order_channel,order?.order_channel); row[64]=rawText(item?.creator_handle,order?.creator_handle);
  return row;
}

async function enqueueTikTokExcelPayload(c:any,rows:any[],foundCount:number,sk:string){
  const fileName="AUTO-SYNC-TIKTOK-"+new Date().toISOString()+".xlsx";
  const r=await rest(sk,"sellerbooks_api_import_queue",{
    method:"POST",
    headers:{"Prefer":"return=representation"},
    body:JSON.stringify({
      owner_user_id:String(c.owner_user_id),
      connection_id:String(c.id),
      store_id:String(c.store_id),
      marketplace:"TikTok Shop",
      file_name:fileName,
      file_type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers:TIKTOK_EXCEL_HEADERS,
      rows,
      status:"PENDING"
    })
  });
  if(!r.ok){
    throw Error("API_IMPORT_QUEUE_ERROR:"+r.status+":"+String(await txt(r)).slice(0,500));
  }
  const saved=await r.json();
  const item=Array.isArray(saved)?saved[0]:saved;
  return {queue_id:item?.id||null,file_name:fileName,rows_count:rows.length,orders_found:foundCount};
}


async function refreshTikTokIfNeeded(z:any,connection:any,base:string,sk:string){
  const now=Math.floor(Date.now()/1000),expiry=Number(z.access_token_expire_in||0);
  if(!expiry||now<expiry-600)return z;
  if(!z.refresh_token)throw Error("TIKTOK_REFRESH_TOKEN_MISSING");
  const lock=await rest(sk,"rpc/sellerbooks_acquire_marketplace_token_lock",{method:"POST",body:JSON.stringify({p_connection_id:connection.id,p_lease_seconds:90})});
  if(!lock.ok)throw Error("TIKTOK_TOKEN_LOCK_ERROR");
  if(!await lock.json().catch(()=>false))throw Error("TIKTOK_TOKEN_REFRESH_IN_PROGRESS");
  try{
    const appKey=String(z.app_key||K||""),appSecret=Deno.env.get("TIKTOK_SHOP_APP_SECRET")||"";
    if(!appKey||!appSecret)throw Error("TIKTOK_APP_CREDENTIALS_MISSING");
    const url=new URL("https://auth.tiktok-shops.com/api/v2/token/refresh");
    for(const [key,value] of Object.entries({app_key:appKey,app_secret:appSecret,refresh_token:z.refresh_token,grant_type:"refresh_token"}))url.searchParams.set(key,String(value));
    const response=await fetch(url,{method:"GET"});
    const raw=await txt(response);let body:any;try{body=JSON.parse(raw)}catch{body={}};
    const data=body?.data??body;
    if(!response.ok||Number(body?.code??0)!==0||!data?.access_token||!data?.refresh_token)throw Error("TIKTOK_TOKEN_REFRESH_FAILED:"+String(body?.message||body?.error||response.status));
    const updated={...z,access_token:data.access_token,refresh_token:data.refresh_token,
      access_token_expire_in:Number(data.access_token_expire_in||data.access_token_expire_at||data.expire_in||0)||z.access_token_expire_in,
      refresh_token_expire_in:Number(data.refresh_token_expire_in||data.refresh_token_expire_at||0)||z.refresh_token_expire_in,
      token_received_at:new Date().toISOString()};
    const save=await rest(sk,"rpc/sellerbooks_update_marketplace_vault_credential",{method:"POST",body:JSON.stringify({p_connection_id:connection.id,p_marketplace:"TikTok Shop",p_credential:updated})});
    if(!save.ok)throw Error("TIKTOK_TOKEN_SAVE_FAILED:"+String(await txt(save)).slice(0,200));
    console.info(JSON.stringify({service:"sellerbooks-tiktok-sync-orders",event:"token_refreshed",connection_id:connection.id}));
    return updated;
  }finally{await rest(sk,"rpc/sellerbooks_release_marketplace_token_lock",{method:"POST",body:JSON.stringify({p_connection_id:connection.id})});}
}

async function run(c:any,from:number,to:number,token:string,pk:string,sk:string){
  if(!c.vault_secret_id) throw Error("TIKTOK_CREDENTIAL_VAULT_ID_MISSING");
  const vr=await rest(sk,"rpc/sellerbooks_tiktok_read_credential",{method:"POST",body:JSON.stringify({p_connection_id:c.id})});
  if(!vr.ok) throw Error("TIKTOK_CREDENTIAL_STORE_READ_ERROR:"+vr.status+":"+String(await vr.text()).slice(0,300));
  let z:any=null; try{z=await vr.json()}catch{throw Error("TIKTOK_CREDENTIAL_INVALID_JSON")}
  if(!z||typeof z!=="object") throw Error("TIKTOK_CREDENTIAL_INVALID_JSON");
  if(!z.access_token||!z.shop_cipher) throw Error("TIKTOK_CREDENTIAL_INCOMPLETE");
  z.app_key=z.app_key||K; z.api_base_url=(z.api_base_url||B).replace(/\/$/,"");
   z=await refreshTikTokIfNeeded(z,c,S,sk);

  /*
   * SELLERBOOKS TIKTOK SYNC CONTRACT
   * API adapter hanya mengambil order yang berada pada kelompok Seller Center
   * "Perlu dikirim":
   *   - AWAITING_SHIPMENT   = Menunggu pengiriman
   *   - AWAITING_COLLECTION = Menunggu pengambilan
   *
   * Jangan menarik Dikirim / Selesai / Dalam proses / Dibatalkan / Pengantaran
   * gagal sebagai histori. Import Penjualan tetap menjadi satu-satunya mesin
   * yang menentukan transaksi baru vs duplicate berdasarkan Order ID + SKU.
   *
   * Karena TikTok Order List menerima satu order_status per request, dua status
   * tersebut dipanggil terpisah lalu digabung dan dideduplikasi berdasarkan Order ID.
   * Tidak memakai create/update time window di sini agar seluruh "Perlu dikirim"
   * tetap tertangkap, termasuk order lama yang masih menunggu pengiriman/pengambilan.
   */
  const fetchNeedToShip=async(orderStatus:string)=>{
    const result:any[]=[];
    let page_token="";
    const seenPageTokens=new Set<string>();
    /* Fetch every page, not just the first 100 orders.
       No date filter: status is the only order-selection criterion. */
    /* Continue until TikTok has no next_page_token.
       There is no fixed order/page cap; the repeated-token guard only
       prevents an accidental infinite pagination loop. */
    while(true){
      const body:any={order_status:orderStatus};
      const d=await api(z,"/order/202309/orders/search",{...body,__query:{page_size:100,sort_field:"create_time",sort_order:"ASC",...(page_token?{page_token}:{})}});
      const pageData=d?.data??{};
      const pageOrders=arr(pageData);
      result.push(...pageOrders);
      const nextPageToken=String(pageData?.next_page_token||"");
      if(!nextPageToken) break;
      if(seenPageTokens.has(nextPageToken)){
        throw Error("TIKTOK_ORDER_PAGE_TOKEN_REPEATED:"+orderStatus);
      }
      seenPageTokens.add(nextPageToken);
      page_token=nextPageToken;
    }
    return result;
  };

  /* EXPORT NORMALIZATION ONLY: map TikTok item-level SKU values to the same line-level structure used by the TikTok Excel export. Import Penjualan remains the business-processing engine. */
  const foundRaw=[
    ...await fetchNeedToShip("AWAITING_SHIPMENT"),
    ...await fetchNeedToShip("AWAITING_COLLECTION")
  ];
  const foundById=new Map<string,any>();
  for(const order of foundRaw){
    const id=oid(order);
    if(!id) continue;
    const previous=foundById.get(id);
    if(!previous){ foundById.set(id,order); continue; }
    const prevUpdate=Number(previous?.update_time||0);
    const nextUpdate=Number(order?.update_time||0);
    if(nextUpdate>=prevUpdate) foundById.set(id,order);
  }
  const found=[...foundById.values()];

  /*
   * Creator usernames come from TikTok Seller Affiliate Orders, not Finance.
   * This lookup is metadata-only: it never supplies or changes commission amounts.
   * The API permission is optional; if TikTok has not approved the scope yet,
   * order sync continues normally and the report keeps the name blank.
   */
  const creatorHandleByOrderSku=new Map<string,string>();
  const creatorHandleByOrder=new Map<string,string>();
  let creatorLookupStatus="NOT_AVAILABLE";
  try{
    const timestamps=found.map((order:any)=>{
      const raw=Number(order?.create_time??order?.created_time??order?.order_create_time??0);
      return Math.floor(raw>1000000000000?raw/1000:raw);
    }).filter((value:number)=>Number.isFinite(value)&&value>0);
    if(timestamps.length){
      const rangeStart=Math.min(...timestamps);
      const rangeEnd=Math.max(...timestamps)+1;
      const maxWindow=90*86400;
      for(let windowStart=rangeStart;windowStart<rangeEnd;windowStart+=maxWindow){
        const windowEnd=Math.min(rangeEnd,windowStart+maxWindow);
        let pageToken="";
        const seenCreatorPageTokens=new Set<string>();
        while(true){
          const response=await api(z,"/affiliate_seller/202410/orders/search",{
            create_time_ge:windowStart,
            create_time_lt:windowEnd,
            __query:{page_size:100,...(pageToken?{page_token:pageToken}:{})}
          });
          const data=response?.data??{};
          const affiliateOrders=Array.isArray(data?.orders)?data.orders:[];
          for(const affiliateOrder of affiliateOrders){
            const affiliateOrderId=String(affiliateOrder?.id||"").trim();
            if(!affiliateOrderId)continue;
            const skus=Array.isArray(affiliateOrder?.skus)?affiliateOrder.skus:[];
            const orderHandles=new Set<string>();
            for(const affiliateSku of skus){
              const handle=String(affiliateSku?.creator_username||"").trim();
              if(!handle)continue;
              orderHandles.add(handle);
              const skuId=String(affiliateSku?.sku_id||"").trim();
              if(skuId)creatorHandleByOrderSku.set(affiliateOrderId+"::"+skuId,handle);
            }
            if(orderHandles.size)creatorHandleByOrder.set(affiliateOrderId,[...orderHandles].join(", "));
          }
          const nextToken=String(data?.next_page_token||"");
          if(!nextToken)break;
          if(seenCreatorPageTokens.has(nextToken))throw Error("TIKTOK_AFFILIATE_CREATOR_PAGE_TOKEN_REPEATED");
          seenCreatorPageTokens.add(nextToken);
          pageToken=nextToken;
        }
      }
      creatorLookupStatus="COMPLETED";
    }
  }catch(error){
    creatorLookupStatus="UNAVAILABLE";
    console.warn("TikTok creator username lookup unavailable; financial order sync continues:",String(error instanceof Error?error.message:error));
  }

  const rows:any[]=[];
  const affiliateByOrderId:Record<string,any>={};
  const financePendingOrders:Array<{order_id:string;reason:string;order_create_time:number}> = [];
  const unsettledFinanceByOrder=new Map<string,any>();
  let unsettledFinancePageToken="";
  let unsettledFinanceComplete=false;
  const seenUnsettledFinancePageTokens=new Set<string>();
  async function findUnsettledFinanceOrder(targetOrderId:string,orderCreatedAt:number){
    const searchStart=Math.max(1735689600,(orderCreatedAt||Math.floor(Date.now()/1000))-90*86400);
    while(!unsettledFinanceComplete){
      const query:Record<string,string>={page_size:"100",sort_field:"order_create_time",sort_order:"DESC",search_time_ge:String(searchStart),search_time_lt:String(Math.floor(Date.now()/1000)+1)};
      if(unsettledFinancePageToken) query.page_token=unsettledFinancePageToken;
      const page=await financeGet(z,"/finance/202507/orders/unsettled",query);
      const txRows=Array.isArray(page?.transactions)?page.transactions:[];
      for(const transaction of txRows){const key=String(transaction?.order_id||"").trim();if(key) unsettledFinanceByOrder.set(key,transaction);}
      const nextToken=String(page?.next_page_token||"");
      if(!nextToken){unsettledFinanceComplete=true;unsettledFinancePageToken="";break;}
      if(seenUnsettledFinancePageTokens.has(nextToken)) throw Error("TIKTOK_UNSETTLED_FINANCE_PAGE_TOKEN_REPEATED");
      seenUnsettledFinancePageTokens.add(nextToken);
      unsettledFinancePageToken=nextToken;
      if(unsettledFinanceByOrder.has(targetOrderId)) break;
    }
    return unsettledFinanceByOrder.get(targetOrderId)||null;
  }
  async function findStatementFinanceOrder(targetOrderId:string, orderCreatedAt:number, items:any[]){
    const start=Math.max(1735689600,(orderCreatedAt||Math.floor(Date.now()/1000))-90*86400);
    let listToken="";
    const seenStatementPageTokens=new Set<string>();
    while(true){
      const query:Record<string,string>={statement_time_ge:String(start),statement_time_lt:String(Math.floor(Date.now()/1000)+1),sort_field:"statement_time",sort_order:"ASC",page_size:"100"};
      if(listToken)query.page_token=listToken;
      const list=await financeGet(z,"/finance/202309/statements",query),data=list?.data||{},statements=Array.isArray(data?.statements)?data.statements:[];
      for(const statement of statements){
        const statementId=String(statement?.id||"").trim();if(!statementId)continue;
        let detailToken="";
        const seenStatementDetailTokens=new Set<string>();
        while(true){
          const dq:Record<string,string>={sort_field:"order_create_time",sort_order:"ASC",page_size:"100"};
          if(detailToken)dq.page_token=detailToken;
          const page=await financeGet(z,"/finance/202501/statements/"+encodeURIComponent(statementId)+"/statement_transactions",dq),dd=page?.data||{},tx=Array.isArray(dd?.transactions)?dd.transactions:[];
          const matches=tx.filter((row:any)=>String(row?.order_id||row?.adjustment_order_id||"").trim()===targetOrderId);
          if(matches.length){
            const skuRows=matches.flatMap((row:any)=>Array.isArray(row?.sku_transactions)?row.sku_transactions:[]);
            if(skuRows.length){
              const bySku=new Map<string,number>();
              for(const row of skuRows){const sid=String(row?.sku_id||"").trim(),amount=financeSellerSubtotal(row);if(sid&&amount!==null)bySku.set(sid,(bySku.get(sid)||0)+amount);}
              const mapped=items.map(item=>bySku.get(skuId(item))??null);
              if(mapped.every(v=>v!==null))return mapped as number[];
              if(items.length===1){const amount=financeSellerSubtotal(skuRows[0]);if(amount!==null)return [amount];}
            }
            const amounts=matches.map((row:any)=>financeSellerSubtotal(row)).filter((v:any)=>v!==null) as number[];
            if(amounts.length){
              const total=amounts.reduce((x,y)=>x+y,0);
              if(items.length===1)return [total];
              const weights=items.map(itemFinanceWeight),weightTotal=weights.reduce((x,y)=>x+y,0);
              if(weightTotal>0){
                let allocated=0;
                return weights.map((w,i)=>{if(i===weights.length-1)return Number((total-allocated).toFixed(2));const value=Number((total*w/weightTotal).toFixed(2));allocated+=value;return value;});
              }
            }
            return null;
          }
          const nextDetailToken=String(dd?.next_page_token||"");
          if(!nextDetailToken)break;
          if(seenStatementDetailTokens.has(nextDetailToken))throw Error("TIKTOK_STATEMENT_DETAIL_PAGE_TOKEN_REPEATED:"+statementId);
          seenStatementDetailTokens.add(nextDetailToken);
          detailToken=nextDetailToken;
        }
      }
      const nextListToken=String(data?.next_page_token||"");
      if(!nextListToken)break;
      if(seenStatementPageTokens.has(nextListToken))throw Error("TIKTOK_STATEMENT_PAGE_TOKEN_REPEATED");
      seenStatementPageTokens.add(nextListToken);
      listToken=nextListToken;
    }
    return null;
  }
  for(const order of found){
    const id=oid(order); if(!id) continue;
    const rawCreated=Number(order?.create_time??order?.created_time??order?.order_create_time??0);const created=Math.floor(rawCreated>1000000000000?rawCreated/1000:rawCreated);
    const d=await detail(z,id);
    const detailOrders=extractOrders(d);
    const orders=detailOrders.length?detailOrders:[order];
    for(const detailOrder of orders){
      const items=normalizeItemsForExcel(extractItems(detailOrder));
      const financeItems=items.length?items:[detailOrder];
      let financeAmounts:number[]|null=null;
      let settledFinanceError="";
      try{financeAmounts=await getFinanceSubtotalsForOrder(z,id,financeItems,affiliateByOrderId);}
      catch(error){settledFinanceError=String(error instanceof Error?error.message:error);}
      let unsettledFinanceRow:any=null;
      if(!affiliateByOrderId[String(z.store_id)+"::"+id]){
        try{
          unsettledFinanceRow=await findUnsettledFinanceOrder(id,created);
          if(unsettledFinanceRow){
            const affiliate=extractFinanceAffiliate({order_id:id,...unsettledFinanceRow},"UNSETTLED_ESTIMATE");
            if(affiliate)affiliateByOrderId[String(z.store_id)+"::"+id]=affiliate;
          }
        }catch(affiliateReadError){
          console.warn("TikTok affiliate field unavailable during order sync:",id,String(affiliateReadError));
        }
      }
      if(!financeAmounts){
        let unsettled=unsettledFinanceRow;
        let financeLookupError="";
        if(!unsettled){
          try{unsettled=await findUnsettledFinanceOrder(id,created);}
          catch(error){financeLookupError=String(error instanceof Error?error.message:error).slice(0,160);}
        }
        if(unsettled){
          const orderTotal=financeSellerSubtotal(unsettled);
          if(orderTotal!==null){
            const weights=financeItems.map(itemFinanceWeight);
            const weightTotal=weights.reduce((sum,value)=>sum+value,0);
            if(financeItems.length===1){
              financeAmounts=[orderTotal];
            }else if(weightTotal>0){
              let allocated=0;
              financeAmounts=weights.map((weight,index)=>{
                if(index===weights.length-1)return Number((orderTotal-allocated).toFixed(2));
                const amount=Number((orderTotal*weight/weightTotal).toFixed(2));
                allocated+=amount;
                return amount;
              });
            }
          }
        }
        if(!financeAmounts){
          try{financeAmounts=await findStatementFinanceOrder(id,created,financeItems);}
          catch(error){
            financeLookupError=String(error instanceof Error?error.message:error).slice(0,160)||financeLookupError;
          }
        }
        if(!financeAmounts){
          if(!financePendingOrders.some(item=>item.order_id===id)){
            financePendingOrders.push({
              order_id:id,
              reason:financeLookupError?"FINANCE_LOOKUP_TEMPORARILY_UNAVAILABLE":"FINANCE_SUBTOTAL_NOT_READY",
              order_create_time:created
            });
          }
          console.warn("TikTok order held until Finance subtotal is available:",id,financeLookupError||settledFinanceError||"not published yet");
          continue;
        }
      }
      if(items.length){
        for(let index=0;index<items.length;index++){
          const creatorKey=id+"::"+skuId(items[index]);
          const creatorHandle=creatorHandleByOrderSku.get(creatorKey)||creatorHandleByOrder.get(id)||"";
          rows.push(makeTikTokExcelRow({...order,...detailOrder},{...items[index],creator_handle:creatorHandle},financeAmounts[index]));
        }
      }else{
        const creatorHandle=creatorHandleByOrder.get(id)||"";
        rows.push(makeTikTokExcelRow({...order,...detailOrder},{...detailOrder,creator_handle:creatorHandle},financeAmounts[0]));
      }
    }
  }
  if(!rows.length){
    if(financePendingOrders.length){
      const now=new Date().toISOString();
      const pendingIds=financePendingOrders.map(item=>item.order_id);
      await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(c.id),{
        method:"PATCH",
        body:JSON.stringify({
          last_sync_at:now,
          last_error:"TIKTOK_FINANCE_PENDING:"+pendingIds.join(","),
          updated_at:now
        })
      });
      return {
        connection_id:c.id,store_id:c.store_id,status:"FINANCE_PENDING",
        orders_found:found.length,rows_found:0,
        finance_pending_orders:financePendingOrders,
        finance_pending_count:financePendingOrders.length
      };
    }
    return {connection_id:c.id,store_id:c.store_id,status:"NO_ORDERS",orders_found:found.length,rows_found:0};
  }
  const pendingFinanceIds=new Set(financePendingOrders.map(item=>item.order_id));
  const financeOrders=found.map((order:any)=>{
    const orderId=oid(order);
    const rawTime=Number(order?.create_time??order?.created_time??order?.order_create_time??0);
    const orderCreateTime=Number.isFinite(rawTime)
      ? Math.floor(rawTime>1000000000000?rawTime/1000:rawTime)
      : 0;
    return {order_id:orderId,order_create_time:orderCreateTime};
  }).filter((item:any)=>!!item.order_id&&!pendingFinanceIds.has(item.order_id));
  const queued=await enqueueTikTokExcelPayload(c,rows,found.length,sk);
  const now=new Date().toISOString();
  const pendingSummary=financePendingOrders.length
    ? "TIKTOK_FINANCE_PENDING:"+financePendingOrders.map(item=>item.order_id).join(",")
    : null;
  await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(c.id),{
    method:"PATCH",
    body:JSON.stringify({last_sync_at:now,last_success_at:now,last_error:pendingSummary,updated_at:now})
  });
  return {
    connection_id:c.id,store_id:c.store_id,status:"RAW_FILE_READY",
    orders_found:found.length,rows_found:rows.length,
    queue_id:queued.queue_id,file_name:queued.file_name,
    finance_orders:financeOrders,affiliate_by_order_id:affiliateByOrderId,
    creator_lookup_status:creatorLookupStatus,creator_names_found:creatorHandleByOrder.size,
    finance_pending_orders:financePendingOrders,
    finance_pending_count:financePendingOrders.length,
    engine:"SELLERBOOKS_IMPORT_PENJUALAN"
  };
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  if(req.method!=="POST")return out({ok:false,error:"Method not allowed"},405);
  try{
    const pk=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}").default,
          sk=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;
    if(!pk||!sk)return out({ok:false,error:"Authentication/configuration error"},401);
    const cronHeader=req.headers.get("x-sellerbooks-cron-secret")||"";
    let cronAuthorized=false;
    if(cronHeader){
      const cr=await rest(sk,"rpc/sellerbooks_validate_cron_secret",{method:"POST",body:JSON.stringify({p_secret:cronHeader})});
      if(cr.ok){try{cronAuthorized=(await cr.json())===true}catch{}}
    }
    let b:any={};try{b=await req.json()}catch{}
    const now=Math.floor(Date.now()/1000);
    if(cronAuthorized){
      // Manual-only policy: even if a cron/webhook is accidentally re-enabled,
      // an authorized cron request must never fetch marketplace orders.
      return out({
        ok: false,
        error: "AUTO_SYNC_DISABLED_MANUAL_ONLY",
        message: "Automatic TikTok order sync is disabled. Use the manual Tarik Order button."
      }, 410);
    }
    const token=bearer(req);
    if(!token)return out({ok:false,error:"Authentication/configuration error"},401);
    const user=await auth(token,pk);
    if(!user?.id||!user?.email)return out({ok:false,error:"Invalid session"},401);
    const from=Number(b.time_from??now-86400),to=Number(b.time_to??now);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)return out({ok:false,error:"Invalid time_from/time_to"},400);
    const em=String(user.email).toLowerCase().trim(),requestedConnectionId=String(b.connection_id||"").trim(),requestedStoreId=String(b.store_id||"").trim();
    if(!requestedConnectionId||!requestedStoreId)return out({ok:false,error:"connection_id and store_id are required"},400);
    const connRes=await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(requestedConnectionId)+"&store_id=eq."+encodeURIComponent(requestedStoreId)+"&owner_user_id=eq."+encodeURIComponent(String(user.id))+"&marketplace=eq.TikTok%20Shop&select=*",{method:"GET"});
    if(!connRes.ok){
      const lookupStatus=connRes.status;
      const lookupBody=String(await txt(connRes)).slice(0,800);
      let lookupDetail:any={};
      try{lookupDetail=JSON.parse(lookupBody)}catch{lookupDetail={message:lookupBody}}
      // Safe PostgREST diagnostics; never expose tokens or secret values.
      return out({
        ok:false,
        error:"CONNECTION_LOOKUP_FAILED",
        diagnostic:{
          http_status:lookupStatus,
          code:String(lookupDetail?.code||"").slice(0,80),
          message:String(lookupDetail?.message||lookupDetail?.hint||"Database lookup request failed").slice(0,400),
          details:String(lookupDetail?.details||"").slice(0,250)
        }
      },500);
    }
    const selectedConnectionRows=await connRes.json();
    const selectedConnection=Array.isArray(selectedConnectionRows)?selectedConnectionRows[0]:null;
    if(!selectedConnection)return out({ok:false,error:"CONNECTION_NOT_OWNED_OR_NOT_FOUND"},403);
    if(selectedConnection.connection_status!=="CONNECTED")return out({ok:false,error:"CONNECTION_NOT_CONNECTED"},409);
    const owner=String(user.id);
    const cs=[selectedConnection];
    const results:any[]=[];
    for(const c of cs){
      try{results.push(await run(c,from,to,token,pk,sk))}
      catch(e){const m=e instanceof Error?e.message:String(e);results.push({connection_id:c.id,store_id:c.store_id,status:"ERROR",error:m});await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(c.id),{method:"PATCH",body:JSON.stringify({last_sync_at:new Date().toISOString(),last_error:m})})}
    }
    return out({ok:true,marketplace:"TikTok Shop",sync_mode:"MANUAL",time_from:from,time_to:to,connections_checked:cs.length,results});
  }catch(e){return out({ok:false,error:e instanceof Error?e.message:String(e)},500)}
});