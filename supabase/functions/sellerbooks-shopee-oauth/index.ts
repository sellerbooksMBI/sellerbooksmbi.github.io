import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

// Sandbox is the safe default. Live credentials are isolated from Sandbox credentials.
const SHOPEE_ENVIRONMENT = String(Deno.env.get("SHOPEE_ENVIRONMENT") || "sandbox").trim().toLowerCase();
if (SHOPEE_ENVIRONMENT !== "sandbox" && SHOPEE_ENVIRONMENT !== "production") {
  throw new Error("SHOPEE_ENVIRONMENT must be sandbox or production");
}
const IS_SHOPEE_PRODUCTION = SHOPEE_ENVIRONMENT === "production";
const HOST = (Deno.env.get(IS_SHOPEE_PRODUCTION ? "SHOPEE_LIVE_API_BASE_URL" : "SHOPEE_SANDBOX_API_BASE_URL")
  || (!IS_SHOPEE_PRODUCTION ? Deno.env.get("SHOPEE_API_BASE_URL") : null)
  || (IS_SHOPEE_PRODUCTION ? "https://partner.shopeemobile.com" : "https://partner.test-stable.shopeemobile.com")).replace(/\/$/, "");
const AUTH_HOST = IS_SHOPEE_PRODUCTION
  ? "https://partner.shopeemobile.com"
  : "https://openplatform.sandbox.test-stable.shopee.sg";
const TOKEN_HOST = IS_SHOPEE_PRODUCTION ? HOST : AUTH_HOST;
function shopeePartnerCredentials() {
  const idName = IS_SHOPEE_PRODUCTION ? "SHOPEE_LIVE_PARTNER_ID" : "SHOPEE_PARTNER_ID";
  const keyName = IS_SHOPEE_PRODUCTION ? "SHOPEE_LIVE_PARTNER_KEY" : "SHOPEE_PARTNER_KEY";
  const partnerId = Deno.env.get(idName);
  const partnerKey = Deno.env.get(keyName);
  if (!partnerId || !partnerKey) throw new Error("CONFIG_MISSING_" + (!partnerId ? idName : keyName));
  return { partnerId: Number(partnerId), partnerKey };
}
const REDIRECT_URI = Deno.env.get("SHOPEE_OAUTH_REDIRECT_URI") || "https://vrgiwzxwnfjhpmxcahwo.supabase.co/functions/v1/sellerbooks-shopee-oauth?action=callback";
const APP_URL = (Deno.env.get("SELLERBOOKS_APP_URL") || "https://sellerbooksmbi.github.io/").replace(/\/?$/, "/");
const AUTH_PATH = "/api/v2/shop/auth_partner";
const TOKEN_PATH = "/api/v2/auth/token/get";
const INFO_PATH = "/api/v2/shop/get_shop_info";

const out = (x: any, s = 200) => new Response(JSON.stringify(x), {
  status: s,
  headers: { ...CORS, "Content-Type": "application/json" }
});

const bearer = (r: Request) => {
  const h = r.headers.get("Authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};

const hex = (b: Uint8Array) =>
  Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");

async function digest(s: string) {
  return hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  ));
}

async function hmac(k: string, m: string) {
  const x = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(k),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return hex(new Uint8Array(
    await crypto.subtle.sign("HMAC", x, new TextEncoder().encode(m))
  ));
}

const env = (n: string) => {
  const v = Deno.env.get(n);
  if (v) return v;

  const aliases: any = {
    SUPABASE_PUBLISHABLE_KEY: "SUPABASE_ANON_KEY",
    SUPABASE_SECRET_KEY: "SUPABASE_SERVICE_ROLE_KEY"
  };

  const a = aliases[n];
  if (a && Deno.env.get(a)) return Deno.env.get(a)!;

  if (n === "SUPABASE_PUBLISHABLE_KEY") {
    try {
      const x = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
      if (x.default) return x.default;
    } catch {}
  }

  if (n === "SUPABASE_SECRET_KEY") {
    try {
      const x = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      if (x.default) return x.default;
    } catch {}
  }

  throw Error("CONFIG_MISSING_" + n);
};

