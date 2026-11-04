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

const normalizeAmount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>;
    for (const key of ["amount", "value", "currency_amount"]) {
      const parsed = normalizeAmount(item[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
};

const collectNamedAmounts = (root: unknown, acceptedNames: string[]): AmountValue => {
  const accepted = new Set(acceptedNames.map((name) => name.toLowerCase()));
  const matches: { amount: number; path: string }[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, path + "[" + index + "]", depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? path + "." + key : key;
      if (accepted.has(key.toLowerCase())) {
        const amount = normalizeAmount(child);
        if (amount !== null) matches.push({ amount, path: nextPath });
      }
      if (child && typeof child === "object") walk(child, nextPath, depth + 1);
    }
  };
  walk(root, "", 0);
  return {
    found: matches.length > 0,
    amount: matches.reduce((sum, item) => sum + item.amount, 0),
    occurrences: matches.length,
    paths: matches.map((item) => item.path),
  };
};

const buildTikTokFeeAudit = (data: any) => {
  const skuRows = Array.isArray(data?.sku_transactions) ? data.sku_transactions : [];
  const orderRows = Array.isArray(data?.transactions) ? data.transactions : [];
  const source = { sku_transactions: skuRows, transactions: orderRows };

  const fields = {
    platform_commission: collectNamedAmounts(source, ["platform_commission_amount"]),
    mall_service: collectNamedAmounts(source, ["mall_service_fee_amount"]),
    affiliate: collectNamedAmounts(source, ["affiliate_commission_amount"]),
    dynamic_commission: collectNamedAmounts(source, ["dynamic_commission_amount"]),
    order_processing: collectNamedAmounts(source, ["transaction_fee_amount"]),
    pph22: collectNamedAmounts(source, ["article_22_income_tax_withheld"]),
  };

  // Shipping charge is intentionally not guessed: TikTok returns shipping
  // settlement in a separate structure and the seller-paid subcomponent must
  // be confirmed from the actual Indonesia response before it is included.
  const logisticsCandidates = collectNamedAmounts(source, [
    "seller_shipping_fee", "seller_shipping_cost", "shipping_fee_paid_by_seller",
    "seller_paid_shipping_fee", "shipping_cost_paid_by_seller",
  ]);

  const allKnown = Object.values(fields);
  const completeKnown = allKnown.every((item) => item.found);
  const totalKnown = allKnown.reduce((sum, item) => sum + item.amount, 0);

  return {
    currency: data?.currency ?? null,
    components: {
      platform_commission: fields.platform_commission,
      mall_service_fee: fields.mall_service,
      affiliate_commission: fields.affiliate,
      dynamic_commission: fields.dynamic_commission,
      order_processing_fee: fields.order_processing,
      pph_22: fields.pph22,
      seller_borne_logistics: {
        ...logisticsCandidates,
        verified: false,
        included_in_total: false,
        note: "Perlu verifikasi field shipping Indonesia dari respons settlement nyata.",
      },
    },
    subtotal_known_components: {
      amount: totalKnown,
      currency: data?.currency ?? null,
      complete: completeKnown,
      note: "Subtotal diagnostik; belum menjadi Admin Marketplace final.",
    },
    sku_transaction_count: skuRows.length,
    order_transaction_count: orderRows.length,
    readiness: completeKnown && logisticsCandidates.found
      ? "COMPONENTS_PRESENT_REQUIRES_AMOUNT_SIGN_AND_SCOPE_VALIDATION"
      : "INCOMPLETE_COMPONENT_MAPPING",
    warnings: [
      "Nilai ini diagnostik dan belum dipakai dalam perhitungan laba.",
      "Affiliate commission diambil dari field agregat; subkomponen affiliate tidak dijumlahkan lagi agar tidak double count.",
      "Subtotal belum mengalokasikan komponen order-level ke SKU.",
      "Logistik seller-borne tidak dimasukkan sampai field settlement Indonesia diverifikasi.",
    ],
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

    // Final settlement only. Pending estimates are deliberately excluded.
    const settledData = settled?.data ?? null;
    const settledTransactions = Array.isArray(settledData?.transactions)
      ? settledData.transactions
      : [];
    const settledSkuTransactions = Array.isArray(settledData?.sku_transactions)
      ? settledData.sku_transactions
      : [];

    return response({
      ok: true,
      mode: "READ_ONLY_FINAL_SETTLEMENT_AUDIT",
      marketplace: "TikTok Shop",
      order_id: orderId,
      connection_id: connection.id,
      settlement_status: settled
        ? "SETTLEMENT_DATA_RETURNED"
        : "SETTLEMENT_DATA_NOT_AVAILABLE",
      settled_lookup: settled
        ? {
          found: Boolean(settledData),
          data: settledData,
          transaction_count: settledTransactions.length,
          sku_transaction_count: settledSkuTransactions.length,
          request_id: settled.request_id ?? null,
          fee_component_audit: buildTikTokFeeAudit(settledData),
        }
        : { found: false, error: settledError },
      note: "Final settlement source only. Unsettled estimates and configured percentage fees are not used. No sales, import queue, HPP, profit, refund, or snapshot data was modified.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response({ ok: false, error: message }, 500);
  }
});
