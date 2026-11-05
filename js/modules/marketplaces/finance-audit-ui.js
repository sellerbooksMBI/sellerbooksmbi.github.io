/* =========================================================
   SELLERBOOKS TIKTOK FINANCE AUDIT UI
   Manual one-order diagnostic; no sales/import/report writes.
========================================================= */
(function(){
    "use strict";

    let activeStoreId = "";

    const byId = function(id){
        return document.getElementById(id);
    };

    window.openTikTokFinanceAudit = function(storeId){
        const store = Array.isArray(stores)
            ? stores.find(function(item){ return String(item.id) === String(storeId); })
            : null;

        if(!store){
            sellerBooksAlert(
                sellerBooksCurrentLanguage() === "en" ? "Store not found." : "Akun toko tidak ditemukan.",
                "Finance Audit"
            );
            return;
        }

        const connection = getStoreIntegrationConnection(store);
        if(String(connection?.connection_status || "").toUpperCase() !== "CONNECTED"){
            sellerBooksAlert(
                sellerBooksCurrentLanguage() === "en"
                    ? "Connect this TikTok Shop store before running Finance Audit."
                    : "Hubungkan akun TikTok Shop ini sebelum menjalankan Audit Finance.",
                "Finance Audit"
            );
            return;
        }

        activeStoreId = String(store.id);
        byId("financeAuditStoreName").textContent = String(store.name || "");
        byId("financeAuditOrderId").value = "";
        byId("financeAuditOrderCreatedAt").value = "";
        byId("financeAuditResult").innerHTML = "";
        byId("financeAuditModal").classList.add("show");
        byId("financeAuditModal").setAttribute("aria-hidden","false");
    };

    window.closeTikTokFinanceAudit = function(){
        const modal = byId("financeAuditModal");
        if(modal){
            modal.classList.remove("show");
            modal.setAttribute("aria-hidden","true");
        }
        activeStoreId = "";
    };

    window.runTikTokFinanceAudit = async function(){
        const english = sellerBooksCurrentLanguage() === "en";
        const orderId = String(byId("financeAuditOrderId").value || "").trim();
        const createdAt = String(byId("financeAuditOrderCreatedAt").value || "").trim();
        const timestamp = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;
        const button = byId("financeAuditRunButton");
        const resultBox = byId("financeAuditResult");

        if(!activeStoreId){
            sellerBooksAlert(english ? "Select a store first." : "Pilih akun toko terlebih dahulu.","Finance Audit");
            return;
        }
        if(!orderId){
            sellerBooksAlert(english ? "Enter the TikTok Order ID." : "Masukkan Order ID TikTok.","Finance Audit");
            byId("financeAuditOrderId").focus();
            return;
        }
        if(!Number.isFinite(timestamp) || timestamp <= 0){
            sellerBooksAlert(english ? "Enter the order creation date and time." : "Masukkan tanggal dan waktu pembuatan pesanan.","Finance Audit");
            byId("financeAuditOrderCreatedAt").focus();
            return;
        }
        if(typeof window.sellerBooksAuditTikTokOrder !== "function"){
            sellerBooksAlert(english ? "Finance audit module is not ready. Refresh the page." : "Modul Audit Finance belum siap. Muat ulang halaman.","Finance Audit");
            return;
        }

        button.disabled = true;
        button.textContent = english ? "Checking…" : "Memeriksa…";
        resultBox.innerHTML = "";

        try{
            const response = await window.sellerBooksAuditTikTokOrder(orderId,timestamp,activeStoreId);
            const audit = typeof window.sellerBooksSelectFinanceAudit === "function"
                ? window.sellerBooksSelectFinanceAudit(response)
                : null;

            if(!audit){
                resultBox.innerHTML = '<p class="sb-finance-audit-empty">' +
                    (english
                        ? "No settled or unsettled Finance transaction rows were found for this Order ID."
                        : "Baris transaksi Finance settled maupun unsettled tidak ditemukan untuk Order ID ini.") +
                    "</p>";
                return response;
            }

            const labels = {
                platform_commission: english ? "Platform commission" : "Komisi platform",
                mall_service_fee: english ? "Mall service fee" : "Biaya layanan Mall",
                affiliate_commission: english ? "Affiliate commission" : "Komisi afiliasi",
                dynamic_commission: english ? "Dynamic commission" : "Komisi dinamis",
                order_processing_fee: english ? "Order processing fee" : "Biaya pemrosesan pesanan",
                pph_22: "PPh 22",
                seller_borne_logistics: english ? "Seller-borne logistics" : "Logistik ditanggung penjual"
            };
            const currency = String(audit.currency || "IDR").toUpperCase();
            const formatAmount = function(value){
                const number = Number(value);
                return Number.isFinite(number)
                    ? number.toLocaleString(english ? "en-US" : "id-ID",{maximumFractionDigits:2}) + " " + currency
                    : "—";
            };
            const rows = Object.keys(labels).map(function(key){
                const item = audit.components?.[key] || {};
                const missing = item.found !== true;
                return '<div class="sb-finance-audit-row">' +
                    '<span>' + labels[key] + (missing ? ' <small>—</small>' : '') + '</span>' +
                    '<strong>' + (missing ? (english ? "Not found" : "Tidak ditemukan") : formatAmount(item.amount)) + '</strong>' +
                    '</div>';
            }).join("");

            const complete = audit.admin_marketplace_total?.complete === true;
            const source = audit.source_mode === "SETTLED_FINAL"
                ? (english ? "Settled final" : "Settled final")
                : (english ? "Unsettled estimate" : "Estimasi unsettled");
            resultBox.innerHTML =
                '<div class="sb-finance-audit-summary">' +
                    '<strong>' + (complete
                        ? (english ? "All 7 components found" : "Semua 7 komponen ditemukan")
                        : (english ? "Finance data is incomplete" : "Data Finance belum lengkap")) + '</strong>' +
                    '<span>' + source + '</span>' +
                '</div>' +
                '<div class="sb-finance-audit-list">' + rows + '</div>' +
                '<div class="sb-finance-audit-total"><span>' +
                    (english ? "Seven-component total" : "Total tujuh komponen") +
                    '</span><strong>' + formatAmount(audit.admin_marketplace_total?.amount) + '</strong></div>' +
                '<p class="sb-finance-audit-footnote">' +
                    (english
                        ? "The audit is read-only against TikTok. The result is stored separately in Finance; sales, HPP, profit, refunds, imports, and snapshots are not changed."
                        : "Audit hanya membaca data TikTok. Hasil disimpan terpisah di Finance; penjualan, HPP, laba, refund, import, dan snapshot tidak diubah.") +
                '</p>';
            return response;
        }catch(error){
            console.error("TikTok Finance audit UI failed:",error);
            resultBox.innerHTML = '<p class="sb-finance-audit-error">' +
                String(error?.message || (english ? "Finance audit failed." : "Audit Finance gagal.")) +
                '</p>';
            sellerBooksAlert(
                (english ? "Finance audit failed:\n\n" : "Audit Finance gagal:\n\n") +
                String(error?.message || error),
                "Finance Audit"
            );
        }finally{
            button.disabled = false;
            button.textContent = sellerBooksCurrentLanguage() === "en" ? "Run Finance Audit" : "Jalankan Audit Finance";
        }
    };
})();
