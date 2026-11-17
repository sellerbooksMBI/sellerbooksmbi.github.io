import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const ENV=String(Deno.env.get("SHOPEE_ENVIRONMENT")||"sandbox").trim().toLowerCase();
if(ENV!=="sandbox"&&ENV!=="production")throw new Error("SHOPEE_ENVIRONMENT must be sandbox or production");
const HOST=(Deno.env.get(ENV==="production"?"SHOPEE_LIVE_API_BASE_URL":"SHOPEE_SANDBOX_API_BASE_URL")||(ENV==="sandbox"?Deno.env.get("SHOPEE_API_BASE_URL"):null)||(ENV==="production"?"https://partner.shopeemobile.com":"https://openplatform.sandbox.test-stable.shopee.sg")).replace(/\/$/,"");
const out=(x:any,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
const hex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
async function hmac(k:string,m:string){const x=await crypto.subtle.importKey("raw",new TextEncoder().encode(k),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(new Uint8Array(await crypto.subtle.sign("HMAC",x,new TextEncoder().encode(m))))}
function env(n:string){const v=Deno.env.get(n);if(v)return v;const aliases:any={SUPABASE_PUBLISHABLE_KEY:"SUPABASE_ANON_KEY",SUPABASE_SECRET_KEY:"SUPABASE_SERVICE_ROLE_KEY"};const a=aliases[n];if(a&&Deno.env.get(a))return Deno.env.get(a)!;if(n==="SUPABASE_PUBLISHABLE_KEY"){try{const x=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");if(x.default)return x.default}catch{}}if(n==="SUPABASE_SECRET_KEY"){try{const x=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");if(x.default)return x.default}catch{}}throw Error("CONFIG_MISSING_"+n)}
async function rest(base:string,key:string,path:string,init:RequestInit={}){const h=new Headers(init.headers);h.set("apikey",key);h.set("Authorization","Bearer "+key);h.set("Content-Type","application/json");return fetch(base+"/rest/v1/"+path,{...init,headers:h})}
const txt=async(r:Response)=>{try{return await r.text()}catch{return ""}};
async function readVault(base:string,key:string,id:string){const r=await rest(base,key,"rpc/sellerbooks_get_vault_secret",{method:"POST",body:JSON.stringify({p_secret_id:id})});if(!r.ok)throw Error("VAULT_READ_FAILED_"+r.status);const raw=await txt(r);let value:any;try{value=JSON.parse(raw)}catch{throw Error("VAULT_RESPONSE_INVALID")};const parsed=typeof value==="string"?JSON.parse(value):value;if(!parsed||typeof parsed!=="object")throw Error("SHOPEE_CREDENTIAL_INVALID");return parsed}
async function refresh(base:string,key:string,connection:any,credential:any){
  const partnerId=Number(credential.partner_id),shopId=Number(credential.shop_id),partnerKey=String(credential.partner_key||"").trim(),refreshToken=String(credential.refresh_token||"").trim();
  if(!partnerId||!shopId||!partnerKey||!refreshToken)throw Error("SHOPEE_CREDENTIAL_FIELDS_MISSING");
  if(connection.external_store_id&&String(shopId)!==String(connection.external_store_id))throw Error("SHOPEE_SHOP_ID_MISMATCH");
  const path="/api/v2/auth/access_token/get",ts=Math.floor(Date.now()/1000),sign=await hmac(partnerKey,String(partnerId)+path+ts),url=new URL(HOST+path);
  url.searchParams.set("partner_id",String(partnerId));url.searchParams.set("timestamp",String(ts));url.searchParams.set("sign",sign);
  const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({refresh_token:refreshToken,partner_id:partnerId,shop_id:shopId})});
  const raw=await txt(response);let data:any;try{data=JSON.parse(raw)}catch{data={}};
  if(!response.ok||data?.error||!data?.access_token||!data?.refresh_token)throw Error("SHOPEE_REFRESH_FAILED:"+String(data?.message||data?.msg||data?.error||response.status));
  if(data?.shop_id&&String(data.shop_id)!==String(shopId))throw Error("SHOPEE_REFRESH_SHOP_MISMATCH");
  const next={...credential,provider:"shopee",auth_type:"oauth",partner_id:partnerId,shop_id:shopId,partner_key:partnerKey,access_token:String(data.access_token),refresh_token:String(data.refresh_token),expire_in:data.expire_in||null,refresh_token_expire_in:data.refresh_token_expire_in||credential.refresh_token_expire_in||null,token_received_at:new Date().toISOString(),api_base_url:HOST,environment:ENV};
  const saved=await rest(base,key,"rpc/sellerbooks_update_marketplace_vault_credential",{method:"POST",body:JSON.stringify({p_connection_id:connection.id,p_marketplace:"Shopee",p_credential:next})});
  const savedText=await txt(saved);if(!saved.ok)throw Error("VAULT_SAVE_FAILED:"+saved.status+":"+savedText.slice(0,160));
  return Number(data.expire_in||0);
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  if(req.method!=="POST")return out({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  try{
    const body=await req.json().catch(()=>({})),token=String(body?.token||"");
    if(token.length<40)return out({ok:false,error:"UNAUTHORIZED"},401);
    const base=env("SUPABASE_URL"),pub=env("SUPABASE_PUBLISHABLE_KEY"),secret=env("SUPABASE_SECRET_KEY");
    const verified=await rest(base,pub,"rpc/sellerbooks_verify_shopee_keepalive_token",{method:"POST",body:JSON.stringify({p_token:token})});
    const verifiedText=await txt(verified);if(!verified.ok||verifiedText.trim()!=="true")return out({ok:false,error:"UNAUTHORIZED"},401);
    const list=await rest(base,secret,"sellerbooks_api_connections?select=id,vault_secret_id,marketplace_id,marketplace,connection_status,external_store_id&connection_status=eq.CONNECTED");
    if(!list.ok)throw Error("CONNECTION_LIST_FAILED_"+list.status);
    const rows=await list.json(),shopee=(Array.isArray(rows)?rows:[]).filter((x:any)=>String(x.marketplace_id||x.marketplace||"").toLowerCase().replace(/\s+/g,"")==="shopee");
    let refreshed=0,skipped=0,failed=0,reconnectRequired=0;
    for(const connection of shopee){
      try{
        if(!connection.vault_secret_id)throw Error("VAULT_SECRET_MISSING");
        const credential=await readVault(base,secret,String(connection.vault_secret_id));
        if(String(credential.environment||"sandbox").toLowerCase()!==ENV)throw Error("SHOPEE_ENVIRONMENT_MISMATCH");
        const received=Date.parse(String(credential.token_received_at||""));
        if(Number.isFinite(received)&&received>Date.now()-10*60*60*1000){skipped++;continue}
        const expireIn=await refresh(base,secret,connection,credential);
        refreshed++;
        console.info(JSON.stringify({service:"sellerbooks-shopee-token-keepalive",event:"token_refreshed",connection_id:connection.id,shop_id:credential.shop_id,expire_in:expireIn}));
      }catch(e){
        failed++;
        const message=e instanceof Error?e.message:String(e);
        if(/expired|invalid.*refresh|refresh.*invalid/i.test(message))reconnectRequired++;
        console.error(JSON.stringify({service:"sellerbooks-shopee-token-keepalive",event:"connection_refresh_failed",connection_id:connection.id,error:message}));
      }
    }
    return out({ok:true,checked:shopee.length,refreshed,skipped,failed,reconnect_required:reconnectRequired});
  }catch(e){const message=e instanceof Error?e.message:String(e);console.error(JSON.stringify({service:"sellerbooks-shopee-token-keepalive",event:"keepalive_failed",error:message}));return out({ok:false,error:message},500)}
});
