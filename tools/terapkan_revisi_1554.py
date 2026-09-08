# -*- coding: utf-8 -*-
"""
Terapkan berkas revisi titik reklame ke data, sekaligus:

  1. memulihkan nilai rupiah yang melipat menjadi negatif akibat kolom
     bertipe 4 byte pada GeoPackage,
  2. mengembalikan perbaikan UID-2420 yang tidak terbawa di berkas revisi,
  3. menghapus satu titik beserta seluruh POV miliknya.

    python tools/terapkan_revisi_1554.py <revisi.gpkg>
"""
import json
import os
import sqlite3
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, HERE)
from gpkg_to_geojson import gpkg_point, baca_kamus, bangun_skema, GRUP, GRUP_LAIN, SRC_KAMUS

LIPAT = 2 ** 32          # kolom 4 byte: nilai di atas 2^31 muncul sebagai negatif
HAPUS_UID = "UID-2391"   # duplikat dari UID-2396, 39 m di persimpangan yang sama
PULIHKAN_UID = "UID-2420"
KOL_PULIHKAN = ["LUAS_NAUNG", "LANTAI_TN", "SEWA_NSA", "SEWA_NSC",
                "CPM_NSA", "CPM_NSC", "KDPITA_NSA", "KDPITA_NSC"]


def tulis(path, obj, pretty=False):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2 if pretty else None,
                  separators=None if pretty else (",", ":"))
    return os.path.getsize(path)


def main():
    src = sys.argv[1]
    con = sqlite3.connect(src)
    con.row_factory = sqlite3.Row
    tabel = con.execute("SELECT table_name FROM gpkg_contents "
                        "WHERE data_type='features'").fetchone()[0]
    tipe = {r[1]: (r[2] or "TEXT").upper()
            for r in con.execute('PRAGMA table_info("%s")' % tabel)}

    lama = {f["properties"].get("UID"): f["properties"] for f in
            json.load(open(os.path.join(DATA, "reklame.geojson"),
                           encoding="utf-8"))["features"]}

    feats, pulih, hapus = [], [], None
    n_lipat = 0
    for r in con.execute('SELECT * FROM "%s"' % tabel):
        d = dict(r)
        pt = gpkg_point(d.pop("geom", None))
        d.pop("fid", None)
        uid = d.get("UID")

        # 1. pulihkan nilai yang melipat
        for c, v in list(d.items()):
            if isinstance(v, int) and v < 0 and "INT" in tipe.get(c, ""):
                d[c] = v + LIPAT
                n_lipat += 1
                pulih.append((uid, d.get("ID_TITIK"), c, v, d[c]))

        # 2. kembalikan perbaikan yang tidak terbawa
        if uid == PULIHKAN_UID:
            for c in KOL_PULIHKAN:
                if c in lama.get(uid, {}):
                    d[c] = lama[uid][c]

        # 3. buang titik yang diminta dihapus
        if uid == HAPUS_UID:
            hapus = d
            continue

        props = {k: v for k, v in d.items() if v is not None}
        feats.append({"type": "Feature", "id": props.get("ID_TITIK"),
                      "properties": props,
                      "geometry": {"type": "Point",
                                   "coordinates": [round(pt[0], 8), round(pt[1], 8)]}
                      if pt else None})
    con.close()

    print("nilai rupiah yang dipulihkan dari negatif: %d" % n_lipat)
    for u, i, c, a, b in pulih:
        print("   %-10s %-24s %-11s %15s -> %s"
              % (u, i, c, format(a, ",d"), format(b, ",d")))
    print()
    if hapus:
        print("titik dihapus: %s (%s) — %s, %s"
              % (HAPUS_UID, hapus.get("ID_TITIK"), hapus.get("NAMA_JALAN"),
                 hapus.get("KELURAHAN")))
    else:
        print("! %s tidak ditemukan di berkas revisi" % HAPUS_UID)

    # ---- POV milik titik yang dihapus
    pv = json.load(open(os.path.join(DATA, "pov.geojson"), encoding="utf-8"))
    kode_hapus = hapus.get("ID_TITIK") if hapus else None
    sisa, dibuang = [], []
    for f in pv["features"]:
        if f["properties"].get("ID_TITIK") == kode_hapus:
            dibuang.append(f["properties"].get("ID_POV"))
        else:
            sisa.append(f)
    pv["features"] = sisa
    print("POV ikut dihapus: %d  %s" % (len(dibuang), dibuang))

    n1 = tulis(os.path.join(DATA, "reklame.geojson"),
               {"type": "FeatureCollection", "features": feats})
    n2 = tulis(os.path.join(DATA, "pov.geojson"), pv)

    # ---- schema.json
    kamus = baca_kamus(SRC_KAMUS)
    for k, v in {"POV_MEDIAN": "POV median GIS (m)",
                 "POV_RER_T8": "POV rerata dasar Tarif 8 (m)",
                 "POV_MAK_T8": "POV maksimum dasar Tarif 8 (m)",
                 "POV_MIN_T8": "POV minimum dasar Tarif 8 (m)",
                 "JML_POV_T8": "Jumlah POV dasar Tarif 8"}.items():
        kamus[k] = v
    for ns in ["1", "A", "B", "4", "5", "C", "D"]:
        kamus["SEWA_NS" + ns] = "Sewa NS %s (Rp/th)" % ns
        kamus["CPM_NS" + ns] = "CPM wajib NS %s" % ns
        kamus["KDPITA_NS" + ns] = "Status kisaran NS %s" % ns
        kamus["STAT_NS" + ns] = "Status NS %s" % ns
        kamus["PAGAR_NS" + ns] = "Batas atas NS %s" % ns

    from hitung_pov import tipe_asli, SRC_GPKG_PV
    prk = [f["properties"] for f in feats]
    ppv = [f["properties"] for f in sisa]

    def kolom(props_list, asli):
        urut = OrderedDict.fromkeys(k for p in props_list for k in p)
        out = []
        for c in urut:
            if c in asli:
                out.append((c, asli[c]))
                continue
            nilai = [p[c] for p in props_list if p.get(c) is not None]
            if nilai and all(isinstance(v, int) and not isinstance(v, bool) for v in nilai):
                out.append((c, "INTEGER"))
            elif nilai and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                               for v in nilai):
                out.append((c, "REAL"))
            else:
                out.append((c, "TEXT"))
        return out

    skema = {
        "generated": "tools/terapkan_revisi_1554.py",
        "groups": OrderedDict([(k, l) for k, l, _ in GRUP] + [GRUP_LAIN]),
        "reklame": {"idField": "ID_TITIK",
                    "fields": bangun_skema(kolom(prk, tipe), [{"properties": p} for p in prk], kamus)},
        "pov": {"idField": "ID_POV", "parentField": "ID_TITIK",
                "fields": bangun_skema(kolom(ppv, tipe_asli(SRC_GPKG_PV)),
                                       [{"properties": p} for p in ppv], kamus)},
    }
    tulis(os.path.join(DATA, "schema.json"), skema, pretty=True)
    print()
    print("reklame.geojson: %d fitur, %.2f MB | pov.geojson: %d fitur, %.2f MB"
          % (len(feats), n1 / 1e6, len(sisa), n2 / 1e6))


if __name__ == "__main__":
    main()
