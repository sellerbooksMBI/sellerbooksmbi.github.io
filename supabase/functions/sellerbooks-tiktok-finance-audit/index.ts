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
  const affiliateAds = feeRowsFor("fee_tax_breakdown.fee.affiliate_ads_commission_amount");
  const affiliatePrimary = feeRowsFor("fee_tax_breakdown.fee.affiliate_commission_amount");
  // SellerBooks' verified TikTok affiliate-cost source is affiliate_ads_commission_amount.
  // Prefer this field even when the generic affiliate commission field is also populated;
  // never add the two fields together or silently substitute a different fee category.
  const affiliate = affiliateAds.found
    ? { ...affiliateAds, selected_field: "fee_tax_breakdown.fee.affiliate_ads_commission_amount" }
    : { ...affiliatePrimary, selected_field: "fee_tax_breakdown.fee.affiliate_commission_amount" };
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
      "SellerBooks affiliate cost reads affiliate_ads_commission_amount first; the generic affiliate_commission_amount is only a fallback when the ads field is absent, and the two are never added together.",
      "Order processing uses transaction_fee_amount, falling back to vn_fix_infrastructure_fee when the primary field is zero or absent; infrastructure is never added twice.",
      "TikTok fee_and_tax_amount excludes logistics in this reconciliation; logistics is shown separately and included in the seven-component total.",
      "Unsettled values are estimates; settled statement values are final."],
  };

};

/* Convert the existing seven-component Finance audit into the affiliate-only
   result consumed by the frontend. This uses the same verified field mapping
   as the original Finance audit and never invents a zero for a missing field. */
