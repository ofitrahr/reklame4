# WebGIS Reklame Batam

Peta interaktif titik reklame dan titik POV Kota Batam, lengkap dengan mode
edit geometri dan atribut yang tersimpan langsung ke repositori ini.

- **2.484** titik reklame (156 kolom atribut)
- **782** titik POV, tertaut ke reklame induknya lewat `ID_TITIK`
- Berjalan sepenuhnya di peramban — tidak perlu server aplikasi maupun basis data

---

## Cara memakai

### Melihat peta

Buka alamat GitHub Pages repositori ini. Peta terbuka dalam **Mode Lihat**:
titik tidak dapat tergeser tanpa sengaja.

| Bagian | Fungsi |
|---|---|
| Kotak **Tampilan** (kanan atas) | nyalakan/matikan lapisan, ganti pewarnaan, klik kategori pada legenda untuk menyembunyikannya |
| **Peta dasar** (kanan atas) | Satelit + Label Jalan, Satelit, atau OpenStreetMap |
| **Pencarian** | ketik ID titik, nama jalan, kelurahan, atau UID |
| **Tabel Atribut** (bawah) | klik judulnya untuk membuka; bisa disaring, diurutkan, dan kolomnya dipilih sendiri |
| **📏 Penggaris** | klik berulang di peta untuk mengukur jarak; tiga titik atau lebih sekaligus menghitung luas |

### Mengedit

1. Tekan **Mode Lihat** sehingga berubah menjadi **Mode Edit AKTIF** (atau tekan `E`).
2. **Menggeser titik** — seret titiknya langsung di peta. Nilai `LONG`/`LAT`
   ikut diperbarui, dan `JARAK_M` semua POV milik titik itu dihitung ulang seketika.
3. **Mengubah atribut** — klik titik, lalu isi formulir di panel kanan. Bisa juga
   klik langsung sel mana pun di tabel bawah.
4. **Menambah titik** — **＋ Reklame** lalu klik lokasinya. Untuk POV: pilih dulu
   reklame induknya, tekan **＋ POV**, lalu klik lokasinya.
5. **Menghapus** — pilih titik, tekan **🗑 Hapus** (atau `Delete`). Titik hanya
   *ditandai* dihapus dan tetap dapat dipulihkan; centang "Tampilkan yang dihapus"
   untuk melihatnya kembali.

Pintasan: `E` mode edit · `M` penggaris · `/` pencarian · `Ctrl+Z` urungkan ·
`Ctrl+Y` ulangi · `Ctrl+S` simpan · `Esc` batal.

### Menyimpan

Perubahan langsung tersimpan di peramban, jadi aman meski tab tertutup atau
internet terputus. Untuk mengirimnya ke repositori, tekan **Simpan** — atau
biarkan tersimpan otomatis 5 detik setelah Anda berhenti mengedit.

Sebelum bisa menyimpan, isi **Pengaturan (⚙)** satu kali:

| Kolom | Isi |
|---|---|
| Nama Anda | dicatat pada setiap perubahan |
| Pemilik / Repositori / Branch | terisi otomatis bila dibuka dari GitHub Pages |
| Token akses | lihat langkah di bawah |

**Membuat token (sekali saja, per perangkat):**

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. **Generate new token**, beri nama bebas dan masa berlaku sesuai kebutuhan
3. **Repository access → Only select repositories** → pilih repositori ini saja
4. **Permissions → Repository permissions → Contents → Read and write**
5. Salin token dan tempelkan di Pengaturan, lalu tekan **Uji koneksi**

Token hanya tersimpan di peramban perangkat tersebut dan tidak pernah ikut
masuk ke dalam data. Jangan dibagikan: siapa pun yang memilikinya dapat mengubah
isi repositori ini.

### Beberapa orang mengedit bersamaan

Setiap penyimpanan mengambil dulu versi terbaru dari GitHub, menggabungkan
perubahan Anda di atasnya, lalu mengirim ulang — jadi pekerjaan orang lain tidak
tertimpa. Bila dua orang menyentuh **titik yang sama**, yang menyimpan terakhir
yang berlaku. Peta juga memeriksa perubahan orang lain setiap 2 menit dan
memuatnya sendiri.

---

## Susunan berkas

```
index.html              halaman aplikasi
css/style.css
js/
  app.js                perangkai utama, bilah alat, penyimpanan, ekspor
  store.js              data + lapisan perubahan + undo/redo
  github.js             klien GitHub Contents API
  map.js                peta, penggambaran titik, drag-and-drop
  form.js               formulir atribut panel kanan
  table.js              tabel atribut
  measure.js            penggaris
  util.js
data/
  reklame.geojson       data dasar (jangan disunting manual)
  pov.geojson           data dasar
  schema.json           definisi 156 + 26 kolom: label, tipe, grup, pilihan
  edits.json            SELURUH perubahan hasil penyuntingan
tools/
  gpkg_to_geojson.py    GPKG asli  ->  data/*.geojson + schema.json
  apply_edits.py        data dasar + edits.json  ->  GPKG & CSV baru
```

Data dasar tidak pernah ditimpa. Semua penyuntingan menumpuk di `edits.json`
sebagai lapisan terpisah, sehingga setiap perubahan punya jejak commit di Git
dan dapat ditelusuri atau dikembalikan kapan saja.

---

## Kembali ke GeoPackage

```bash
python tools/apply_edits.py
```

Menghasilkan `keluaran/<tanggal-jam>/` berisi `.gpkg` (siap dibuka di QGIS,
indeks spasialnya ikut diperbarui) dan `.csv` untuk Excel. Tiga kolom ditambahkan:
`STATUS_EDIT`, `DIUBAH_OLEH`, `DIUBAH_PADA`. Titik yang dihapus ditandai, bukan
dibuang — tambahkan `--buang-dihapus` bila memang ingin membuangnya.

Ekspor cepat GeoJSON/CSV juga tersedia langsung dari tombol **⭳ Ekspor** di aplikasi.

## Memperbarui data dasar

Bila GeoPackage sumber berubah, jalankan:

```bash
python tools/apply_edits.py
python tools/gpkg_to_geojson.py "keluaran/<tanggal-jam>/Reklame_Master_Gabungan.gpkg" "keluaran/<tanggal-jam>/Titik_POV_Reklame_Batam.gpkg"
```

lalu kosongkan `data/edits.json` menjadi `{"v":1,"reklame":{},"pov":{}}` karena
perubahannya sudah menyatu ke data dasar, dan commit hasilnya.

---

## Menjalankan di komputer sendiri

Halaman ini memuat data lewat `fetch`, jadi tidak bisa dibuka langsung sebagai
berkas — perlu server web sederhana:

```bash
python -m http.server 8000
```

lalu buka <http://localhost:8000>.

---

## Catatan atas data

- **10 titik reklame** punya geometri yang berbeda dari isi kolom `LONG`/`LAT`
  (selisih 10 m sampai 871 m, terbanyak di Sagulung). Peta memakai geometrinya
  dan menandai titik-titik ini dengan lingkaran merah. Menggeser titik tersebut
  sekali saja akan menyelaraskan keduanya.
- **18 titik POV** memiliki `ID_TITIK` yang tidak cocok dengan reklame mana pun,
  sehingga tidak tergambar garis penghubungnya dan `JARAK_M`-nya tidak ikut
  dihitung ulang.
- `ID_TITIK`, `ID_POV`, `UID`, dan `ID_WEBGIS` dikunci dari penyuntingan agar
  kaitan antara reklame dan POV tidak putus.
