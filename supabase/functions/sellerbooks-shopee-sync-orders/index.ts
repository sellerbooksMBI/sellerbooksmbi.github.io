import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const HOST="https://partner.shopeemobile.com";
const out=(x:any,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
const tokenOf=(r:Request)=>{const h=r.headers.get("Authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():""};
const hex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
async function hmac(k:string,m:string){const x=await crypto.subtle.importKey("raw",new TextEncoder().encode(k),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(new Uint8Array(await crypto.subtle.sign("HMAC",x,new TextEncoder().encode(m))))}
async function rest(base:string,key:string,path:string,init:RequestInit={}){const h=new Headers(init.headers);h.set("apikey",key);h.set("Authorization","Bearer "+key);h.set("Content-Type","application/json");return fetch(base+"/rest/v1/"+path,{...init,headers:h})}
async function auth(base:string,key:string,t:string){const r=await fetch(base+"/auth/v1/user",{headers:{apikey:key,Authorization:"Bearer "+t}});return r.ok?r.json():null}
const txt=async(r:Response)=>{try{return await r.text()}catch{return ""}};
function parseCredential(raw:string){
  let p:any;try{p=JSON.parse(raw)}catch{throw Error("SHOPEE_CREDENTIAL_INVALID_JSON")}
  const c={
    partner_id:Number(p.partner_id??p.partnerId??p.app_id??p.appId),
    shop_id:Number(p.shop_id??p.shopId??p.store_id??p.storeId),
    partner_key:String(p.partner_key??p.partnerKey??p.app_key??p.appKey??"").trim(),
    access_token:String(p.access_token??p.accessToken??"").trim(),
    refresh_token:String(p.refresh_token??p.refreshToken??"").trim(),
    api_base_url:String(Deno.env.get("SHOPEE_API_BASE_URL")??p.api_base_url??p.apiBaseUrl??HOST).replace(/\/$/,"")
  };
  if(!c.partner_id)throw Error("SHOPEE_PARTNER_ID_MISSING");
  if(!c.shop_id)throw Error("SHOPEE_SHOP_ID_MISSING");
  if(!c.partner_key)throw Error("SHOPEE_PARTNER_KEY_MISSING");
  if(!c.access_token)throw Error("SHOPEE_ACCESS_TOKEN_MISSING");
  return c;
}
async function callShopee(c:any,path:string,method:"GET"|"POST"="GET",params:Record<string,any>={},body:any=null){
  const timestamp=Math.floor(Date.now()/1000);
  const bodyText=method==="POST"?JSON.stringify(body??{}):"";
  const base=String(c.partner_id)+"/api/v2"+path+timestamp+c.access_token+String(c.shop_id);
  const sign=await hmac(c.partner_key,base);
  const url=new URL((c.api_base_url||HOST)+"/api/v2"+path);
  const query={partner_id:c.partner_id,timestamp,access_token:c.access_token,shop_id:c.shop_id,sign,...params};
  for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null&&String(v)!=="")url.searchParams.set(k,String(v));
  const response=await fetch(url,{method,headers:{Accept:"application/json","Content-Type":"application/json"},...(method==="POST"?{body:bodyText}:{})});
  const raw=await txt(response);let data:any;try{data=JSON.parse(raw)}catch{data={raw}};
  if(!response.ok||(data?.error&&String(data.error)!=="0"))throw Error("SHOPEE_API_ERROR:"+String(data?.message||data?.msg||data?.error||response.status));
  return data;
}
function epoch(v:any,fallback:number){
  if(v===undefined||v===null||String(v).trim()==="")return fallback;
  const n=Number(v);if(Number.isFinite(n)&&n>0)return Math.floor(n>1000000000000?n/1000:n);
  const d=new Date(String(v));return Number.isNaN(d.getTime())?fallback:Math.floor(d.getTime()/1000);
}
function iso(v:any){
  const n=Number(v);if(Number.isFinite(n)&&n>0)return new Date(n>1000000000000?n:n*1000).toISOString();
  const d=new Date(String(v||""));return Number.isNaN(d.getTime())?new Date().toISOString():d.toISOString();
}
function arr(v:any){return Array.isArray(v)?v:[]}
function extractOrderList(data:any){const r=data?.response??{};return arr(r.order_list??r.order_list_info??r.orders)}
async function listOrders(c:any,status:string,from:number,to:number,rangeField:"create_time"|"update_time"="update_time"){
  const all:any[]=[];let cursor="";
  for(let page=0;page<100;page++){
    const d=await callShopee(c,"/order/get_order_list","GET",{
      time_range_field:rangeField,time_from:from,time_to:to,page_size:100,cursor,order_status:status,
      response_optional_fields:"order_status"
    });
    all.push(...extractOrderList(d));
    const response=d?.response||{};
    if(!response.more)break;
    const next=String(response.next_cursor||"");
    if(!next||next===cursor)break;
    cursor=next;
  }
  return all;
}
async function getOrderDetails(c:any,ids:string[]){
  const all:any[]=[];
  for(let i=0;i<ids.length;i+=50){
    const chunk=ids.slice(i,i+50);
    const d=await callShopee(c,"/order/get_order_detail","GET",{
      order_sn_list:chunk.join(","),
      response_optional_fields:"item_list,package_list,recipient_address,buyer_username,payment_method,total_amount,create_time,update_time,shipping_carrier,tracking_number,cancel_by,cancel_reason"
    });
    all.push(...extractOrderList(d));
  }
  return all;
}
async function getAffiliateByOrderId(c:any,ids:string[]){
  const result:Record<string,any>={};
  const unique=Array.from(new Set(ids.map(x=>String(x||"").trim()).filter(Boolean)));
  for(let i=0;i<unique.length;i+=50){
    const chunk=unique.slice(i,i+50);
    try{
      const d=await callShopee(c,"/payment/get_escrow_detail_batch","POST",{}, {order_sn_list:chunk});
      const response=arr(d?.response);
      for(const entry of response){
        const detail=entry?.escrow_detail||entry?.order_income&&entry||entry;
        const orderId=String(detail?.order_sn||entry?.order_sn||"").trim();
        if(!orderId)continue;
        const income=detail?.order_income||entry?.order_income||{};
        const direct=income?.order_ams_commission_fee;
        let amount:any=direct;
        let sourceField="order_income.order_ams_commission_fee";
        if(direct===undefined||direct===null||String(direct).trim()===""){
          const itemFees=arr(income?.items??detail?.items??entry?.items)
            .map((item:any)=>item?.ams_commission_fee)
            .filter((v:any)=>v!==undefined&&v!==null&&String(v).trim()!=="")
            .map((v:any)=>Number(v));
          if(itemFees.length){amount=itemFees.reduce((sum:number,v:number)=>sum+(Number.isFinite(v)?v:0),0);sourceField="items[].ams_commission_fee";}
        }
        if(amount!==undefined&&amount!==null&&String(amount).trim()!==""){
          const n=Number(amount);
          if(Number.isFinite(n))result[orderId]={amount:Math.abs(n),status:"CONFIRMED",source:"SHOPEE_ESCROW",source_field:sourceField};
        }
      }
    }catch(e){
      console.warn(JSON.stringify({service:"sellerbooks-shopee-sync-orders",event:"affiliate_batch_failed",batch_index:Math.floor(i/50),order_count:chunk.length,error:e instanceof Error?e.message:String(e)}));
    }
  }
  return result;
}
const HEADERS=["Order ID","Order Status","Order Substatus","Nomor Referensi SKU","Nama Produk","Nama Variasi","Jumlah Produk","Harga Setelah Diskon","Subtotal Pesanan","Waktu Pesanan Dibuat","Waktu Pembayaran","Nomor Resi","Kurir Pengiriman","Nama Pengguna Pembeli","Metode Pembayaran","SKU ID","Item ID","Package ID"];
function makeRows(orders:any[]){
  const rows:any[][]=[];
  for(const order of orders){
    const orderId=String(order?.order_sn||"").trim();if(!orderId)continue;
    const items=arr(order?.item_list);
    for(const item of items){
      const sku=String(item?.model_sku||item?.item_sku||item?.seller_sku||"").trim();
      const qty=Math.max(0,Number(item?.model_quantity_purchased??item?.model_quantity??item?.quantity_purchased??1)||0);
      const unit=Number(item?.model_discounted_price??item?.variation_discounted_price??item?.item_price??0);
      if(!sku||qty<=0)continue;
      const price=Number.isFinite(unit)?unit:0;
      const pkg=arr(order?.package_list)[0]||{};
      rows.push([
        orderId,String(order?.order_status||""),String(order?.order_substatus||""),sku,
        String(item?.item_name||""),String(item?.model_name||""),qty,price,price*qty,
        iso(order?.create_time),iso(order?.pay_time),String(pkg?.tracking_number||order?.tracking_number||""),
        String(order?.shipping_carrier||order?.shipping_provider||""),String(order?.buyer_username||""),
        String(order?.payment_method||""),String(item?.model_id||""),String(item?.item_id||""),String(pkg?.package_number||"")
      ]);
    }
  }
  return rows;
}
async function enqueue(c:any,rows:any[][],secret:string){
  const fileName="AUTO-SYNC-SHOPEE-"+new Date().toISOString()+".xlsx";
  const r=await rest(Deno.env.get("SUPABASE_URL")||"",secret,"sellerbooks_api_import_queue",{
    method:"POST",headers:{"Prefer":"return=representation"},
    body:JSON.stringify({owner_user_id:String(c.owner_user_id),connection_id:String(c.id),store_id:String(c.store_id),marketplace:"Shopee",file_name:fileName,file_type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",headers:HEADERS,rows,status:"PENDING"})
  });
  if(!r.ok)throw Error("API_IMPORT_QUEUE_ERROR:"+r.status+":"+String(await txt(r)).slice(0,400));
  const saved=await r.json();const item=Array.isArray(saved)?saved[0]:saved;
  return {queue_id:item?.id||null,file_name:fileName,rows_count:rows.length};
}
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  if(req.method!=="POST")return out({ok:false,error:"Method not allowed"},405);
  try{
    const base=Deno.env.get("SUPABASE_URL")||"";
    const publishable=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}").default||Deno.env.get("SUPABASE_ANON_KEY")||"";
    const secret=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
    const token=tokenOf(req);
    if(!base||!publishable||!secret||!token)return out({ok:false,error:"Authentication/configuration error"},401);
    const user=await auth(base,publishable,token);
    if(!user?.id)return out({ok:false,error:"Invalid or expired session"},401);
    const body=await req.json().catch(()=>({}));
    const connectionId=String(body.connection_id||"").trim(),storeId=String(body.store_id||"").trim();
    if(!connectionId||!storeId)return out({ok:false,error:"connection_id and store_id are required"},400);
    const cr=await rest(base,secret,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&store_id=eq."+encodeURIComponent(storeId)+"&owner_user_id=eq."+encodeURIComponent(String(user.id))+"&select=*");
    const connections=await cr.json().catch(()=>[]),connection=connections?.[0];
    if(!cr.ok||!connection)return out({ok:false,error:"Shopee API connection not found"},404);
    if(String(connection.marketplace_id||"").toLowerCase()!=="shopee"&&String(connection.marketplace||"").toLowerCase()!=="shopee")return out({ok:false,error:"Connection is not Shopee"},400);
    if(String(connection.connection_status||"").toUpperCase()!=="CONNECTED")return out({ok:false,error:"Shopee connection is not CONNECTED"},400);
    if(!connection.vault_secret_id)return out({ok:false,error:"Credential Vault belum tersedia"},400);
    const vr=await rest(base,secret,"decrypted_secrets?id=eq."+encodeURIComponent(connection.vault_secret_id)+"&select=id,decrypted_secret");
    const vaultRows=await vr.json().catch(()=>[]);
    const rawCredential=vaultRows?.[0]?.decrypted_secret;
    if(!vr.ok||!rawCredential)return out({ok:false,error:"Shopee Credential Vault tidak ditemukan"},400);
    const credential=parseCredential(rawCredential);
    if(connection.external_store_id&&String(credential.shop_id)!==String(connection.external_store_id))return out({ok:false,error:"Shop ID credential tidak sama dengan external_store_id koneksi Shopee"},400);
    const now=Math.floor(Date.now()/1000);
    const from=epoch(body.time_from,now-7*86400),to=epoch(body.time_to,now);
    if(from>=to)return out({ok:false,error:"Invalid time_from/time_to"},400);
    // Shopee status tabs reflect current status; query update_time first so orders moved into these tabs today are included, then reconcile create_time results without duplicates.
    const listed=await Promise.all(["READY_TO_SHIP","PROCESSED"].flatMap(status=>[
      listOrders(credential,status,from,to,"update_time"),
      listOrders(credential,status,from,to,"create_time")
    ]));
    const ids=Array.from(new Set(listed.flat().map((o:any)=>String(o?.order_sn||"").trim()).filter(Boolean)));
    const details=ids.length?await getOrderDetails(credential,ids):[];
    const rows=makeRows(details);
    const pendingIds=Array.isArray(body.pending_order_ids)?body.pending_order_ids.map((x:any)=>String(x||"").trim()).filter(Boolean):[];
    const affiliateIds=Array.from(new Set(ids.concat(pendingIds)));
    const affiliateByOrderId=affiliateIds.length?await getAffiliateByOrderId(credential,affiliateIds):{};
    const financeOrders=ids.map(id=>({order_id:id,order_create_time:epoch(details.find((x:any)=>String(x?.order_sn||"")===id)?.create_time,0)}));
    let queued:any=null;
    if(rows.length)queued=await enqueue(connection,rows,secret);
    const timestamp=new Date().toISOString();
    await rest(base,secret,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connection.id),{method:"PATCH",body:JSON.stringify({last_sync_at:timestamp,last_success_at:timestamp,last_error:null,updated_at:timestamp})});
    return out({
      ok:true,marketplace:"Shopee",sync_mode:"MANUAL",status:rows.length?"RAW_FILE_READY":"NO_ORDERS",
      orders_found:ids.length,rows_found:rows.length,queue_id:queued?.queue_id||null,file_name:queued?.file_name||null,
      finance_orders:financeOrders,affiliate_by_order_id:affiliateByOrderId,
      affiliate_checked:Object.keys(affiliateByOrderId).length,engine:"SELLERBOOKS_IMPORT_PENJUALAN",
      order_status_filter:["READY_TO_SHIP","PROCESSED"]
    });
  }catch(e){
    const message=e instanceof Error?e.message:String(e||"Unexpected server error");
    console.error(JSON.stringify({service:"sellerbooks-shopee-sync-orders",event:"sync_failed",error:message}));
    return out({ok:false,error:message},500);
  }
});
