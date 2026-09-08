# -*- coding: utf-8 -*-
"""
Konversi GeoPackage reklame + POV menjadi GeoJSON dan schema.json
yang dipakai oleh WebGIS. Jalankan ulang bila data sumber diperbarui:

    python tools/gpkg_to_geojson.py

Sumber default diambil dari SRC_* di bawah, atau lewat argumen CLI.
"""
import sqlite3
import json
import struct
import sys
import os
import re
import zipfile
from xml.etree import ElementTree as ET
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

SRC_REKLAME = r"C:\Users\USER\Downloads\20260907 19.30 - Titik Reklame Revisi Manual\Reklame_Master_Gabungan.gpkg"
SRC_POV = r"C:\Users\USER\Downloads\Titik_POV_Reklame_Batam\Titik_POV_Reklame_Batam.gpkg"
SRC_KAMUS = r"C:\Users\USER\Downloads\20260907 19.30 - Titik Reklame Revisi Manual\Kamus_Kolom.xlsx"


# ---------------------------------------------------------------- geometri
def gpkg_point(blob):
    """Ambil (lon, lat) dari BLOB geometri GeoPackage berisi POINT."""
    if not blob or len(blob) < 8 or blob[0:2] != b"GP":
        return None
    flags = blob[3]
    env = (flags >> 1) & 0x07
    env_len = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(env)
    if env_len is None:
        return None
    wkb = blob[8 + env_len:]
    if len(wkb) < 21:
        return None
    fmt = "<" if wkb[0] == 1 else ">"
    gtype = struct.unpack(fmt + "I", wkb[1:5])[0]
    if gtype & 0xFF != 1:  # bukan POINT
        return None
    x, y = struct.unpack(fmt + "dd", wkb[5:21])
    return (x, y)


# ---------------------------------------------------------------- kamus kolom
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def baca_kamus(path):
    """{NAMA_KOLOM: label manusiawi} dari Kamus_Kolom.xlsx."""
    out = {}
    if not os.path.exists(path):
        return out
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row in root.iter(NS + "row"):
        vals = []
        for c in row:
            v = c.find(NS + "v")
            if v is None:
                vals.append(None)
            else:
                vals.append(shared[int(v.text)] if c.get("t") == "s" else v.text)
        rows.append(vals)
    for r in rows[1:]:
        if len(r) >= 3 and r[0] and r[2] and r[2] != "-":
            out[r[0]] = r[2]
    return out


# ---------------------------------------------------------------- grup kolom
GRUP = [
    ("identitas", "Identitas & Sumber",
     r"^(fid|FID_ASLI|UID|ID_TITIK|ID_POV|ID_WEBGIS|POV_KE|SUMBER|KEWENANGAN|KWN_SHP"
     r"|STAT_TTK|STATUS_POV|REVISI_BP|JENIS_EDIT|SURVEYOR|WAKTU|CARA_COCOK"
     r"|JARAK_COCOK_M|layer|path)$"),
    ("lokasi", "Lokasi & Jalan",
     r"^(LONG|LON|LAT|JARAK_M|NAMA_JALAN|KELAS_JLN|ROW_JALAN|KELURAHAN|KECAMATAN"
     r"|KOTA_KAB|STATUS_WPP|TIPE_KWSN|JENIS|TIPE|KLS_LOKASI|POLA_RUANG|ITBX"
     r"|KAT_ITBX|SLOPE|Leb_Keras|PITA_ROW|KEL_SIMP)$"),
    ("media", "Media & Dimensi",
     r"^(TIPE_MEDIA|JNS_MEDIA2|UKR_|LUAS_MEDIA|TEBAL_MDA|JML_MUKA|KEL_TINGGI|JPAND_"
     r"|LUAS_LAHAN|RUANG_AMAN|LUAS_NAUNG|MNMPL_STR|DASAR_UKR|LEBAR_BDG)"),
    ("skoring", "Skoring & Prioritas",
     r"^(SKOR_|KELAS_PREM|PRIORITAS|VOL_KEND|KAT_LHR|KAT_TIPE|POT_BANGKI|POT_PEDEST"
     r"|M_KATEGORI|TINJAU_GIS)"),
    ("pov", "POV (Point of View)", r"^(POV_|JML_POV)"),
    ("tarif", "Tarif & Nilai Ekonomi",
     r"^(M_TARIFSEW|TARIF_|NJOP_|SUMBER_NJ|UWT_KOM|TRF_NS_HR|M_LOK_DUR|M_EKO_"
     r"|NSR_PENUH|PJK_RKLM|PENYUSUT|RUAS_ZNT|TGI_|KONTAK_RB)"),
    ("listrik", "Listrik & Operasional",
     r"^(LANTAI_TN|DAYA_KVA|BIAYA_|PMK_KWH|TTL_LISTR|PMLHRAAN|ASURANSI|PERIZINAN)"),
    ("sewa", "Skenario Sewa NS1-NS7",
     r"^(PITA_CPM|SEWA_NS|CPM_NS|KDPITA_NS|STAT_NS|PAGAR_NS|SUKU_NS|TTL_NS"
     r"|BGN_SEWA|BGN_PAJAK|KLNGGR_NS)"),
]
GRUP_LAIN = ("lainnya", "Kolom Lainnya")