const extractAffiliateCommission = (data: any, sourceMode: "UNSETTLED_ESTIMATE" | "SETTLED_FINAL") => {
  const audit = buildTikTokFeeAudit(data, sourceMode);
  const component = audit?.components?.affiliate_commission;
  return {
    found: component?.found === true,
    amount: component?.found === true ? Math.abs(Number(component.amount) || 0) : null,
    source_field: String(component?.selected_field || ""),
    diagnostic: {
      occurrences: Number(component?.occurrences || 0),
      paths: Array.isArray(component?.paths) ? component.paths : [],
      readiness: String(audit?.readiness || "UNKNOWN"),
      missing_components: audit?.admin_marketplace_total?.missing_components || [],
    },
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
     * Finance-only affiliate lookup.
     * Do not call /affiliate_seller/*: the connected app has no access to that API.
     * Match by exact Order ID across the available Finance period; order_create_time is not required.
     */
    // Order ID is the only identity key for affiliate matching.
    // Do not restrict Finance lookup to order_create_time: TikTok creates the
    // unsettled transaction when its financial event is generated (often after
    // the order itself), so a +/-1 day order-date window can miss valid fees.
    // Omitting search_time filters uses TikTok's documented full range from 2025-01-01.

    const feeKeys = (rows: any[]) => {
      const keys = new Set<string>();
      const visit = (value: any, path: string, depth: number) => {
        if (!value || typeof value !== "object" || depth > 5) return;
        for (const [key, child] of Object.entries(value)) {
          const next = path ? path + "." + key : key;
          if (/(affiliate|commission)/i.test(key) &&
              (typeof child === "string" || typeof child === "number")) keys.add(next);
          else if (child && typeof child === "object") visit(child, next, depth + 1);
        }
      };
      rows.forEach((row) => visit(row?.fee_tax_breakdown, "fee_tax_breakdown", 0));
      return [...keys];
    };

    let settledPayload: any = null;
    let settledError: string | null = null;
    let settledAffiliate: any = null;
    try {
      settledPayload = await tiktokGet(
        credential,
        "/finance/202501/orders/" + encodeURIComponent(orderId) + "/statement_transactions",
        {},
      );
      settledAffiliate = extractAffiliateCommission(settledPayload?.data ?? {}, "SETTLED_FINAL");
    } catch (error) {
      settledError = error instanceof Error ? error.message : String(error);
    }

    const statementLookup: any = {
      attempted: false, found: false, statements_checked: 0,
      pages_scanned: 0, detail_pages_scanned: 0,
      matching_transactions: [], error: null,
    };
    let statementAffiliate: any = null;
    let statementError: string | null = null;

    // Search statement pages by the full available Finance period, matching exact Order ID.
    // The order's creation timestamp is optional and must never block affiliate lookup.
    const statementWindowStart = 1735689600; // 2025-01-01 UTC
    const statementWindowEnd = Math.floor(Date.now() / 1000) + 1;
    if (!settledAffiliate?.found) {
      statementLookup.attempted = true;
      try {
        let statementPageToken = "";
        let statementListComplete = false;
        const matchingRows: any[] = [];
        const maxStatementPages = 100;
        for (let page = 0; page < maxStatementPages; page++) {
          const query: Record<string, string> = {
            statement_time_ge: String(statementWindowStart),
            statement_time_lt: String(statementWindowEnd),
            sort_field: "statement_time",
            sort_order: "ASC",
            page_size: "100",
          };
          if (statementPageToken) query.page_token = statementPageToken;
          const list = await tiktokGet(credential, "/finance/202309/statements", query);
          statementLookup.pages_scanned++;
          const data = list?.data ?? {};
          const statements = Array.isArray(data?.statements) ? data.statements : [];
          for (const statement of statements) {
            const statementId = String(statement?.id || "");
            if (!statementId) continue;
            statementLookup.statements_checked++;
            let detailPageToken = "";
            let detailComplete = false;
            for (let detailPage = 0; detailPage < 100; detailPage++) {
              const detailQuery: Record<string, string> = {
                sort_field: "order_create_time",
                sort_order: "ASC",
                page_size: "100",
              };
              if (detailPageToken) detailQuery.page_token = detailPageToken;
              const detail = await tiktokGet(
                credential,
                "/finance/202501/statements/" + encodeURIComponent(statementId) + "/statement_transactions",
                detailQuery,
              );
              statementLookup.detail_pages_scanned++;
              const detailData = detail?.data ?? {};
              const rows = Array.isArray(detailData?.transactions) ? detailData.transactions : [];
              const matches = rows.filter((row: any) =>
                String(row?.order_id || row?.adjustment_order_id || "").trim() === orderId
              );
              if (matches.length) {
                matchingRows.push(...matches);
                statementLookup.found = true;
                statementLookup.matched_statement_id = statementId;
                statementLookup.matching_transactions.push(...matches);
                statementLookup.statement_summary = statement;
                statementLookup.statement_aggregate =
                  detailData?.total_settlement_breakdown ?? detailData?.total_fee_tax_amount ?? null;
                break;
              }
              detailPageToken = String(detailData?.next_page_token || "");
              if (!detailPageToken) {
                detailComplete = true;
                break;
              }
            }
            if (statementLookup.found) break;
            if (!detailComplete) statementLookup.detail_pagination_truncated = true;
          }
          statementPageToken = String(data?.next_page_token || "");
          if (!statementPageToken) {
            statementListComplete = true;
            break;
          }
        }
        statementLookup.pagination_complete = statementListComplete;
        if (!statementListComplete) statementLookup.list_pagination_truncated = true;
        if (matchingRows.length) {
          statementAffiliate = extractAffiliateCommission({ transactions: matchingRows }, "SETTLED_FINAL");
        }
      } catch (error) {
        statementError = error instanceof Error ? error.message : String(error);
        statementLookup.error = statementError;
      }
    }

    let unsettledMatch: any = null;
    let unsettledError: string | null = null;
    let unsettledPages = 0;
    let unsettledComplete = false;
    let unsettledTotalCount: number | null = null;
    let unsettledFirstOrderId: string | null = null;
    let unsettledFirstFeeKeys: string[] = [];
    let unsettledAffiliate: any = null;
    try {
      let pageToken = "";
      for (let page = 0; page < 100; page++) {
        const query: Record<string, string> = {
          sort_field: "order_create_time",
          sort_order: "DESC",
          page_size: "100",
        };
        if (pageToken) query.page_token = pageToken;
        const pageData = await tiktokGet(credential, "/finance/202507/orders/unsettled", query);
        unsettledPages++;
        const data = pageData?.data ?? {};
        if (unsettledTotalCount === null && Number.isFinite(Number(data?.total_count))) {
          unsettledTotalCount = Number(data.total_count);
        }
        const rows = Array.isArray(data?.transactions) ? data.transactions : [];
        if (!unsettledFirstOrderId && rows.length) {
          unsettledFirstOrderId = String(rows[0]?.order_id || "");
          unsettledFirstFeeKeys = feeKeys(rows);
        }
        unsettledMatch = rows.find((row: any) =>
          String(row?.order_id || "").trim() === orderId
        ) || unsettledMatch;
        if (unsettledMatch) {
          unsettledAffiliate = extractAffiliateCommission(unsettledMatch, "UNSETTLED_ESTIMATE");
          unsettledComplete = true;
          break;
        }
        pageToken = String(data?.next_page_token || "");
        if (!pageToken) {
          unsettledComplete = true;
          break;
        }
      }
      if (!unsettledComplete) unsettledError = "UNSETTLED_PAGINATION_LIMIT_REACHED";
    } catch (error) {
      unsettledError = error instanceof Error ? error.message : String(error);
    }

    // Prefer final settled data, then statement rows, then the unsettled estimate.
    let selectedAffiliate: any = null;
    let selectedSource = "";
    if (settledAffiliate?.found) {
      selectedAffiliate = settledAffiliate;
      selectedSource = "SETTLED_FINAL";
    } else if (statementAffiliate?.found) {
      selectedAffiliate = statementAffiliate;
      selectedSource = "SETTLED_FINAL";
    } else if (unsettledAffiliate?.found) {
      selectedAffiliate = unsettledAffiliate;
      selectedSource = "UNSETTLED_ESTIMATE";
    }

    const unsettledRows = unsettledMatch ? [unsettledMatch] : [];
    const statementRows = Array.isArray(statementLookup.matching_transactions)
      ? statementLookup.matching_transactions : [];
    const statementFeeKeys = feeKeys(statementRows);
    const confirmed = selectedAffiliate?.found === true &&
      Number.isFinite(Number(selectedAffiliate.amount));

    return response({
      ok: true,
      mode: "TIKTOK_FINANCE_AFFILIATE",
      marketplace: "TikTok Shop",
      order_id: orderId,
      affiliate_commission: {
        found: confirmed,
        amount: confirmed ? Math.abs(Number(selectedAffiliate.amount) || 0) : null,
        source_mode: selectedSource || "FINANCE_PENDING",
        source_field: selectedAffiliate?.source_field || "",
        diagnostic: selectedAffiliate?.diagnostic || {},
        status: confirmed ? "CONFIRMED" : "PENDING_DATA",
      },
      lookup: {
        order_found: !!(settledPayload?.data || statementRows.length || unsettledMatch),
        fee_field_confirmed: confirmed,
        pages_scanned: unsettledPages,
        pagination_complete: unsettledComplete,
        total_count: unsettledTotalCount,
        unsettled_error: unsettledError,
        statement_error: statementError,
        settled_error: settledError,
        diagnostic: {
          unsettled_total_count: unsettledTotalCount,
          unsettled_pages_scanned: unsettledPages,
          unsettled_pagination_complete: unsettledComplete,
          unsettled_first_order_id: unsettledFirstOrderId,
          unsettled_first_fee_keys: unsettledFirstFeeKeys,
          statement_sku_count: statementRows.length,
          statement_first_fee_keys: statementFeeKeys,
          statement_pages_scanned: statementLookup.pages_scanned,
          statement_detail_pages_scanned: statementLookup.detail_pages_scanned,
          statement_pagination_complete: statementLookup.pagination_complete === true,
        },
        error: confirmed ? null :
          (unsettledError || statementError || settledError || "AFFILIATE_FEE_NOT_YET_AVAILABLE_FOR_EXACT_ORDER_ID"),
      },
      statement_lookup: statementLookup,
      note: "Finance API only. Exact Order ID match; no Affiliate API scope required. Missing fee fields remain pending, never Rp0.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 500);
  }
});
