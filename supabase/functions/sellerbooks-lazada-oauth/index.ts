import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

const APP_URL = (Deno.env.get("SELLERBOOKS_APP_URL") || "https://sellerbooksmbi.github.io/").replace(/\/?$/, "/");
const REDIRECT_URI = Deno.env.get("LAZADA_OAUTH_REDIRECT_URI")
  || "https://vrgiwzxwnfjhpmxcahwo.supabase.co/functions/v1/sellerbooks-lazada-oauth?action=callback";
const AUTH_BASE = "https://auth.lazada.com";
const TOKEN_PATH = "/auth/token/create";

const out = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { ...CORS, "Content-Type": "application/json" }
});

const bearer = (req: Request) => {
  const h = req.headers.get("Authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};

function env(name: string): string {
  const value = Deno.env.get(name);
  if (value) return value.trim();

  const aliases: Record<string, string> = {
    SUPABASE_PUBLISHABLE_KEY: "SUPABASE_ANON_KEY",
    SUPABASE_SECRET_KEY: "SUPABASE_SERVICE_ROLE_KEY"
  };
  const alias = aliases[name];
  if (alias && Deno.env.get(alias)) return Deno.env.get(alias)!.trim();

  if (name === "SUPABASE_PUBLISHABLE_KEY") {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
      if (keys.default) return String(keys.default);
    } catch {}
  }
  if (name === "SUPABASE_SECRET_KEY") {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      if (keys.default) return String(keys.default);
    } catch {}
  }
  throw new Error("CONFIG_MISSING_" + name);
}