def grup_kolom(nama):
    for key, _label, pat in GRUP:
        if re.match(pat, nama):
            return key
    return GRUP_LAIN[0]


# ---------------------------------------------------------------- ekstraksi
def ekstrak(path, tabel, id_field):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    info = con.execute('PRAGMA table_info("' + tabel + '")').fetchall()
    cols = [(r[1], (r[2] or "").upper()) for r in info]

    feats = []
    for r in con.execute('SELECT * FROM "' + tabel + '"'):
        d = dict(r)
        blob = d.pop("geom", None)
        pt = gpkg_point(blob)
        if pt is None:  # cadangan: pakai kolom koordinat
            lon = d.get("LONG", d.get("LON"))
            lat = d.get("LAT")
            pt = (lon, lat) if lon is not None and lat is not None else None
        props = {k: v for k, v in d.items() if v is not None}
        geom = None
        if pt:
            geom = {"type": "Point", "coordinates": [round(pt[0], 8), round(pt[1], 8)]}
        feats.append({
            "type": "Feature",
            "id": d.get(id_field),
            "properties": props,
            "geometry": geom,
        })
    con.close()
    return cols, feats


def afinitas(decl):
    """
    Terjemahkan tipe kolom SQLite menjadi tipe isian di WebGIS, mengikuti
    aturan afinitas SQLite. Penting karena GeoPackage buatan QGIS memakai
    nama seperti MEDIUMINT dan DOUBLE, bukan sekadar INTEGER atau REAL.
    """
    d = (decl or "").upper()
    if "INT" in d:
        return "integer"
    if "CHAR" in d or "CLOB" in d or "TEXT" in d:
        return "text"
    if "REAL" in d or "FLOA" in d or "DOUB" in d or "NUM" in d or "DEC" in d:
        return "number"
    return "text"


def bangun_skema(cols, feats, kamus):
    """Daftar definisi kolom: tipe, label, grup, dan opsi dropdown."""
    out = []
    n = len(feats)
    for nama, decl in cols:
        if nama == "geom":
            continue
        vals = [f["properties"].get(nama) for f in feats]
        isi = [v for v in vals if v is not None]
        tipe = afinitas(decl)
        # opsi dropdown untuk teks berkardinalitas rendah
        opsi = None
        if tipe == "text" and isi:
            uniq = sorted({str(v) for v in isi})
            if len(uniq) <= 40 and len(uniq) < max(2, len(isi) * 0.5):
                opsi = uniq
        out.append(OrderedDict([
            ("name", nama),
            ("label", kamus.get(nama) or nama.replace("_", " ").title()),
            ("type", tipe),
            ("group", grup_kolom(nama)),
            ("filled", len(isi)),
            ("total", n),
            ("options", opsi),
        ]))
    return out


def tulis(path, obj, pretty=False):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False,
                  indent=2 if pretty else None,
                  separators=None if pretty else (",", ":"))
    return os.path.getsize(path)


def main():
    src_r = sys.argv[1] if len(sys.argv) > 1 else SRC_REKLAME
    src_p = sys.argv[2] if len(sys.argv) > 2 else SRC_POV
    kamus = baca_kamus(SRC_KAMUS)
    os.makedirs(DATA, exist_ok=True)

    rk_decl, rk_feats = ekstrak(src_r, "Reklame_Master_Gabungan", "ID_TITIK")
    pv_decl, pv_feats = ekstrak(src_p, "Titik_POV_Reklame_Batam", "ID_POV")

    n1 = tulis(os.path.join(DATA, "reklame.geojson"),
               {"type": "FeatureCollection", "features": rk_feats})
    n2 = tulis(os.path.join(DATA, "pov.geojson"),
               {"type": "FeatureCollection", "features": pv_feats})

    grup_label = OrderedDict([(k, l) for k, l, _ in GRUP] + [GRUP_LAIN])
    skema = {
        "generated": "tools/gpkg_to_geojson.py",
        "groups": grup_label,
        "reklame": {"idField": "ID_TITIK",
                    "fields": bangun_skema(rk_decl, rk_feats, kamus)},
        "pov": {"idField": "ID_POV", "parentField": "ID_TITIK",
                "fields": bangun_skema(pv_decl, pv_feats, kamus)},
    }
    n3 = tulis(os.path.join(DATA, "schema.json"), skema, pretty=True)

    tanpa_r = sum(1 for f in rk_feats if not f["geometry"])
    tanpa_p = sum(1 for f in pv_feats if not f["geometry"])
    print("reklame.geojson : %5d fitur, %6.2f MB, tanpa geometri: %d"
          % (len(rk_feats), n1 / 1e6, tanpa_r))
    print("pov.geojson     : %5d fitur, %6.2f MB, tanpa geometri: %d"
          % (len(pv_feats), n2 / 1e6, tanpa_p))
    print("schema.json     : %d + %d kolom, %.2f MB"
          % (len(skema["reklame"]["fields"]), len(skema["pov"]["fields"]), n3 / 1e6))


if __name__ == "__main__":
    main()
