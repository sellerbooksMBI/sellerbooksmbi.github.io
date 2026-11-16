import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const BASE="https://api.blibli.com/v2";
const out=(x:unknown,n=200)=>new Response(JSON.stringify(x),{status:n,headers:{...CORS,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const h=r.headers.get("Authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():"";};
const env=(n:string,f:string)=>{try{return JSON.parse(Deno.env.get(n)||"{}").default||f}catch{return f}};
const rest=async(k:string,p:string,i:RequestInit={})=>{const h=new Headers(i.headers);h.set("apikey",k);h.set("Authorization","Bearer "+k);h.set("Content-Type","application/json");return fetch((Deno.env.get("SUPABASE_URL")||"")+"/rest/v1/"+p,{...i,headers:h});};
const text=async(r:Response)=>{try{return await r.text()}catch{return ""}};
const raw=(...v:any[])=>{for(const x of v)if(x!==undefined&&x!==null&&String(x).trim()!=="")return x;return ""};
const iso=(v:any)=>{const n=Number(v);if(Number.isFinite(n)&&n>100000000)return new Date(n).toISOString();const d=new Date(String(v||""));return Number.isNaN(d.getTime())?"":d.toISOString()};
const headers=["Nomor Pesanan","SKU Seller","Total Produk","Jumlah Produk","Nomor Resi/AWB","Harga Produk","Tanggal Pesanan","Status Pesanan","ID Paket"];
function rowFor(pkg:any,item:any){
 const ord=item?.order||{},prod=item?.product||{},logi=item?.logistic||{};
 const orderNo=raw(item?.orderNo,item?.orderNumber,item?.orderId,ord?.orderNo,ord?.orderNumber,ord?.orderId,ord?.id,pkg?.orderNo,pkg?.orderNumber,pkg?.orderId,item?.orderItemNo,item?.orderItemNumber,item?.orderItemId);
 const sku=raw(item?.sellerSku,item?.sellerSKU,item?.sellerSkuCode,item?.skuSeller,item?.merchantSku,item?.itemSku,item?.productSku,item?.skuCode,item?.sku,prod?.sellerSku,prod?.sellerSKU,prod?.sellerSkuCode,prod?.skuSeller,prod?.merchantSku,prod?.itemSku,prod?.productSku,prod?.skuCode,prod?.sku,prod?.id);
 const qty=Math.max(0,Number(raw(item?.qty,item?.quantity,item?.itemQuantity,item?.orderedQuantity,item?.orderQuantity,prod?.qty,prod?.quantity,1))||1);
 const price=Number(raw(item?.price?.sellingPrice,item?.sellingPrice,item?.sellingPriceAfterDiscount,item?.productPrice,item?.productSalePrice,item?.price,item?.unitPrice,item?.regularPrice,prod?.sellingPrice,prod?.productPrice,prod?.productSalePrice,prod?.price?.sellingPrice,prod?.price,0))||0;
 const created=iso(raw(item?.createdDate,item?.orderCreatedDate,item?.orderDate,ord?.createdDate,ord?.orderDate,pkg?.createdDate,pkg?.orderCreatedDate,pkg?.orderDate));
 const awb=raw(item?.awbNumber,item?.trackingNumber,item?.shippingLabelNumber,logi?.awbNumber,logi?.trackingNumber,logi?.shippingLabelNumber,logi?.awb,pkg?.awbNumber,pkg?.trackingNumber,pkg?.shippingLabelNumber);
 const status=raw(typeof item?.orderItemStatus==="object"?(item.orderItemStatus.code||item.orderItemStatus.status):item?.orderItemStatus,ord?.orderItemStatus?.code,ord?.orderItemStatus,ord?.orderStatus?.code,ord?.orderStatus,ord?.status?.code,typeof ord?.status==="string"?ord.status:"",item?.orderStatus?.code,item?.orderStatus,item?.status?.code,item?.status,pkg?.orderItemStatus?.code,pkg?.orderItemStatus,pkg?.orderStatus?.code,pkg?.orderStatus,pkg?.status,"FP");
 const packageId=raw(item?.packageId,pkg?.packageId,pkg?.id);
 return [orderNo,sku,price*qty,qty,awb,price,created,status,packageId];
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method!=="POST")return out({ok:false,error:"Method not allowed"},405);
 try{
  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
  const pk=env("SUPABASE_PUBLISHABLE_KEYS",Deno.env.get("SUPABASE_ANON_KEY")||"");
  const sk=env("SUPABASE_SECRET_KEYS",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"");
  const token=bearer(req);
  if(!supabaseUrl||!pk||!sk||!token)return out({ok:false,error:"Authentication/configuration error"},401);
  const ur=await fetch(supabaseUrl+"/auth/v1/user",{headers:{apikey:pk,Authorization:"Bearer "+token}});
  const user=ur.ok?await ur.json():null;
  if(!user?.id)return out({ok:false,error:"Invalid or expired session"},401);
  let b:any={};try{b=await req.json()}catch{}
  const connectionId=String(b.connection_id||"").trim(),storeId=String(b.store_id||"").trim();
  if(!connectionId||!storeId)return out({ok:false,error:"connection_id and store_id are required"},400);
  const cr=await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&owner_user_id=eq."+encodeURIComponent(user.id)+"&select=id,owner_user_id,store_id,marketplace,marketplace_id,connection_status,vault_secret_id");
  if(!cr.ok)return out({ok:false,error:"Gagal memeriksa koneksi Blibli"},500);
  const cs=await cr.json(),c=Array.isArray(cs)?cs[0]:null;
  if(!c)return out({ok:false,error:"API connection not found"},404);
  if(String(c.store_id)!==storeId)return out({ok:false,error:"Store tidak cocok dengan koneksi Blibli"},403);
  if(String(c.marketplace||c.marketplace_id||"").toLowerCase()!=="blibli")return out({ok:false,error:"This function only supports Blibli"},400);
  if(String(c.connection_status||"").toUpperCase()!=="CONNECTED")return out({ok:false,error:"Akun Blibli belum terintegrasi"},400);
  if(!c.vault_secret_id)return out({ok:false,error:"Kredensial Blibli tidak ditemukan di Vault"},400);
  const vr=await rest(sk,"rpc/sellerbooks_get_vault_secret",{method:"POST",body:JSON.stringify({p_secret_id:c.vault_secret_id})});
  if(!vr.ok)return out({ok:false,error:"Gagal membaca kredensial Blibli dari Vault"},500);
  const v=await vr.json(),secretText=typeof v==="string"?v:Array.isArray(v)?v[0]?.decrypted_secret:v?.decrypted_secret;
  if(!secretText)return out({ok:false,error:"Kredensial Blibli tidak ditemukan di Vault"},400);
  let cred:any;try{cred=JSON.parse(secretText)}catch{return out({ok:false,error:"Format kredensial Blibli tidak valid"},400)}
  const clientId=String(cred.api_client_id||Deno.env.get("BLIBLI_API_CLIENT_ID")||"").trim();
  const clientKey=String(cred.api_client_key||Deno.env.get("BLIBLI_API_CLIENT_KEY")||"").trim();
  const sellerKey=String(cred.api_seller_key||"").trim(),storeCode=String(cred.store_code||"").trim(),username=String(cred.username||"").trim();
  const blibliStoreId=String(cred.store_id||"10001").trim(),channelId=String(cred.channel_id||"SellerBooks MBI").trim();
  if(!clientId||!clientKey||!sellerKey||!storeCode||!username)return out({ok:false,error:"Konfigurasi kredensial Blibli belum lengkap"},400);
  // Blibli only: collect newly actionable orders in FP status, without date window.
  const all:any[]=[];const responseDiagnostics:any[]=[];let page=0,totalPages=1;
  while(page<totalPages&&page<90){
   const query=new URLSearchParams({storeCode,username,requestId:"sellerbooks-"+crypto.randomUUID(),storeId:blibliStoreId,channelId});
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
   let response:Response,bodyText="";
   try{
    response=await fetch(BASE+"/proxy/seller/v1/orders/packages/filter?"+query.toString(),{method:"POST",redirect:"manual",headers:{"Authorization":"Basic "+btoa(clientId+":"+clientKey),"Accept":"application/json","Content-Type":"application/json","Api-Seller-Key":sellerKey},body:JSON.stringify({filter:{orderItemStatuses:["FP"]},sorting:{by:"statusFPUpdatedTimestamp",direction:"ASC"},paging:{page,size:50}}),signal:controller.signal});
    bodyText=await response.text();
   }finally{clearTimeout(timer)}
   let data:any;try{data=JSON.parse(bodyText)}catch{data={raw:bodyText.slice(0,300)}}
   if(!response!.ok||data?.errorMessage||data?.errorCode)throw Error("BLIBLI_API_ERROR HTTP "+response!.status+": "+String(data?.errorMessage||data?.message||data?.raw||data?.errorCode||"Unknown response").slice(0,250));
   const packages=Array.isArray(data?.content)?data.content:[];
   responseDiagnostics.push({page,http_status:response!.status,top_level_keys:Object.keys(data||{}),content_count:packages.length,first_package_keys:Object.keys(packages[0]||{}),first_item_keys:Object.keys((packages[0]?.orderItems||packages[0]?.items||[])[0]||{}),page_meta:data?.pageMetaData||data?.paging||data?.pagination||null});
   all.push(...packages);
   const paging=data?.paging||data?.pageMetaData||data?.pagination||{};
   const totalRecords=Number(paging.totalRecord??paging.totalRecords);
   const pageSize=Number(paging.pageSize)||50;
   totalPages=Number(paging.totalPage??paging.totalPages)||(Number.isFinite(totalRecords)?Math.max(1,Math.ceil(totalRecords/pageSize)):(packages.length===50?page+2:page+1));
   if(Number.isFinite(totalRecords)&&totalRecords>=0&&all.length>=totalRecords)totalPages=page+1;
   if(!packages.length)break;
   page++;
  }
  const rows:any[]=[],seenItems=new Set<string>(),seenOrderIds=new Set<string>();
  const statusCounts:Record<string,number>={},responseItemKeys:string[][]=[];
  const quantityDiagnostics:any[]=[];
  let missingOrderNo=0,missingSku=0,missingBoth=0;
  for(const pkg of all){
   const items=Array.isArray(pkg?.orderItems)?pkg.orderItems:(Array.isArray(pkg?.items)?pkg.items:[]);
   for(const item of items){
    const statusValue=raw(typeof item?.orderItemStatus==="object"?(item.orderItemStatus?.code||item.orderItemStatus?.status):item?.orderItemStatus,item?.orderStatus?.code,item?.orderStatus,typeof item?.status==="object"?(item.status?.code||item.status?.status):item?.status,typeof pkg?.orderItemStatus==="object"?(pkg.orderItemStatus?.code||pkg.orderItemStatus?.status):pkg?.orderItemStatus,pkg?.orderStatus?.code,pkg?.orderStatus,typeof pkg?.status==="object"?(pkg.status?.code||pkg.status?.status):pkg?.status);
    const status=String(statusValue||"").trim().toUpperCase();
    statusCounts[status||"UNKNOWN"]=(statusCounts[status||"UNKNOWN"]||0)+1;
    if(responseItemKeys.length<3)responseItemKeys.push({item:Object.keys(item||{}),order:Object.keys(item?.order||{}),product:Object.keys(item?.product||{}),logistic:Object.keys(item?.logistic||{}),flag:Object.keys(item?.flag||{})});
    if(status&&status!=="FP")continue;
    const row=rowFor(pkg,item),orderId=String(row[0]||"").trim(),sku=String(row[1]||"").trim();
    if(orderId==="12200200814"){
     quantityDiagnostics.push({
      order_id:orderId,sku,
      item_keys:Object.keys(item||{}),
      item_id:raw(item?.id,item?.orderItemNo,item?.orderItemId,item?.orderItemNumber,item?.itemId),
      quantity_candidates:{quantity:item?.quantity,qty:item?.qty,itemQuantity:item?.itemQuantity,orderedQuantity:item?.orderedQuantity,orderQuantity:item?.orderQuantity,product_quantity:item?.product?.quantity,product_qty:item?.product?.qty,combo:item?.combo,comboList:item?.comboList,items:item?.items},
      product_keys:Object.keys(item?.product||{}),
      order_keys:Object.keys(item?.order||{})
     });
    }
    if(!orderId)missingOrderNo++;
    if(!sku)missingSku++;
    if(!orderId&&!sku)missingBoth++;
    if(!orderId||!sku)continue;
    seenOrderIds.add(orderId);
    const itemId=String(raw(item?.id,item?.orderItemNo,item?.orderItemId,item?.orderItemNumber,item?.itemId,item?.sellerSku,item?.sellerSKU,item?.merchantSku,item?.itemSku,sku));
    const uniqueKey=orderId+"|"+itemId;
    if(seenItems.has(uniqueKey))continue;
    seenItems.add(uniqueKey);rows.push(row);
   }
  }
  console.log(JSON.stringify({event:"blibli_quantity_audit",target_order_id:"12200200814",quantity_diagnostics:quantityDiagnostics}));
  if(!rows.length){
   const diagnostic={packages_found:all.length,items_seen:all.reduce((n,p)=>n+(Array.isArray(p?.orderItems)?p.orderItems.length:Array.isArray(p?.items)?p.items.length:0),0),status_counts:statusCounts,missing_order_no:missingOrderNo,missing_sku:missingSku,missing_both:missingBoth,sample_item_keys:responseItemKeys,response_pages:responseDiagnostics};
   console.log(JSON.stringify({event:"blibli_sync_diagnostic",diagnostic}));
   return out({ok:true,marketplace:"Blibli",status:"NO_ORDERS",orders_found:seenOrderIds.size,rows_found:0,filter_status:"FP",diagnostic});
  }
  const fileName="AUTO-SYNC-BLIBLI-"+new Date().toISOString()+".xlsx";
  const qr=await rest(sk,"sellerbooks_api_import_queue",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify({owner_user_id:String(c.owner_user_id),connection_id:String(c.id),store_id:String(c.store_id),marketplace:"Blibli",file_name:fileName,file_type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",headers,rows,status:"PENDING"})});
  if(!qr.ok)throw Error("API_IMPORT_QUEUE_INSERT_FAILED:"+String(await text(qr)).slice(0,300));
  const queued=await qr.json(),queueItem=Array.isArray(queued)?queued[0]:queued,now=new Date().toISOString();
  await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(c.id),{method:"PATCH",body:JSON.stringify({last_sync_at:now,last_success_at:now,last_error:null,updated_at:now})});
  return out({ok:true,marketplace:"Blibli",status:"RAW_FILE_READY",filter_status:"FP",orders_found:seenOrderIds.size,rows_found:rows.length,queue_id:queueItem?.id||null,file_name:fileName,engine:"SELLERBOOKS_IMPORT_PENJUALAN"});
 }catch(e){return out({ok:false,error:e instanceof Error?e.message:"Unexpected server error"},500)}
});