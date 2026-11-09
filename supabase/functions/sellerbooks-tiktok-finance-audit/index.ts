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


const tiktokPost = async (
  credential: Record<string, unknown>,
  path: string,
  query: Record<string, string>,
  body: Record<string, unknown>,
) => {
  const secret = Deno.env.get("TIKTOK_SHOP_APP_SECRET");
  if (!secret) throw new Error("TIKTOK_SHOP_APP_SECRET_MISSING");
  const params: Record<string, string> = {
    ...query,
    app_key: String(credential.app_key || APP_KEY),
    timestamp: String(Math.floor(Date.now() / 1000)),
    shop_cipher: String(credential.shop_cipher || ""),
  };
  const bodyText = JSON.stringify(body);
  const canonical = path + Object.keys(params).sort().map((key) => key + params[key]).join("") + bodyText;
  params.sign = await hmac(secret, secret + canonical + secret);
  const url = new URL(String(credential.api_base_url || API_BASE).replace(/\/$/, "") + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const result = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tts-access-token": String(credential.access_token || "") },
    body: bodyText,
  });
  const raw = await result.text();
  let payload: any;
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  if (!result.ok || Number(payload?.code ?? -1) !== 0) {
    throw new Error("TIKTOK_AFFILIATE_API_ERROR:" + String(payload?.message || result.status));
  }
  return payload;
};

const parseAffiliateMoney = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value);
  const digits = String(value).replace(/[^0-9]/g, "");
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeAmount = (value: unknown): number => {
  if (value === null || value === undefined || value === "" || value === "-") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};
const readPath = (root: any, path: string): unknown =>
  path.split(".").reduce((value: any, key) => value && typeof value === "object" ? value[key] : undefined, root);
