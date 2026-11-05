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

    function applyAuditLanguage(){
        const english = sellerBooksCurrentLanguage() === "en";
        const copy = english ? {
            title:"TikTok Finance Audit",
            intro:"Review the seven cost components from TikTok transaction data.",
            store:"Store account:",
            order:"TikTok Order ID",
            date:"Order creation date and time",
            dateHelp:"Use the order creation time from TikTok, not payment or shipping time. This timestamp is used to find unsettled data and settled statements.",
            generalHelp:"This audit reads TikTok API data and stores the Finance result per Order ID. It does not change sales, COGS, profit, refunds, imports, or snapshots.",
            close:"Close",
            run:"Run Finance Audit"
        } : {
            title:"Audit Finance TikTok",
            intro:"Periksa tujuh komponen biaya dari data transaksi TikTok.",
            store:"Akun Toko:",
            order:"Order ID TikTok",
            date:"Tanggal & waktu pesanan dibuat",
            dateHelp:"Gunakan waktu pembuatan pesanan dari TikTok, bukan waktu pembayaran atau pengiriman. Waktu ini dipakai untuk mencari data unsettled dan statement settled.",
            generalHelp:"Audit ini hanya membaca API TikTok dan menyimpan hasil Finance per Order ID. Tidak mengubah penjualan, HPP, laba, refund, import, atau snapshot.",
            close:"Tutup",
            run:"Jalankan Audit Finance"
        };
        byId("financeAuditTitle").textContent = copy.title;
        byId("financeAuditIntro").textContent = copy.intro;
        byId("financeAuditStoreLabel").textContent = copy.store;
        byId("financeAuditOrderLabel").textContent = copy.order;
        byId("financeAuditDateLabel").textContent = copy.date;
        byId("financeAuditDateHelp").textContent = copy.dateHelp;
        byId("financeAuditGeneralHelp").textContent = copy.generalHelp;
        byId("financeAuditCloseIcon").setAttribute("aria-label",copy.close);
        byId("financeAuditCloseButton").textContent = copy.close;
        byId("financeAuditRunButton").textContent = copy.run;
        byId("financeAuditOrderId").placeholder = english ? "Enter TikTok Order ID" : "Masukkan Order ID";
    }

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
        applyAuditLanguage();
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
            resultBox.innerHTML = '<p class="sb-finance-audit-error"></p>';
            resultBox.querySelector("p").textContent =
                String(error?.message || (english ? "Finance audit failed." : "Audit Finance gagal."));
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