async function responseText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function safeMessage(raw: string): string {
  try {
    const x = JSON.parse(raw);
    return String(x?.message || x?.error_description || x?.error || x?.msg || "").slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map(x => x.toString(16).padStart(2, "0")).join("");
}

async function lazadaSign(path: string, params: URLSearchParams, secret: string): Promise<string> {
  const entries = Array.from(params.entries())
    .filter(([key, value]) => key !== "sign" && value !== "")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const base = path + entries.map(([key, value]) => key + value).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  return Array.from(signature).map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function rest(base: string, key: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", "Bearer " + key);
  headers.set("Content-Type", "application/json");
  return fetch(base + "/rest/v1/" + path, { ...init, headers });
}

async function rpc(base: string, key: string, name: string, body: unknown) {
  return rest(base, key, "rpc/" + name, { method: "POST", body: JSON.stringify(body) });
}

async function rpcAsUser(base: string, pub: string, token: string, name: string, body: unknown) {
  return fetch(base + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: pub,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function getUser(base: string, pub: string, token: string) {
  const res = await fetch(base + "/auth/v1/user", {
    headers: { apikey: pub, Authorization: "Bearer " + token }
  });
  return res.ok ? await res.json() : null;
}

async function resolveStore(base: string, pub: string, token: string, storeId: string, marketplaceId: string) {
  const res = await rpcAsUser(base, pub, token, "sellerbooks_resolve_store_for_oauth", {
    p_store_id: storeId,
    p_marketplace_id: marketplaceId,
    p_marketplace_name: "Lazada"
  });
  const raw = await responseText(res);
  let rows: any;
  try { rows = JSON.parse(raw); } catch {}
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!res.ok || !row?.resolved_store_id || String(row.resolved_marketplace_id).toLowerCase() !== "lazada") {
    throw new Error(safeMessage(raw) || "Akun toko Lazada tidak ditemukan, tidak aktif, atau marketplace tidak cocok.");
  }
  return { storeId: String(row.resolved_store_id), ownerId: String(row.resolved_owner_user_id || "") };
}

async function init(req: Request) {
  let base: string, pub: string, service: string;
  try {
    base = env("SUPABASE_URL");
    pub = env("SUPABASE_PUBLISHABLE_KEY");
    service = env("SUPABASE_SECRET_KEY");
  } catch (e) {
    return out({ ok: false, stage: "config", error: "Konfigurasi Supabase untuk OAuth Lazada belum lengkap." }, 503);
  }

  const appKey = Deno.env.get("LAZADA_APP_KEY")?.trim() || "";
  const appSecret = Deno.env.get("LAZADA_APP_SECRET")?.trim() || "";
  if (!appKey || !appSecret) {
    return out({
      ok: false,
      stage: "lazada_app_config",
      error: "Kredensial aplikasi Lazada belum tersedia. Selesaikan persetujuan kategori Business Intelligence, buat aplikasi Lazada, lalu konfigurasi LAZADA_APP_KEY dan LAZADA_APP_SECRET di Supabase."
    }, 503);
  }

  const token = bearer(req);
  if (!token) return out({ ok: false, stage: "session", error: "Sesi SellerBooks tidak tersedia. Silakan login kembali." }, 401);
  const user = await getUser(base, pub, token);
  if (!user?.id) return out({ ok: false, stage: "session", error: "Sesi SellerBooks tidak valid. Silakan login kembali." }, 401);

  const body = await req.json().catch(() => ({}));
  const requestedStoreId = String(body?.store_id || "").trim();
  const requestedMarketplaceId = String(body?.marketplace_id || "").trim();
  if (!requestedStoreId || !requestedMarketplaceId) {
    return out({ ok: false, stage: "request", error: "store_id dan marketplace_id wajib diisi." }, 400);
  }

  let store;
  try {
    store = await resolveStore(base, pub, token, requestedStoreId, requestedMarketplaceId);
  } catch (e) {
    return out({ ok: false, stage: "resolve_store", error: e instanceof Error ? e.message : "Akun toko Lazada tidak dapat diverifikasi." }, 400);
  }

  const connectionRes = await rpcAsUser(base, pub, token, "sellerbooks_api_upsert_connection", {
    p_store_id: store.storeId,
    p_marketplace_id: "lazada",
    p_marketplace: "Lazada"
  });
  const connectionRaw = await responseText(connectionRes);
  let connection: any = null;
  try { connection = JSON.parse(connectionRaw); } catch {}
  if (!connectionRes.ok || !connection?.id) {
    return out({ ok: false, stage: "upsert_connection", error: safeMessage(connectionRaw) || "Koneksi Lazada tidak dapat disiapkan." }, 400);
  }

  const state = crypto.randomUUID() + "." + crypto.randomUUID();
  const stateHash = await digest(state);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const stateRes = await rpc(base, service, "sellerbooks_api_create_oauth_state", {
    p_owner_user_id: user.id,
    p_store_id: store.storeId,
    p_connection_id: connection.id,
    p_state_hash: stateHash,
    p_expires_at: expiresAt
  });
  const stateRaw = await responseText(stateRes);
  if (!stateRes.ok) {
    return out({ ok: false, stage: "create_oauth_state", error: safeMessage(stateRaw) || "OAuth state Lazada gagal dibuat." }, 500);
  }

  const authorization = new URL(AUTH_BASE + "/oauth/authorize");
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("force_auth", "true");
  authorization.searchParams.set("redirect_uri", REDIRECT_URI);
  authorization.searchParams.set("client_id", appKey);
  authorization.searchParams.set("state", state);

  console.info(JSON.stringify({
    service: "sellerbooks-lazada-oauth",
    event: "authorization_url_created",
    user_id: user.id,
    store_id: store.storeId,
    connection_id: connection.id
  }));

  return out({
    ok: true,
    connection_id: connection.id,
    authorization_url: authorization.toString(),
    expires_at: expiresAt
  });
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const callbackPage = new URL("lazada-oauth-callback.html", APP_URL);
  const fail = (reason: string) => {
    const target = new URL(callbackPage);
    target.searchParams.set("sellerbooks_lazada_oauth", "error");
    target.searchParams.set("reason", reason);
    return Response.redirect(target.toString(), 302);
  };

  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  if (url.searchParams.get("error")) return fail("SELLER_AUTHORIZATION_DENIED");
  if (!code || !state) return fail("AUTHORIZATION_RESPONSE_INCOMPLETE");

  let base: string, service: string;
  try {
    base = env("SUPABASE_URL");
    service = env("SUPABASE_SECRET_KEY");
  } catch {
    return fail("SUPABASE_CONFIGURATION_MISSING");
  }

  const appKey = Deno.env.get("LAZADA_APP_KEY")?.trim() || "";
  const appSecret = Deno.env.get("LAZADA_APP_SECRET")?.trim() || "";
  if (!appKey || !appSecret) return fail("LAZADA_APP_CREDENTIALS_MISSING");

  try {
    const params = new URLSearchParams({
      app_key: appKey,
      timestamp: String(Date.now()),
      sign_method: "sha256",
      code
    });
    params.set("sign", await lazadaSign(TOKEN_PATH, params, appSecret));

    const tokenResponse = await fetch(AUTH_BASE + "/rest" + TOKEN_PATH + "?" + params.toString(), {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    const tokenRaw = await responseText(tokenResponse);
    let tokenData: any = null;
    try { tokenData = JSON.parse(tokenRaw); } catch {}

    if (!tokenResponse.ok || !tokenData?.access_token || (tokenData?.code !== undefined && String(tokenData.code) !== "0")) {
      console.error(JSON.stringify({
        service: "sellerbooks-lazada-oauth",
        event: "token_exchange_failed",
        status: tokenResponse.status,
        upstream_message: safeMessage(tokenRaw)
      }));
      return fail("TOKEN_EXCHANGE_FAILED");
    }

    const stateRes = await rpc(base, service, "sellerbooks_api_consume_oauth_state", {
      p_state_hash: await digest(state)
    });
    const stateRaw = await responseText(stateRes);
    let stateRows: any = null;
    try { stateRows = JSON.parse(stateRaw); } catch {}
    const stateRow = Array.isArray(stateRows) ? stateRows[0] : null;
    if (!stateRes.ok || !stateRow?.connection_id || !stateRow?.store_id || !stateRow?.owner_user_id) {
      return fail("STATE_INVALID_OR_EXPIRED");
    }

    const sellerInfo = Array.isArray(tokenData.country_user_info)
      ? tokenData.country_user_info[0]
      : Array.isArray(tokenData.country_user_info_list)
        ? tokenData.country_user_info_list[0]
        : (tokenData.country_user_info || tokenData.country_user_info_list || {});
    const sellerId = String(
      sellerInfo?.seller_id || sellerInfo?.user_id || tokenData?.account_id || tokenData?.account || ""
    ).trim();
    if (!sellerId) return fail("SELLER_ID_MISSING");

    const credential = {
      provider: "lazada",
      auth_type: "oauth",
      app_key: appKey,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || "",
      expires_in: Number(tokenData.expires_in || 0),
      refresh_expires_in: Number(tokenData.refresh_expires_in || 0),
      token_received_at: new Date().toISOString(),
      country: tokenData.country || sellerInfo?.country || "",
      account: tokenData.account || "",
      account_platform: tokenData.account_platform || "seller_center",
      seller_id: sellerId,
      country_user_info: tokenData.country_user_info || tokenData.country_user_info_list || []
    };

    const complete = await rpc(base, service, "sellerbooks_api_complete_lazada_oauth", {
      p_connection_id: stateRow.connection_id,
      p_store_id: stateRow.store_id,
      p_seller_id: sellerId,
      p_credential: JSON.stringify(credential)
    });
    const completeRaw = await responseText(complete);
    if (!complete.ok) {
      console.error(JSON.stringify({
        service: "sellerbooks-lazada-oauth",
        event: "connection_finalization_failed",
        connection_id: stateRow.connection_id,
        status: complete.status,
        detail: safeMessage(completeRaw)
      }));
      return fail("CONNECTION_FINALIZATION_FAILED");
    }

    const success = new URL(callbackPage);
    success.searchParams.set("sellerbooks_lazada_oauth", "success");
    success.searchParams.set("connection_id", stateRow.connection_id);
    success.searchParams.set("seller_id", sellerId);
    return Response.redirect(success.toString(), 302);
  } catch (error) {
    console.error(JSON.stringify({
      service: "sellerbooks-lazada-oauth",
      event: "callback_failed",
      error: error instanceof Error ? error.message : "UNKNOWN"
    }));
    return fail("OAUTH_CALLBACK_FAILED");
  }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const action = new URL(req.url).searchParams.get("action");
    if (req.method === "POST" && (action === "init" || !action)) return await init(req);
    if (req.method === "GET" && action === "callback") return await callback(req);
    return out({ ok: false, error: "Invalid Lazada OAuth action." }, 400);
  } catch (error) {
    console.error(JSON.stringify({
      service: "sellerbooks-lazada-oauth",
      event: "request_failed",
      error: error instanceof Error ? error.message : "UNKNOWN"
    }));
    return out({ ok: false, stage: "request", error: "OAuth Lazada mengalami kesalahan konfigurasi." }, 500);
  }
});
