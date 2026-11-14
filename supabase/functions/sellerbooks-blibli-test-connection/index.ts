import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const BASE="https://api.blibli.com/v2";
const out=(x:unknown,n=200)=>new Response(JSON.stringify(x),{status:n,headers:{...CORS,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const h=r.headers.get("Authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():"";};
const env=(n:string,f:string)=>{try{return JSON.parse(Deno.env.get(n)||"{}").default||f}catch{return f}};
async function rest(url:string,key:string,path:string,init:RequestInit={}){const h=new Headers(init.headers);h.set("apikey",key);h.set("Authorization","Bearer "+key);h.set("Content-Type","application/json");return fetch(url+"/rest/v1/"+path,{...init,headers:h});}
async function getUser(url:string,key:string,token:string){const r=await fetch(url+"/auth/v1/user",{headers:{apikey:key,Authorization:"Bearer "+token}});return r.ok?await r.json():null;}
Deno.serve(async(req:Request)=>{
 const trace=crypto.randomUUID();
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method!=="POST")return out({ok:false,error:"Method not allowed",trace},405);
 try{
  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"",publishable=env("SUPABASE_PUBLISHABLE_KEYS",Deno.env.get("SUPABASE_ANON_KEY")||""),service=env("SUPABASE_SECRET_KEYS",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||""),token=bearer(req);
  if(!supabaseUrl||!publishable||!service||!token)return out({ok:false,error:"Authentication/configuration error",trace},401);
  const user=await getUser(supabaseUrl,publishable,token);if(!user?.id)return out({ok:false,error:"Invalid or expired session",trace},401);
  let body:any={};try{body=await req.json()}catch{}
  const connectionId=String(body.connection_id||"").trim();if(!connectionId)return out({ok:false,error:"connection_id is required",trace},400);
  const cr=await rest(supabaseUrl,service,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&owner_user_id=eq."+encodeURIComponent(user.id)+"&select=id,owner_user_id,store_id,marketplace_id,marketplace,vault_secret_id");
  if(!cr.ok)return out({ok:false,error:"Gagal memeriksa koneksi Blibli",trace},500);
  const rows=await cr.json(),connection=Array.isArray(rows)?rows[0]:null;
  if(!connection)return out({ok:false,error:"API connection not found",trace},404);
  if(String(connection.marketplace_id||"").toLowerCase()!=="blibli"&&String(connection.marketplace||"").toLowerCase()!=="blibli")return out({ok:false,error:"This function only supports Blibli",trace},400);
  if(!connection.vault_secret_id)return out({ok:false,error:"Kredensial Blibli belum tersimpan di Vault",trace},400);
  const vr=await rest(supabaseUrl,service,"rpc/sellerbooks_get_vault_secret",{method:"POST",body:JSON.stringify({p_secret_id:connection.vault_secret_id})});
  if(!vr.ok)return out({ok:false,error:"Gagal membaca kredensial Blibli dari Vault",trace},500);
  const vaultValue=await vr.json(),secretText=typeof vaultValue==="string"?vaultValue:Array.isArray(vaultValue)?vaultValue[0]?.decrypted_secret:vaultValue?.decrypted_secret;
  if(!secretText)return out({ok:false,error:"Kredensial Blibli tidak ditemukan di Vault",trace},400);
  let c:any;try{c=JSON.parse(secretText)}catch{return out({ok:false,error:"Format kredensial Blibli tidak valid",trace},400)}
  const clientId=String(c.api_client_id||Deno.env.get("BLIBLI_API_CLIENT_ID")||"").trim(),clientKey=String(c.api_client_key||Deno.env.get("BLIBLI_API_CLIENT_KEY")||"").trim();
  const sellerKey=String(c.api_seller_key||"").trim(),storeCode=String(c.store_code||"").trim(),username=String(c.username||"").trim(),storeId=String(c.store_id||"10001").trim(),channelId=String(c.channel_id||"SellerBooks MBI").trim();
  if(!clientId||!clientKey)return out({ok:false,error:"Kredensial platform Blibli SellerBooks belum dikonfigurasi",trace},500);
  if(!sellerKey||!storeCode||!username||!storeId||!channelId)return out({ok:false,error:"Lengkapi API Seller Key, kode toko, username, Store ID, dan Channel ID",trace},400);
  const requestId="sellerbooks-"+crypto.randomUUID(),query=new URLSearchParams({storeCode,username,requestId,storeId,channelId});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);let response:Response,raw="";
  try{
   response=await fetch(BASE+"/proxy/seller/v1/orders/packages/filter?"+query.toString(),{redirect:"manual",method:"POST",headers:{"Authorization":"Basic "+btoa(clientId+":"+clientKey),"Accept":"application/json","Content-Type":"application/json","Api-Seller-Key":sellerKey},body:JSON.stringify({filter:{},sorting:{by:"statusFPUpdatedTimestamp",direction:"ASC"},paging:{page:0,size:1}}),signal:controller.signal});
   raw=await response.text();
  }catch(e){return out({ok:false,error:e instanceof Error&&e.name==="AbortError"?"Permintaan ke Blibli timeout (15 detik)":"Tidak dapat menghubungi Blibli Seller API",trace},502)}
  finally{clearTimeout(timer)}
  let payload:any;try{payload=JSON.parse(raw)}catch{payload={raw:raw.slice(0,500)}}
  if(!response!.ok){
   const message=String(payload?.message||payload?.errorMessage||payload?.error||payload?.raw||("Blibli HTTP "+response!.status)).slice(0,250);
   const detail=message+" [server="+(response!.headers.get("server")||"n/a")+"; location="+(response!.headers.get("location")||"none")+"]";
   await rest(supabaseUrl,service,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&owner_user_id=eq."+encodeURIComponent(user.id),{method:"PATCH",body:JSON.stringify({connection_status:"ERROR",sync_enabled:false,last_error:detail,updated_at:new Date().toISOString()})});
   console.log(JSON.stringify({event:"blibli_test_http_error",trace,connection_id:connectionId,http_status:response!.status,server:response!.headers.get("server"),location:response!.headers.get("location")}));
   return out({ok:false,status:"ERROR",http_status:response!.status,error:detail,redirect_location:response!.headers.get("location"),response_server:response!.headers.get("server"),response_content_type:response!.headers.get("content-type"),trace},400);
  }
  if(payload?.errorMessage||payload?.errorCode||payload?.error){
   const message=String(payload.errorMessage||payload.error||payload.errorCode).slice(0,250);
   await rest(supabaseUrl,service,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&owner_user_id=eq."+encodeURIComponent(user.id),{method:"PATCH",body:JSON.stringify({connection_status:"ERROR",sync_enabled:false,last_error:message,updated_at:new Date().toISOString()})});
   return out({ok:false,status:"ERROR",error:message,trace},400);
  }
  const now=new Date().toISOString();
  await rest(supabaseUrl,service,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&owner_user_id=eq."+encodeURIComponent(user.id),{method:"PATCH",body:JSON.stringify({connection_status:"CONNECTED",last_success_at:now,last_error:null,updated_at:now})});
  const content=Array.isArray(payload?.content)?payload.content:[];
  return out({ok:true,status:"CONNECTED",marketplace:"Blibli",connection_id:connectionId,trace,sample_packages:content.length,message:"Autentikasi Blibli berhasil. Data pesanan belum diimpor."});
 }catch(e){console.error(JSON.stringify({event:"blibli_test_error",trace,error_type:e instanceof Error?e.name:"unknown"}));return out({ok:false,error:e instanceof Error?e.message:"Unexpected server error",trace},500)}
});