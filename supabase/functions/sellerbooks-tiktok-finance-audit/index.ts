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


type AmountValue = { found: boolean; amount: number; occurrences: number; paths: string[] };
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
const sumExactPath = (rows: any[], path: string): AmountValue => {
  const matches = rows.map((row, index) => ({ value: readPath(row, path), path: "[" + index + "]." + path }))
    .filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
  return { found: matches.length > 0, amount: matches.reduce((sum, item) => sum + normalizeAmount(item.value), 0),
    occurrences: matches.length, paths: matches.map((item) => item.path) };
};
const buildTikTokFeeAudit = (data: any, sourceMode: "UNSETTLED_ESTIMATE" | "SETTLED_FINAL") => {
  const orderRows = Array.isArray(data?.transactions) ? data.transactions : [];
  const skuRows = Array.isArray(data?.sku_transactions) ? data.sku_transactions : [];
  const feeRowsFor = (path: string) => {
    const skuValue = sumExactPath(skuRows, path);
    return skuValue.found ? skuValue : sumExactPath(orderRows, path);
  };
  const fields = {
    platform_commission: feeRowsFor("fee_tax_breakdown.fee.platform_commission_amount"),
    mall_service: feeRowsFor("fee_tax_breakdown.fee.mall_service_fee_amount"),
    affiliate: feeRowsFor("fee_tax_breakdown.fee.affiliate_commission_amount"),
    dynamic_commission: feeRowsFor("fee_tax_breakdown.fee.dynamic_commission_amount"),
    order_processing: feeRowsFor("fee_tax_breakdown.fee.transaction_fee_amount"),
    pph22: feeRowsFor("fee_tax_breakdown.tax.article_22_income_tax_withheld"),
  };
  const infrastructureFee = feeRowsFor("fee_tax_breakdown.fee.vn_fix_infrastructure_fee");
  const logisticsOrder = sumExactPath(orderRows, "shipping_cost_breakdown.logistics_service_fee");
  const logisticsSku = sumExactPath(skuRows, "shipping_cost_breakdown.logistics_service_fee");
  const logistics = logisticsOrder.found ? logisticsOrder : logisticsSku;
  const seven = Object.values(fields);
  const currency = data?.currency ?? orderRows[0]?.currency ?? skuRows[0]?.currency ?? null;
  const sevenComponentAmount = seven.reduce((sum, item) => sum + item.amount, 0) + logistics.amount;
  const reportedFeeTaxAmount = sourceMode === "UNSETTLED_ESTIMATE"
    ? normalizeAmount(data?.est_fee_tax_amount)
    : normalizeAmount(data?.fee_tax_amount);
  const reportedFeeTaxFound = sourceMode === "UNSETTLED_ESTIMATE"
    ? data?.est_fee_tax_amount !== undefined && data?.est_fee_tax_amount !== null
    : data?.fee_tax_amount !== undefined && data?.fee_tax_amount !== null;
  const mappedBreakdownAmount = sevenComponentAmount + infrastructureFee.amount;
  const missingSeven = [
    ...Object.entries(fields).filter(([, value]) => !value.found).map(([key]) => key),
    ...(!logistics.found ? ["seller_borne_logistics"] : []),
  ];
  const sourceUnavailable = sourceMode === "UNSETTLED_ESTIMATE" && !fields.pph22.found
    ? ["pph_22"] : [];
  return {
    source_mode: sourceMode, currency,
    components: {
      platform_commission: fields.platform_commission, mall_service_fee: fields.mall_service,
      affiliate_commission: fields.affiliate, dynamic_commission: fields.dynamic_commission,
      order_processing_fee: fields.order_processing, pph_22: fields.pph22,
      seller_borne_logistics: { ...logistics, verified_field: "shipping_cost_breakdown.logistics_service_fee",
        description: "TikTok documents this as a per-order seller logistics service fee.", included_in_total: logistics.found },
      infrastructure_fee_additional: { ...infrastructureFee,
        verified_field: "fee_tax_breakdown.fee.vn_fix_infrastructure_fee",
        description: "TikTok infrastructure fee on the main order; reported separately from the requested seven components." },
    },
    admin_marketplace_total: { amount: sevenComponentAmount, currency,
      complete: missingSeven.length === 0,
      missing_components: missingSeven,
      source_unavailable_components: sourceUnavailable,
      note: "Requested seven-component subtotal only. Additional infrastructure fee is reported separately; missing fields are not treated as confirmed zero." },
    reconciliation: {
      reported_fee_tax_amount: reportedFeeTaxFound ? reportedFeeTaxAmount : null,
      seven_component_amount: sevenComponentAmount,
      additional_infrastructure_fee: infrastructureFee.found ? infrastructureFee.amount : null,
      mapped_breakdown_amount: infrastructureFee.found ? mappedBreakdownAmount : null,
      unmapped_difference: reportedFeeTaxFound && infrastructureFee.found
        ? reportedFeeTaxAmount - mappedBreakdownAmount : null,
      reconciled: reportedFeeTaxFound && infrastructureFee.found &&
        Math.abs(reportedFeeTaxAmount - mappedBreakdownAmount) < 0.000001,
      note: "Reconciliation compares the API aggregate against the seven requested components plus the separately identified infrastructure fee. A non-zero difference remains unclassified; never allocate it by assumption.",
    },
    sku_transaction_count: skuRows.length, order_transaction_count: orderRows.length,
    readiness: missingSeven.length === 0 ? "SEVEN_COMPONENTS_PRESENT" :
      sourceUnavailable.length ? "SOURCE_FIELD_UNAVAILABLE" : "INCOMPLETE_COMPONENT_MAPPING",
    warnings: ["Exact documented paths only; SKU rows take precedence over order rows to prevent duplicate aggregation.",
      "Logistics uses the documented order-level shipping_cost_breakdown.logistics_service_fee.",
      "Affiliate aggregate only; affiliate subcomponents such as affiliate_commission_before_pit_amount are not added again.",
      "vn_fix_infrastructure_fee is tracked separately and is not silently merged into the seven requested components.",
      sourceMode === "UNSETTLED_ESTIMATE" ? "Unsettled values are estimates and may change before settlement; Article 22 tax may not be returned by this endpoint." : "Settled values are final statement values."],
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

    const settledData = settled?.data ?? null;
    const settledTransactions = Array.isArray(settledData?.transactions) ? settledData.transactions : [];
    const settledSkuTransactions = Array.isArray(settledData?.sku_transactions) ? settledData.sku_transactions : [];

    // Unsettled estimates are queried separately using TikTok's order creation-time window.
    const orderCreateTime = Number(body.order_create_time || 0);
    let unsettledMatch: any = null;
    let unsettledError: string | null = null;
    if (orderCreateTime > 0) {
      try {
        const from = Math.max(1735689600, orderCreateTime - 86400);
        const to = orderCreateTime + 86400;
        let pageToken = "";
        for (let page = 0; page < 20; page++) {
          const query: Record<string, string> = {
            search_time_ge: String(from), search_time_lt: String(to),
            sort_field: "order_create_time", sort_order: "ASC", page_size: "100",
          };
          if (pageToken) query.page_token = pageToken;
          const pageData = await tiktokGet(credential, "/finance/202507/orders/unsettled", query);
          const rows = Array.isArray(pageData?.data?.transactions) ? pageData.data.transactions : [];
          unsettledMatch = rows.find((row: any) => String(row?.order_id || "") === orderId) || unsettledMatch;
          if (unsettledMatch) break;
          pageToken = String(pageData?.data?.next_page_token || "");
          if (!pageToken) break;
        }
      } catch (error) {
        unsettledError = error instanceof Error ? error.message : String(error);
      }
    } else {
      unsettledError = "ORDER_CREATE_TIME_REQUIRED_FOR_UNSETTLED_LOOKUP";
    }

    return response({
      ok: true,
      mode: "READ_ONLY_TIKTOK_FEE_COMPONENT_AUDIT",
      marketplace: "TikTok Shop",
      order_id: orderId,
      connection_id: connection.id,
      settlement_status: settled
        ? "SETTLEMENT_DATA_RETURNED"
        : "SETTLEMENT_DATA_NOT_AVAILABLE",
      settled_lookup: settled
        ? {
          found: settledTransactions.length > 0 || settledSkuTransactions.length > 0,
          status: settledTransactions.length > 0 || settledSkuTransactions.length > 0
            ? "SETTLED_TRANSACTION_ROWS_FOUND" : "SETTLED_RESPONSE_WITHOUT_TRANSACTION_ROWS",
          data: settledData,
          transaction_count: settledTransactions.length,
          sku_transaction_count: settledSkuTransactions.length,
          request_id: settled.request_id ?? null,
          fee_component_audit: buildTikTokFeeAudit(settledData, "SETTLED_FINAL"),
        }
        : { found: false, error: settledError },
      unsettled_lookup: unsettledMatch
        ? { found: true, transaction: unsettledMatch,
            fee_component_audit: buildTikTokFeeAudit({ transactions: [unsettledMatch] }, "UNSETTLED_ESTIMATE") }
        : { found: false, error: unsettledError },
      note: "Read-only seven-component audit for settled and unsettled TikTok orders. No sales, import queue, HPP, profit, refund, or snapshot data is modified.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 500);
  }
});
