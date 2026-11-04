import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const API_BASE = "https://open-api.tiktokglobalshop.com";
const APP_KEY = Deno.env.get("TIKTOK_SHOP_APP_KEY") || "";

const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const bearer = (req: Request) => {
  const value = req.headers.get("Authorization") || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
};

const authenticate = async (token: string, apiKey: string) => {
  const result = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: apiKey, Authorization: "Bearer " + token },
  });
  return result.ok ? await result.json() : null;
};

const rest = (key: string, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", "Bearer " + key);
  headers.set("Content-Type", "application/json");
  return fetch(SUPABASE_URL + "/rest/v1/" + path, { ...init, headers });
};

const hmac = async (key: string, value: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)),
  );
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const tiktokGet = async (
  credential: Record<string, unknown>,
  path: string,
  query: Record<string, string>,
) => {
  const secret = Deno.env.get("TIKTOK_SHOP_APP_SECRET");
  if (!secret) throw new Error("TIKTOK_SHOP_APP_SECRET_MISSING");

  const params: Record<string, string> = {
    ...query,
    app_key: String(credential.app_key || APP_KEY),
    timestamp: String(Math.floor(Date.now() / 1000)),
    shop_cipher: String(credential.shop_cipher || ""),
  };
  const canonical = path + Object.keys(params).sort().map((key) => key + params[key]).join("");
  params.sign = await hmac(secret, secret + canonical + secret);

  const url = new URL(String(credential.api_base_url || API_BASE).replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const result = await fetch(url, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "x-tts-access-token": String(credential.access_token || ""),
    },
  });
  const raw = await result.text();
  let payload: any;
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  if (!result.ok || Number(payload?.code ?? -1) !== 0) {
    throw new Error("TIKTOK_FINANCE_API_ERROR:" + String(payload?.message || result.status));
  }
  return payload;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return response({ ok: false, error: "Method not allowed" }, 405);

  try {
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const publishableKey = publishableKeys.default;
    const serviceKey = secretKeys.default;
    if (!publishableKey || !serviceKey) {
      return response({ ok: false, error: "Supabase configuration unavailable" }, 500);
    }

    const token = bearer(req);
    if (!token) return response({ ok: false, error: "Authentication required" }, 401);
    const user = await authenticate(token, publishableKey);
    if (!user?.id) return response({ ok: false, error: "Invalid session" }, 401);

    const body = await req.json().catch(() => ({}));
    const connectionId = String(body.connection_id || "").trim();
    const storeId = String(body.store_id || "").trim();
    const orderId = String(body.order_id || "").trim();
    if (!connectionId || !storeId || !orderId) {
      return response({
        ok: false,
        error: "connection_id, store_id, and order_id are required",
      }, 400);
    }

    const connectionResult = await rest(
      serviceKey,
      "sellerbooks_api_connections?id=eq." + encodeURIComponent(connectionId) +
        "&store_id=eq." + encodeURIComponent(storeId) +
        "&owner_user_id=eq." + encodeURIComponent(String(user.id)) +
        "&marketplace=eq.TikTok%20Shop&select=*",
    );
    if (!connectionResult.ok) {
      return response({ ok: false, error: "CONNECTION_LOOKUP_FAILED" }, 500);
    }
    const connections = await connectionResult.json();
    const connection = Array.isArray(connections) ? connections[0] : null;
    if (!connection) return response({ ok: false, error: "CONNECTION_NOT_OWNED_OR_FOUND" }, 403);
    if (connection.connection_status !== "CONNECTED") {
      return response({ ok: false, error: "CONNECTION_NOT_CONNECTED" }, 409);
    }
    if (!connection.vault_secret_id) {
      return response({ ok: false, error: "TIKTOK_CREDENTIAL_VAULT_ID_MISSING" }, 409);
    }

    const credentialResult = await rest(serviceKey, "rpc/sellerbooks_tiktok_read_credential", {
      method: "POST",
      body: JSON.stringify({ p_connection_id: connection.id }),
    });
    if (!credentialResult.ok) {
      return response({ ok: false, error: "TIKTOK_CREDENTIAL_STORE_READ_ERROR" }, 500);
    }
    const credential = await credentialResult.json();
    if (!credential?.access_token || !credential?.shop_cipher) {
      return response({ ok: false, error: "TIKTOK_CREDENTIAL_INCOMPLETE" }, 409);
    }

    // Final, SKU-level settled transaction lookup. This endpoint is documented for all regions.
    let settled: any = null;
    let settledError: string | null = null;
    try {
      settled = await tiktokGet(
        credential,
        "/finance/202501/orders/" + encodeURIComponent(orderId) + "/statement_transactions",
        {},
      );
    } catch (error) {
      settledError = error instanceof Error ? error.message : String(error);
    }

    // Estimated unsettled transaction lookup. Estimates are explicitly not final settlement values.
    let unsettled: any = null;
    let unsettledError: string | null = null;
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = Number(body.search_time_ge || now - 14 * 86400);
      const to = Number(body.search_time_lt || now + 60);
      unsettled = await tiktokGet(
        credential,
        "/finance/202507/orders/unsettled",
        {
          page_size: "100",
          sort_field: "order_create_time",
          sort_order: "DESC",
          search_time_ge: String(from),
          search_time_lt: String(to),
        },
      );
    } catch (error) {
      unsettledError = error instanceof Error ? error.message : String(error);
    }

    const unsettledTransactions = Array.isArray(unsettled?.data?.transactions)
      ? unsettled.data.transactions
      : [];
    const matchingUnsettled = unsettledTransactions.filter((item: any) =>
      String(item?.order_id || item?.adjustment_order_id || "") === orderId
    );

    return response({
      ok: true,
      mode: "READ_ONLY_FINANCE_AUDIT",
      marketplace: "TikTok Shop",
      order_id: orderId,
      connection_id: connection.id,
      settled_lookup: settled
        ? { found: true, data: settled.data ?? null, request_id: settled.request_id ?? null }
        : { found: false, error: settledError },
      unsettled_lookup: unsettled
        ? {
          found: matchingUnsettled.length > 0,
          total_count_in_page: unsettledTransactions.length,
          matching_transactions: matchingUnsettled,
          next_page_available: Boolean(unsettled?.data?.next_page_token),
          estimated_totals: {
            settlement: unsettled?.data?.sum_est_settlement_amount ?? null,
            revenue: unsettled?.data?.sum_est_revenue_amount ?? null,
            fees: unsettled?.data?.sum_est_fee_amount ?? null,
            adjustments: unsettled?.data?.sum_est_adjustment_amount ?? null,
          },
        }
        : { found: false, error: unsettledError },
      note: "Read-only audit only. No sales, import queue, HPP, profit, refund, or snapshot data was modified. Unsettled values are estimates; settled values must come from statement transactions.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 500);
  }
});
