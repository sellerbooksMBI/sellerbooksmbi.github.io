/* PATCH K: jadwalkan render berat agar navigasi/dropdown tidak memblokir UI.
   Jika user mengganti halaman/periode beberapa kali dengan cepat,
   render yang belum sempat berjalan dibatalkan dan hanya state terakhir diproses. */
let sellerBooksDeferredRenderToken = 0;

function sellerBooksScheduleDeferredRender(callback){
    const token = ++sellerBooksDeferredRenderToken;

    setTimeout(function(){
        if(token !== sellerBooksDeferredRenderToken){
            return;
        }
        try{
            callback();
        }catch(error){
            console.error("Render tertunda SellerBooks gagal:",error);
        }
    },0);
}

/*
   MASTER DATA BERUBAH:
   Segarkan Laporan dan Rincian yang sedang terbuka agar angka langsung
   memakai Master Produk/Akun Toko terbaru. Tidak mengubah filter,
   transaksi, snapshot, maupun rumus perhitungan.
*/
function sellerBooksRefreshReportViewsAfterMasterChange(){
    sellerBooksScheduleDeferredRender(function(){
        const reportsView=document.getElementById("reports");
        const detailsView=document.getElementById("productAnalysis");

        if(reportsView?.classList.contains("active") &&
           typeof updateReports==="function"){
            updateReports();
        }

        if(detailsView?.classList.contains("active") &&
           typeof renderProductAnalysis==="function"){
            renderProductAnalysis();
        }
    });
}


/* Setelah import selesai, hanya render ulang halaman yang sedang terlihat.
   Menghindari hitung Laporan/Produk/Toko di belakang layar yang tidak dilihat user. */
function sellerBooksRefreshActiveViewAfterSalesImport(){
    sellerBooksScheduleDeferredRender(function(){
        const isActive=function(id){
            return document.getElementById(id)?.classList.contains("active")===true;
        };
        if(isActive("dashboard") && typeof updateDashboardByPeriod==="function"){
            updateDashboardByPeriod();
        }else if(isActive("reports") && typeof updateReports==="function"){
            updateReports();
        }else if(isActive("productAnalysis") && typeof renderProductAnalysis==="function"){
            renderProductAnalysis();
        }else if(isActive("products")){
            if(typeof renderProducts==="function")renderProducts();
            if(typeof renderNotifications==="function")renderNotifications();
        }
    });
}