async function rest(
  base: string,
  key: string,
  path: string,
  init: RequestInit = {}
) {
  const h = new Headers(init.headers);
  h.set("apikey", key);
  h.set("Authorization", "Bearer " + key);
  h.set("Content-Type", "application/json");

  return fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: h
  });
}

async function rpc(base: string, key: string, fn: string, body: any) {
  return rest(base, key, "rpc/" + fn, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function rpcAsUser(
  base: string,
  pub: string,
  token: string,
  fn: string,
  body: any
) {
  return fetch(base + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      apikey: pub,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function user(base: string, key: string, t: string) {
  const r = await fetch(base + "/auth/v1/user", {
    headers: {
      apikey: key,
      Authorization: "Bearer " + t
    }
  });

  return r.ok ? r.json() : null;
}

async function responseText(r: Response) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function safeUpstream(raw: string) {
  try {
    const x = JSON.parse(raw);
    return String(
      x?.message || x?.hint || x?.error_description || x?.error || ""
    );
  } catch {
    return "";
  }
}

function isWrongSign(raw: string) {
  try {
    const x = JSON.parse(raw);
    const values = [
      x?.error,
      x?.message,
      x?.error_code,
      x?.error_description
    ]
      .filter((v: any) => typeof v === "string" || typeof v === "number")
      .map((v: any) => String(v).toLowerCase());

    return values.some(
      (v: string) =>
        v.includes("wrong sign") ||
        v === "error_sign" ||
        v.includes("invalid sign")
    );
  } catch {
    return false;
  }
}

function safeUpstreamMeta(raw: string) {
  try {
    const x = JSON.parse(raw);
    const r: any = {};

    for (const k of [
      "request_id",
      "error",
      "message",
      "error_description",
      "error_code",
      "code"
    ]) {
      const v = x?.[k];
      if (typeof v === "string" || typeof v === "number") {
        r[k] = String(v).slice(0, 300);
      }
    }

    return r;
  } catch {
    return {};
  }
}

async function resolveOAuthStore(
  base: string,
  pub: string,
  token: string,
  storeId: string,
  marketplaceId: string,
  marketplaceName: string
) {
  const r = await fetch(
    base + "/rest/v1/rpc/sellerbooks_resolve_store_for_oauth",
    {
      method: "POST",
      headers: {
        apikey: pub,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_store_id: storeId,
        p_marketplace_id: marketplaceId,
        p_marketplace_name: marketplaceName
      })
    }
  );

  const raw = await responseText(r);
  let rows: any[] = [];

  try {
    rows = JSON.parse(raw);
  } catch {}

  const row = Array.isArray(rows) ? rows[0] : rows;

  if (!r.ok || !row?.resolved_store_id) {
    let msg = "";

    try {
      const x = JSON.parse(raw);
      msg = String(x?.message || x?.hint || x?.details || "");
    } catch {}

    throw new Error(msg || "Akun toko tidak ditemukan atau tidak aktif.");
  }

  return {
    store_id: String(row.resolved_store_id),
    marketplace_id: String(row.resolved_marketplace_id),
    marketplace: String(row.resolved_marketplace_name || marketplaceName || "")
  };
}

async function init(r: Request) {
  const base = env("SUPABASE_URL");
  const pub = env("SUPABASE_PUBLISHABLE_KEY");
  const secret = env("SUPABASE_SECRET_KEY");
  const { partnerId: pid, partnerKey: rawPkey } = shopeePartnerCredentials();
  if (!Number.isFinite(pid) || pid <= 0) throw new Error("CONFIG_INVALID_SHOPEE_PARTNER_ID");
  const pkey = rawPkey.replace(/^shpk/i, "");
  const redirect = REDIRECT_URI;

  if (!Number.isFinite(pid) || pid <= 0) {
    return out({
      ok: false,
      error: "SHOPEE_PARTNER_ID belum valid.",
      stage: "config"
    }, 500);
  }

  if (!pkey) {
    return out({
      ok: false,
      error: "SHOPEE_PARTNER_KEY belum tersedia.",
      stage: "config"
    }, 500);
  }

  const token = bearer(r);
  const u = await user(base, pub, token);

  if (!u?.id) {
    return out({
      ok: false,
      error: "Sesi SellerBooks tidak valid. Silakan login kembali.",
      stage: "session"
    }, 401);
  }

  const b = await r.json().catch(() => ({}));
  const store = String(b.store_id || "").trim();
  const mid = String(b.marketplace_id || "").trim();

  if (!store || !mid) {
    return out({
      ok: false,
      error: "store_id dan marketplace_id wajib.",
      stage: "request"
    }, 400);
  }

  let resolved;

  try {
    resolved = await resolveOAuthStore(
      base, pub, token, store, mid, "Shopee"
    );
  } catch (e) {
    return out({
      ok: false,
      error: e instanceof Error
        ? e.message
        : "Akun toko tidak ditemukan atau tidak aktif.",
      stage: "resolve_store"
    }, 400);
  }

  const q = await rpcAsUser(
    base,
    pub,
    token,
    "sellerbooks_api_upsert_connection",
    {
      p_store_id: resolved.store_id,
      p_marketplace_id: resolved.marketplace_id,
      p_marketplace: "Shopee"
    }
  );

  const qraw = await responseText(q);
  let c: any = null;

  try {
    c = JSON.parse(qraw);
  } catch {}

  if (!q.ok || !c?.id) {
    const detail = safeUpstream(qraw);

    console.error(JSON.stringify({
      service: "sellerbooks-shopee-oauth",
      event: "init_upsert_failed",
      user_id: u.id,
      store_id: store,
      marketplace_id: mid,
      status: q.status,
      detail
    }));

    return out({
      ok: false,
      error: detail || "Koneksi Shopee tidak dapat dibuat.",
      stage: "upsert_connection",
      status: q.status
    }, 400);
  }

  const raw = crypto.randomUUID() + "." + crypto.randomUUID();
  const hash = await digest(raw);
  const expires = new Date(Date.now() + 600000).toISOString();

  const s = await rpc(
    base,
    secret,
    "sellerbooks_api_create_oauth_state",
    {
      p_owner_user_id: u.id,
      p_store_id: resolved.store_id,
      p_connection_id: c.id,
      p_state_hash: hash,
      p_expires_at: expires
    }
  );

  const sraw = await responseText(s);

  if (!s.ok) {
    const detail = safeUpstream(sraw);

    console.error(JSON.stringify({
      service: "sellerbooks-shopee-oauth",
      event: "init_state_failed",
      user_id: u.id,
      store_id: store,
      connection_id: c.id,
      status: s.status,
      detail
    }));

    return out({
      ok: false,
      error: detail || "OAuth state gagal dibuat.",
      stage: "create_oauth_state",
      status: s.status
    }, 500);
  }

  const ts = Math.floor(Date.now() / 1000);
  const authRedirect = new URL(redirect);
  authRedirect.searchParams.set("state", raw);

  const authSign = await hmac(
    rawPkey,
    String(pid) + AUTH_PATH + ts
  );

  const a = new URL(AUTH_HOST + AUTH_PATH);
  a.searchParams.set("partner_id", String(pid));
  a.searchParams.set("timestamp", String(ts));
  a.searchParams.set("sign", authSign);
  a.searchParams.set("redirect", authRedirect.toString());

  console.log(JSON.stringify({
    service: "sellerbooks-shopee-oauth",
    event: "authorization_url_created",
    user_id: u.id,
    store_id: store,
    connection_id: c.id
  }));

  return out({
    ok: true,
    connection_id: c.id,
    authorization_url: a.toString(),
    expires_at: expires
  });
}

async function callback(r: Request) {
  const base = env("SUPABASE_URL");
  const secret = env("SUPABASE_SECRET_KEY");
  const { partnerId: pid, partnerKey: rawPkey } = shopeePartnerCredentials();
  if (!Number.isFinite(pid) || pid <= 0) throw new Error("CONFIG_INVALID_SHOPEE_PARTNER_ID");
  const pkey = rawPkey.replace(/^shpk/i, "");
  const callbackPage = new URL("shopee-oauth-callback.html", APP_URL).toString();
  const u = new URL(r.url);

  const state = String(u.searchParams.get("state") || "");
  const code = String(u.searchParams.get("code") || "");
  const shop = String(u.searchParams.get("shop_id") || "");

  const fail = (x: string) => {
    const z = new URL(callbackPage);
    z.searchParams.set("sellerbooks_shopee_oauth", "error");
    z.searchParams.set("reason", x);
    return Response.redirect(z.toString(), 302);
  };

  if (!code || !shop) {
    return fail("AUTHORIZATION_RESPONSE_INCOMPLETE");
  }

  try {
    const sid = Number(shop);

    if (!Number.isFinite(sid) || sid <= 0) {
      return fail("INVALID_SHOP_ID");
    }

    const ts = Math.floor(Date.now() / 1000);

    console.info(JSON.stringify({
      service: "sellerbooks-shopee-oauth",
      event: "token_sign_diagnostics",
      partner_id: pid,
      token_path: TOKEN_PATH,
      environment: SHOPEE_ENVIRONMENT,
      host: HOST,
      timestamp: ts,
      partner_key_raw_length: rawPkey.length,
      partner_key_length: pkey.length,
      partner_key_has_shpk_prefix: /^shpk/i.test(rawPkey),
      partner_key_has_outer_whitespace: rawPkey !== rawPkey.trim()
    }));

    const tokenBase = String(pid) + TOKEN_PATH + ts;
    const tokenUrl = new URL(TOKEN_HOST + TOKEN_PATH);

    tokenUrl.searchParams.set("partner_id", String(pid));
    tokenUrl.searchParams.set("timestamp", String(ts));

    // The OAuth authorization flow has already accepted the configured key.
    // Use that exact key first; if the legacy Sandbox gateway rejects the signature,
    // retry once against Shopee's documented Sandbox Open Platform host.
    let signMode = "configured-key";
    let signingKey = rawPkey;
    tokenUrl.searchParams.set("sign", await hmac(signingKey, tokenBase));

    const tokenBody = JSON.stringify({
      code,
      partner_id: pid,
      shop_id: sid
    });

    const exchange = async (target: URL, key: string) => {
      target.searchParams.set("sign", await hmac(key, tokenBase));
      const response = await fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: tokenBody
      });
      const raw = await responseText(response);
      let data: any = null;
      try { data = JSON.parse(raw); } catch {}
      return { response, raw, data };
    };

    let attempt = await exchange(tokenUrl, signingKey);
    let tr = attempt.response;
    let traw = attempt.raw;
    let td: any = attempt.data;

    // Sandbox credentials may be supplied with the "shpk" display prefix.
    // If the first signature is rejected, retry once with the normalized key
    // before changing endpoint hosts. Never log or return either key.
    if ((!tr.ok || td?.error || !td?.access_token) && isWrongSign(traw) && pkey !== rawPkey) {
      signingKey = pkey;
      signMode = "normalized-key";
      attempt = await exchange(new URL(TOKEN_HOST + TOKEN_PATH), signingKey);
      tr = attempt.response;
      traw = attempt.raw;
      td = attempt.data;
    }

    if (!IS_SHOPEE_PRODUCTION && (!tr.ok || td?.error || !td?.access_token) && isWrongSign(traw) && TOKEN_HOST !== AUTH_HOST) {
      signMode += "-alternate-sandbox-host";
      attempt = await exchange(new URL(AUTH_HOST + TOKEN_PATH), signingKey);
      tr = attempt.response;
      traw = attempt.raw;
      td = attempt.data;
    }

    if (!tr.ok || td?.error || !td?.access_token) {
      console.error(JSON.stringify({
        service: "sellerbooks-shopee-oauth",
        event: "token_exchange_failed",
        shop_id: sid,
        status: tr.status,
        detail: safeUpstream(traw),
        upstream_meta: safeUpstreamMeta(traw),
        signature_key_mode: signMode
      }));

      return fail("TOKEN_EXCHANGE_FAILED");
    }

    console.info(JSON.stringify({
      service: "sellerbooks-shopee-oauth",
      event: "token_exchange_succeeded",
      shop_id: sid,
      signature_key_mode: signMode
    }));

    const its = Math.floor(Date.now() / 1000);
    // Token exchange succeeded with the configured Sandbox key; use that same
    // key consistently for the shop-scoped verification signature.
    const isign = await hmac(
      signingKey,
      String(pid) + INFO_PATH + its + td.access_token + sid
    );

    const iu = new URL(AUTH_HOST + INFO_PATH);

    for (const [k, v] of Object.entries({
      partner_id: pid,
      timestamp: its,
      access_token: td.access_token,
      shop_id: sid,
      sign: isign
    })) {
      iu.searchParams.set(k, String(v));
    }

    const ir = await fetch(iu);
    const iraw = await responseText(ir);
    let info: any = null;

    try {
      info = JSON.parse(iraw);
    } catch {}

    if (!ir.ok || info?.error) {
      console.error(JSON.stringify({
        service: "sellerbooks-shopee-oauth",
        event: "shop_verify_failed",
        shop_id: sid,
        status: ir.status,
        detail: safeUpstream(iraw)
      }));

      return fail("SHOP_VERIFY_FAILED");
    }

    const verified = String(info?.response?.shop_id ?? sid);

    if (verified !== String(sid)) {
      return fail("SHOP_ID_VERIFY_MISMATCH");
    }

    let st: any = null;

    if (state) {
      const c = await rpc(
        base,
        secret,
        "sellerbooks_api_consume_oauth_state",
        {
          p_state_hash: await digest(state)
        }
      );

      const craw = await responseText(c);
      let rows: any[] = [];

      try {
        rows = JSON.parse(craw);
      } catch {}

      st = rows?.[0] || null;
    }

    if (!st?.connection_id) {
      console.error(JSON.stringify({
        service: "sellerbooks-shopee-oauth",
        event: "state_resolution_failed",
        shop_id: verified
      }));

      return fail("STATE_INVALID_OR_EXPIRED");
    }

    const credential = JSON.stringify({
      provider: "shopee",
      auth_type: "oauth",
      partner_id: pid,
      partner_key: signingKey,
      shop_id: sid,
      access_token: td.access_token,
      refresh_token: td.refresh_token || "",
      expire_in: td.expire_in || null,
      token_received_at: new Date().toISOString(),
      api_base_url: HOST,
      environment: SHOPEE_ENVIRONMENT
    });

    const done = await rpc(
      base,
      secret,
      "sellerbooks_api_complete_shopee_oauth",
      {
        p_connection_id: st.connection_id,
        p_store_id: st.store_id,
        p_shop_id: verified,
        p_credential: credential,
        p_shop_name: info?.response?.shop_name || null
      }
    );

    if (!done.ok) {
      const draw = await responseText(done);

      console.error(JSON.stringify({
        service: "sellerbooks-shopee-oauth",
        event: "connection_finalization_failed",
        connection_id: st.connection_id,
        shop_id: verified,
        status: done.status,
        detail: safeUpstream(draw)
      }));

      return fail("CONNECTION_FINALIZATION_FAILED");
    }

    const ok = new URL(callbackPage);
    ok.searchParams.set("sellerbooks_shopee_oauth", "success");
    ok.searchParams.set("connection_id", st.connection_id);
    ok.searchParams.set("shop_id", verified);

    return Response.redirect(ok.toString(), 302);
  } catch (e) {
    console.error(JSON.stringify({
      service: "sellerbooks-shopee-oauth",
      event: "callback_failed",
      error: e instanceof Error ? e.message : "UNKNOWN"
    }));

    return fail("OAUTH_FAILED");
  }
}

Deno.serve(async r => {
  if (r.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const a = new URL(r.url).searchParams.get("action");

    if (r.method === "POST" && (a === "init" || !a)) {
      return await init(r);
    }

    if (r.method === "GET" && a === "callback") {
      return await callback(r);
    }

    return out({ ok: false, error: "Invalid OAuth action." }, 400);
  } catch (e) {
    console.error(JSON.stringify({
      service: "sellerbooks-shopee-oauth",
      event: "request_failed",
      error: e instanceof Error ? e.message : "UNKNOWN"
    }));

    return out({
      ok: false,
      error: "OAuth service configuration error.",
      stage: "request"
    }, 500);
  }
});