const sumAffiliatePath = (rows: any[], path: string) => {
  const matches = rows.map((row) => readPath(row, path))
    .filter((value) => value !== undefined && value !== null && value !== "");
  return { found: matches.length > 0, amount: matches.reduce((sum, value) => sum + normalizeAmount(value), 0) };
};
const extractAffiliateCommission = (data: any) => {
  /*
   * TikTok uses different property names across Finance endpoints:
   * Unsettled (202507): affiliate_commission_before_pit_amount
   * Order statement (202501): affiliate_commission_amount_before_pit
   * Standard creator fee on both: affiliate_commission_amount
   *
   * Do not mix in affiliate_ads_commission_amount or
   * affiliate_partner_commission_amount: those are different fee categories.
   */
  const orderRows = Array.isArray(data?.transactions) ? data.transactions : (data?.order_id ? [data] : []);
  const skuRows = Array.isArray(data?.sku_transactions) ? data.sku_transactions : [];
  const paths = [
    "fee_tax_breakdown.fee.affiliate_commission_amount",
    "fee_tax_breakdown.fee.affiliate_commission_before_pit_amount",
    "fee_tax_breakdown.fee.affiliate_commission_amount_before_pit",
  ];
  const values = paths.map((path) => {
    const skuValue = sumAffiliatePath(skuRows, path);
    const orderValue = sumAffiliatePath(orderRows, path);
    const selected = skuValue.found ? skuValue : orderValue;
    return { path, ...selected };
  });
  const primary = values[0];
  const positive = values.find((item) => item.found && item.amount !== 0);
  const selected = positive || values.find((item) => item.found) || primary;
  return {
    found: selected.found,
    amount: selected.found ? selected.amount : null,
    source_field: selected.path,
    diagnostic: Object.fromEntries(values.map((item) => [
      item.path.split(".").pop(),
      item.found ? item.amount : null,
    ])),
  };
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

    /*
     * Use Search Seller Affiliate Orders as the source of truth for creator
     * affiliate eligibility and commission. Finance statement APIs may return
     * zero for orders that have not settled yet.
     *
     * The order timestamp is used only to form a narrow query window because
     * TikTok limits each search to 3 months. Eligibility is matched by exact
     * Order ID only, not by date.
     */
    const rawCreateTime = Number(body.order_create_time || 0);
    const createTime = Number.isFinite(rawCreateTime) ? Math.floor(rawCreateTime) : 0;
    const windowStart = createTime > 0 ? Math.max(0, createTime - 86400) : Math.floor(Date.now() / 1000) - 90 * 86400;
    const windowEnd = createTime > 0 ? createTime + 86400 : Math.floor(Date.now() / 1000) + 60;
    let pageToken = "";
    let pagesScanned = 0;
    let totalCount: number | null = null;
    let exactOrder: any = null;
    let searchError: string | null = null;
    let paginationComplete = false;
    try {
      for (let page = 0; page < 100; page++) {
        const query: Record<string, string> = { page_size: "100" };
        if (pageToken) query.page_token = pageToken;
        const payload = await tiktokPost(
          credential,
          "/affiliate_seller/202410/orders/search",
          query,
          { create_time_ge: windowStart, create_time_lt: windowEnd },
        );
        pagesScanned++;
        const data = payload?.data || {};
        if (totalCount === null && Number.isFinite(Number(data?.total_count))) totalCount = Number(data.total_count);
        const orders = Array.isArray(data?.orders) ? data.orders : [];
        exactOrder = orders.find((row: any) => String(row?.id || "").trim() === orderId) || exactOrder;
        if (exactOrder) break;
        pageToken = String(data?.next_page_token || payload?.next_page_token || "");
        if (!pageToken) { paginationComplete = true; break; }
      }
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error);
    }

    if (searchError || (!exactOrder && !paginationComplete)) {
      return response({
        ok: true,
        mode: "TIKTOK_SELLER_AFFILIATE_ORDERS",
        marketplace: "TikTok Shop",
        order_id: orderId,
        affiliate_commission: { found: false, amount: null, source_mode: "SELLER_AFFILIATE_ORDERS",
          source_field: "estimated_paid_commission/actual_paid_commission", status: "PENDING_DATA" },
        lookup: { order_found: false, fee_field_confirmed: false, pages_scanned: pagesScanned,
          pagination_complete: paginationComplete, total_count: totalCount,
          error: searchError || "AFFILIATE_SEARCH_NOT_FULLY_PAGINATED" },
      });
    }

    const skuRows = Array.isArray(exactOrder?.skus) ? exactOrder.skus : [];
    let commissionTotal = 0;
    let amountRowsFound = 0;
    const skuDiagnostics = skuRows.map((sku: any) => {
      const actual = parseAffiliateMoney(sku?.actual_paid_commission?.amount);
      const estimated = parseAffiliateMoney(sku?.estimated_paid_commission?.amount);
      const ineligible = String(sku?.fully_return || "").toLowerCase() === "yes" ||
        String(sku?.settlement_status || "").toUpperCase() === "INELIGIBLE";
      const selected = ineligible ? 0 : (actual !== null ? actual : (estimated !== null ? estimated : 0));
      if (!ineligible && (actual !== null || estimated !== null)) amountRowsFound++;
      commissionTotal += selected;
      return {
        sku_id: String(sku?.sku_id || ""),
        seller_sku: String(sku?.seller_sku || ""),
        settlement_status: String(sku?.settlement_status || ""),
        commission_rate: String(sku?.commission_rate || ""),
        actual_paid_commission: sku?.actual_paid_commission?.amount ?? null,
        estimated_paid_commission: sku?.estimated_paid_commission?.amount ?? null,
        selected_amount: selected,
      };
    });
    const confirmedAmount = exactOrder ? Math.abs(commissionTotal) : 0;
    return response({
      ok: true,
      mode: "TIKTOK_SELLER_AFFILIATE_ORDERS",
      marketplace: "TikTok Shop",
      order_id: orderId,
      affiliate_commission: {
        found: true, amount: confirmedAmount, source_mode: "SELLER_AFFILIATE_ORDERS",
        source_field: "skus[].actual_paid_commission/estimated_paid_commission", status: "CONFIRMED",
        diagnostic: { affiliate_order_found: !!exactOrder, sku_count: skuRows.length,
          amount_rows_found: amountRowsFound, sku_rows: skuDiagnostics },
      },
      lookup: { order_found: !!exactOrder, fee_field_confirmed: true, pages_scanned: pagesScanned,
        pagination_complete: paginationComplete, total_count: totalCount, error: null },
      note: "Exact Order ID match from Search Seller Affiliate Orders; order time is used only for TikTok's maximum 3-month search window.",
    });
    return response({
      ok: true,
      mode: "TIKTOK_AFFILIATE_ONLY",
      marketplace: "TikTok Shop",
      order_id: orderId,
      affiliate_commission: {
        found: affiliate.found === true,
        amount: affiliate.found === true ? Number(affiliate.amount) || 0 : null,
        source_mode: selectedAffiliate?.source || "UNSETTLED_ESTIMATE",
        source_field: affiliate.source_field,
        diagnostic: affiliate.diagnostic || {},
        status: affiliate.found === true ? "CONFIRMED" : "PENDING_DATA",
      },
      lookup: {
        order_found: exactOrderFound,
        unsettled_order_found: unsettledMatches.length > 0,
        statement_order_found: statementOrderFound,
        matched_rows: unsettledMatches.length,
        affiliate_rows_found: unsettledAffiliateCandidates.length,
        fee_field_confirmed: affiliate.found === true,
        pages_scanned: pagesScanned,
        pagination_complete: paginationComplete,
        unsettled_error: unsettledError,
        statement_error: statementError,
        diagnostic: {
          unsettled_total_count: unsettledTotalCount,
          unsettled_pages_scanned: pagesScanned,
          unsettled_pagination_complete: paginationComplete,
          unsettled_data_keys: unsettledDataKeys,
          unsettled_first_order_id: unsettledFirstOrderId,
          unsettled_last_order_id: unsettledLastOrderId,
          unsettled_first_fee_keys: unsettledFirstFeeKeys,
          unsettled_first_affiliate_fields: unsettledFirstAffiliateFields,
          statement_data_keys: statementDataKeys,
          statement_sku_count: statementSkuCount,
          statement_first_fee_keys: statementFirstFeeKeys,
          statement_first_affiliate_fields: statementFirstAffiliateFields,
        },
        error: affiliate.found ? null : "AFFILIATE_FEE_NOT_YET_AVAILABLE_FOR_EXACT_ORDER_ID",
      },
      note: "An explicit affiliate_commission_amount value, including 0, is confirmed. A missing fee field remains pending and must be retried; it is not treated as Rp0.",
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 500);
  }
});
