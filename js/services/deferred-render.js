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
