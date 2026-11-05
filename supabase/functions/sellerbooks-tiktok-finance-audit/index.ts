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
const discoverFeeTaxFields = (rows: any[]) => {
  const found: Record<string, { amount: number; occurrences: number; paths: string[] }> = {};
  const visit = (value: any, path: string, rowIndex: number, depth: number) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    for (const [key, child] of Object.entries(value)) {
      const next = path ? path + "." + key : key;
      if (typeof child === "string" || typeof child === "number") {
        if (/(fee|commission|tax|vat|gst|pit|withheld|duty|surcharge|charge|handling|insurance|infrastructure|service)/i.test(key)) {
          const item = found[next] || (found[next] = { amount: 0, occurrences: 0, paths: [] });
          item.amount += normalizeAmount(child);
          item.occurrences += 1;
          item.paths.push("[" + rowIndex + "]." + next);
        }
      } else if (child && typeof child === "object") visit(child, next, rowIndex, depth + 1);
    }
  };
  rows.forEach((row, index) => visit(row?.fee_tax_breakdown, "fee_tax_breakdown", index, 0));
  rows.forEach((row, index) => visit(row?.shipping_cost_breakdown, "shipping_cost_breakdown", index, 0));
  return found;
};
const buildTikTokFeeAudit = (data: any, sourceMode: "UNSETTLED_ESTIMATE" | "SETTLED_FINAL") => {
  const orderRows = Array.isArray(data?.transactions) ? data.transactions :
    (sourceMode === "UNSETTLED_ESTIMATE" && data?.order_id ? [data] : []);
  const skuRows = Array.isArray(data?.sku_transactions) ? data.sku_transactions : [];
  const feeRowsFor = (path: string) => {
    const skuValue = sumExactPath(skuRows, path);
    return skuValue.found ? skuValue : sumExactPath(orderRows, path);
  };
  const affiliatePrimary = feeRowsFor("fee_tax_breakdown.fee.affiliate_commission_amount");
  const affiliateAds = feeRowsFor("fee_tax_breakdown.fee.affiliate_ads_commission_amount");
  // TikTok Indonesia may report the Seller Center affiliate-ads charge in
  // affiliate_ads_commission_amount while affiliate_commission_amount is zero.
  // Use the ads field as a fallback, never add both representations together.
  const affiliate = (affiliatePrimary.amount !== 0 || !affiliateAds.found)
    ? { ...affiliatePrimary, selected_field: "fee_tax_breakdown.fee.affiliate_commission_amount" }
    : { ...affiliateAds, selected_field: "fee_tax_breakdown.fee.affiliate_ads_commission_amount" };
  const processingStandard = feeRowsFor("fee_tax_breakdown.fee.transaction_fee_amount");
  const infrastructureFee = feeRowsFor("fee_tax_breakdown.fee.vn_fix_infrastructure_fee");
  // In the tested Indonesia transaction, Seller Center's order-processing fee
  // is supplied by vn_fix_infrastructure_fee; use it only as a fallback.
  const orderProcessing = (processingStandard.amount !== 0 || !infrastructureFee.found)
    ? { ...processingStandard, selected_field: "fee_tax_breakdown.fee.transaction_fee_amount" }
    : { ...infrastructureFee, selected_field: "fee_tax_breakdown.fee.vn_fix_infrastructure_fee" };
  const fields = {
    platform_commission: feeRowsFor("fee_tax_breakdown.fee.platform_commission_amount"),
    mall_service: feeRowsFor("fee_tax_breakdown.fee.mall_service_fee_amount"),
    affiliate,
    dynamic_commission: feeRowsFor("fee_tax_breakdown.fee.dynamic_commission_amount"),
    order_processing: orderProcessing,
    pph22: feeRowsFor("fee_tax_breakdown.tax.article_22_income_tax_withheld"),
  };
  const logisticsOrder = sumExactPath(orderRows, "shipping_cost_breakdown.logistics_service_fee");
  const logisticsSku = sumExactPath(skuRows, "shipping_cost_breakdown.logistics_service_fee");
  const logistics = logisticsOrder.found ? logisticsOrder : logisticsSku;
  const feeTaxComponents = Object.values(fields);
  const currency = data?.currency ?? orderRows[0]?.currency ?? skuRows[0]?.currency ?? null;
  // TikTok fee_and_tax_amount excludes shipping; logistics is reconciled separately.
  const feeTaxComponentAmount = feeTaxComponents.reduce((sum, item) => sum + item.amount, 0);
  const sevenComponentAmount = feeTaxComponentAmount + logistics.amount;
  const reportedFeeTaxAmount = sourceMode === "UNSETTLED_ESTIMATE"
    ? normalizeAmount(data?.est_fee_tax_amount ?? orderRows[0]?.est_fee_tax_amount)
    : normalizeAmount(data?.fee_and_tax_amount ?? data?.fee_tax_amount ??
        orderRows[0]?.fee_tax_amount ?? skuRows[0]?.fee_tax_amount);
  const reportedFeeTaxFound = sourceMode === "UNSETTLED_ESTIMATE"
    ? (data?.est_fee_tax_amount ?? orderRows[0]?.est_fee_tax_amount) != null
    : (data?.fee_and_tax_amount ?? data?.fee_tax_amount ??
        orderRows[0]?.fee_tax_amount ?? skuRows[0]?.fee_tax_amount) != null;
  const mappedBreakdownAmount = feeTaxComponentAmount;
  const missingSeven = [
    ...Object.entries(fields).filter(([, value]) => !value.found).map(([key]) => key),
    ...(!logistics.found ? ["seller_borne_logistics"] : []),
  ];
  const sourceUnavailable = sourceMode === "UNSETTLED_ESTIMATE" && !fields.pph22.found
    ? ["pph_22"] : [];
  return {
    source_mode: sourceMode, currency,
    reported_aggregate_source: sourceMode === "UNSETTLED_ESTIMATE" ? "est_fee_tax_amount" :
      (data?.fee_and_tax_amount != null ? "fee_and_tax_amount" : "fee_tax_amount"),
    components: {
      platform_commission: fields.platform_commission, mall_service_fee: fields.mall_service,
      affiliate_commission: fields.affiliate, dynamic_commission: fields.dynamic_commission,
      order_processing_fee: fields.order_processing, pph_22: fields.pph22,
      seller_borne_logistics: { ...logistics, verified_field: "shipping_cost_breakdown.logistics_service_fee",
        description: "TikTok per-order seller logistics service fee.", included_in_total: logistics.found },
      infrastructure_fee_source: { ...infrastructureFee,
        verified_field: "fee_tax_breakdown.fee.vn_fix_infrastructure_fee",
        mapped_as_order_processing_fallback: orderProcessing.selected_field === "fee_tax_breakdown.fee.vn_fix_infrastructure_fee",
        description: "Raw infrastructure field retained for traceability; when transaction_fee_amount is zero or absent, it supplies the Seller Center order-processing component. It is not added a second time." },
    },
    discovered_fee_tax_fields: discoverFeeTaxFields([...skuRows, ...orderRows]),
    admin_marketplace_total: { amount: sevenComponentAmount, currency,
      complete: missingSeven.length === 0, missing_components: missingSeven,
      source_unavailable_components: sourceUnavailable,
      note: "Seven Seller Center cost components including logistics; infrastructure fallback is already included in order_processing and is not added twice; absent fields are not assumed zero." },
    reconciliation: {
      reported_fee_tax_amount: reportedFeeTaxFound ? reportedFeeTaxAmount : null,
      fee_tax_component_amount: feeTaxComponentAmount,
      logistics_component_amount: logistics.found ? logistics.amount : null,
      seven_component_amount: sevenComponentAmount,
      mapped_breakdown_amount: mappedBreakdownAmount,
      unmapped_difference: reportedFeeTaxFound
        ? reportedFeeTaxAmount - mappedBreakdownAmount : null,
      reconciled: reportedFeeTaxFound &&
        Math.abs(reportedFeeTaxAmount - mappedBreakdownAmount) < 0.000001,
      note: "fee_and_tax_amount is reconciled against fee/tax components only; logistics is reported separately and included in the seven-component total. No component is counted twice.",
    },
    sku_transaction_count: skuRows.length, order_transaction_count: orderRows.length,
    readiness: missingSeven.length === 0 ? "SEVEN_COMPONENTS_PRESENT" :
      sourceUnavailable.length ? "SOURCE_FIELD_UNAVAILABLE" : "INCOMPLETE_COMPONENT_MAPPING",
    warnings: ["Exact requested fields are mapped separately; all discovered fee/tax fields are exposed for review.",
      "SKU rows take precedence over order rows to avoid duplicate aggregation.",
      "Affiliate commission uses affiliate_commission_amount, falling back to affiliate_ads_commission_amount when the primary field is zero or absent; both are never added together.",
      "Order processing uses transaction_fee_amount, falling back to vn_fix_infrastructure_fee when the primary field is zero or absent; infrastructure is never added twice.",
      "TikTok fee_and_tax_amount excludes logistics in this reconciliation; logistics is shown separately and included in the seven-component total.",
      "Unsettled values are estimates; settled statement values are final."],
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

    // Final order-level settled lookup.
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

    // Search daily statements since the order was created; fetch statement rows and match the exact order ID.
    const orderCreateTimeForStatements = Number(body.order_create_time || 0);
    const statementLookup: any = { attempted: false, found: false, statements_checked: 0,
      matched_statement_id: null, transaction_count: 0, matching_transactions: [], error: null,
      note: "Read-only statement search. Statement API returns settled records only." };
    if (orderCreateTimeForStatements > 0) {
      statementLookup.attempted = true;
      try {
        const now = Math.floor(Date.now() / 1000);
        const from = Math.max(1688169600, orderCreateTimeForStatements - 86400);
        const to = now + 1;
        const list = await tiktokGet(credential, "/finance/202309/statements", {
          statement_time_ge: String(from), statement_time_lt: String(to),
          sort_field: "statement_time", sort_order: "ASC", page_size: "100",
        });
        const statements = Array.isArray(list?.data?.statements) ? list.data.statements : [];
        statementLookup.total_statements_returned = statements.length;
        statementLookup.list_request_id = list?.request_id ?? null;
        for (const statement of statements.slice(0, 45)) {
          const statementId = String(statement?.id || "");
          if (!statementId) continue;
          statementLookup.statements_checked++;
          let detailPageToken = "";
          let statementDetail: any = null;
          for (let detailPage = 0; detailPage < 10; detailPage++) {
            const detailQuery: Record<string, string> = {
              sort_field: "order_create_time", sort_order: "ASC", page_size: "100",
            };
            if (detailPageToken) detailQuery.page_token = detailPageToken;
            const detail = await tiktokGet(credential,
              "/finance/202501/statements/" + encodeURIComponent(statementId) + "/statement_transactions",
              detailQuery);
            statementDetail = detail;
            const rows = Array.isArray(detail?.data?.transactions) ? detail.data.transactions : [];
            const matches = rows.filter((row: any) =>
              String(row?.order_id || row?.adjustment_order_id || "") === orderId);
            if (matches.length) {
              statementLookup.found = true;
              statementLookup.matched_statement_id = statementId;
              statementLookup.transaction_count += matches.length;
              statementLookup.matching_transactions.push(...matches);
              statementLookup.statement_summary = statement;
              statementLookup.statement_aggregate = detail?.data?.total_settlement_breakdown ??
                detail?.data?.total_fee_tax_amount ?? null;
              break;
            }
            detailPageToken = String(detail?.data?.next_page_token || "");
            if (!detailPageToken) break;
            if (detailPage === 9) statementLookup.transaction_pages_truncated = true;
          }
          if (statementLookup.found) break;
        }
        if (statements.length > 45) statementLookup.truncated = true;
      } catch (error) {
        statementLookup.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      statementLookup.error = "ORDER_CREATE_TIME_REQUIRED_FOR_STATEMENT_LOOKUP";
    }

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
      statement_lookup: statementLookup,
      settled_lookup: settled
        ? {
          found: settledTransactions.length > 0 || settledSkuTransactions.length > 0,
          status: settledTransactions.length > 0 || settledSkuTransactions.length > 0
            ? "SETTLED_TRANSACTION_ROWS_FOUND" : "SETTLED_RESPONSE_WITHOUT_TRANSACTION_ROWS",
          data: settledData,
          transaction_count: settledTransactions.length,
          sku_transaction_count: settledSkuTransactions.length,
          request_id: settled.request_id ?? null,
          fee_component_audit: buildTikTokFeeAudit({
            ...settledData,
            fee_and_tax_amount: settledData?.fee_and_tax_amount ?? settledData?.data?.fee_and_tax_amount,
          }, "SETTLED_FINAL"),
        }
        : { found: false, error: settledError },
      unsettled_lookup: unsettledMatch
        ? { found: true, transaction: unsettledMatch,
            fee_component_audit: buildTikTokFeeAudit(unsettledMatch, "UNSETTLED_ESTIMATE") }
        : { found: false, error: unsettledError },
      note: "Read-only seven-component audit for settled and unsettled TikTok orders. No sales, import queue, HPP, profit, refund, or snapshot data is modified.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 500);
  }
});
