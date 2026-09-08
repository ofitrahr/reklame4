# -*- coding: utf-8 -*-
"""
Satukan dua jalur penyuntingan menjadi satu data dasar yang baru:

  A. Berkas GeoPackage hasil penyuntingan manual di QGIS (kode ID standar)
  B. data/edits.json dari WebGIS (penambahan/penghapusan/perubahan terakhir)

UID dipakai sebagai penanda karena hanya kolom itu yang konsisten di kedua
jalur. Titik POV yang induknya berganti kode ikut ditulis ulang ID_POV,
ID_TITIK, UID, dan ID_WEBGIS-nya supaya tautannya tidak putus.

    python tools/sinkron_webgis.py <reklame.gpkg> <pov.gpkg> <edits.json>
"""
import sqlite3
import json
import os
import sys
import struct
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, HERE)
from gpkg_to_geojson import gpkg_point, baca_kamus, bangun_skema, GRUP, GRUP_LAIN, SRC_KAMUS


def baca_gpkg(path):
    """Kembalikan (daftar kolom+tipe, daftar fitur) dari tabel fitur pertama."""
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    tabel = con.execute(
        "SELECT table_name FROM gpkg_contents WHERE data_type='features'").fetchone()[0]
    cols = [(r[1], (r[2] or "").upper())
            for r in con.execute('PRAGMA table_info("%s")' % tabel)]
    feats = []
    for r in con.execute('SELECT * FROM "%s"' % tabel):
        d = dict(r)
        pt = gpkg_point(d.pop("geom", None))
        if pt is None:
            lon, lat = d.get("LONG", d.get("LON")), d.get("LAT")
            pt = (lon, lat) if lon is not None and lat is not None else None
        feats.append({
            "props": {k: v for k, v in d.items() if v is not None},
            "geom": [round(pt[0], 8), round(pt[1], 8)] if pt else None,
        })
    con.close()
    return cols, feats, tabel


def terapkan_pov(pov_feats, entri, peta_kode):
    """
    Terapkan perubahan POV dari WebGIS, sekaligus samakan nama induk yang
    sudah berganti kode. peta_kode: {kode induk lama -> (kode baru, uid baru)}
    """
    hasil = OrderedDict()
    for f in pov_feats:
        hasil[f["props"]["ID_POV"]] = f
    catat = {"hapus": [], "baru": [], "ubah": [], "ganti_nama": []}

    for kunci, e in (entri or {}).items():
        op = e.get("op")
        if op == "delete":
            if hasil.pop(kunci, None) is not None:
                catat["hapus"].append(kunci)
            continue
        props = {k: v for k, v in (e.get("props") or {}).items() if v is not None}
        if op == "create":
            f = {"props": props, "geom": e.get("geom")}
            hasil[props["ID_POV"]] = f
            catat["baru"].append(props["ID_POV"])
        else:                                    # update
            f = hasil.get(kunci)
            if f is None:
                continue
            f["props"].update(props)
            if e.get("geom"):
                f["geom"] = e["geom"]
            catat["ubah"].append(kunci)

    # samakan kode induk yang berubah
    keluar = OrderedDict()
    for idpov, f in hasil.items():
        p = f["props"]
        lama = p.get("ID_TITIK")
        if lama in peta_kode:
            baru, uid_baru = peta_kode[lama]
            ke = p.get("POV_KE")
            idbaru = "%s-POV-%02d" % (baru, int(ke)) if ke else idpov.replace(lama, baru)
            p["ID_TITIK"] = baru
            p["ID_WEBGIS"] = baru
            p["UID"] = uid_baru
            p["ID_POV"] = idbaru
            catat["ganti_nama"].append((idpov, idbaru))
            keluar[idbaru] = f
        else:
            keluar[idpov] = f
    return keluar, catat


def tulis(path, obj, pretty=False):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False,
                  indent=2 if pretty else None,
                  separators=None if pretty else (",", ":"))
    return os.path.getsize(path)


def main():
    src_rk, src_pv, src_ed = sys.argv[1], sys.argv[2], sys.argv[3]
    ed = json.load(open(src_ed, encoding="utf-8"))

    rk_cols, rk_feats, _ = baca_gpkg(src_rk)
    pv_cols, pv_feats, _ = baca_gpkg(src_pv)
    print("sumber: reklame %d fitur | POV %d fitur" % (len(rk_feats), len(pv_feats)))

    # --- indeks reklame menurut UID dan kode
    per_uid = {f["props"].get("UID"): f for f in rk_feats}

    # --- terapkan perubahan reklame dari WebGIS yang belum ada di berkas QGIS
    per_kode = {f["props"].get("ID_TITIK"): f for f in rk_feats}
    n_ubah = 0
    for kunci, e in (ed.get("reklame") or {}).items():
        if e.get("op") != "update":
            continue
        f = per_kode.get(kunci)
        if f is None:                    # kodenya sudah berganti di berkas QGIS
            continue
        for k, v in (e.get("props") or {}).items():
            if v is None:
                continue
            if f["props"].get(k) != v:
                f["props"][k] = v
                n_ubah += 1
    print("perubahan atribut WebGIS yang diterapkan ke reklame: %d nilai" % n_ubah)

    # --- peta kode induk lama -> baru
    # Titik lama dijembatani lewat UID pada data dasar sebelumnya; titik baru
    # hasil WebGIS belum punya UID yang sama, jadi dicocokkan lewat koordinat.
    peta_kode = {}
    lama_path = os.path.join(DATA, "reklame.geojson")
    if os.path.exists(lama_path):
        lama = json.load(open(lama_path, encoding="utf-8"))
        for f0 in lama["features"]:
            uid = f0["properties"].get("UID")
            kode_lama = f0["properties"].get("ID_TITIK")
            f = per_uid.get(uid)
            if f is not None and f["props"].get("ID_TITIK") != kode_lama:
                peta_kode[kode_lama] = (f["props"]["ID_TITIK"], uid)

    def dekat(a, b, toleransi=1e-6):
        return a and b and abs(a[0] - b[0]) < toleransi and abs(a[1] - b[1]) < toleransi

    for kunci, e in (ed.get("reklame") or {}).items():
        if e.get("op") != "create":
            continue
        kode_sementara = (e.get("props") or {}).get("ID_TITIK")
        for f in rk_feats:
            if dekat(f["geom"], e.get("geom")):
                peta_kode[kode_sementara] = (f["props"]["ID_TITIK"], f["props"].get("UID"))
                break
        else:
            print("  ! titik baru %s tidak ditemukan padanannya di berkas QGIS" % kode_sementara)
    print("kode induk yang berubah (%d):" % len(peta_kode))
    for a, b in sorted(peta_kode.items()):
        print("    %-24s -> %-24s (%s)" % (a, b[0], b[1]))

    pov, catat = terapkan_pov(pv_feats, ed.get("pov"), peta_kode)
    print("POV: -%d dihapus, +%d baru, %d diubah, %d diganti nama -> total %d"
          % (len(catat["hapus"]), len(catat["baru"]), len(catat["ubah"]),
             len(catat["ganti_nama"]), len(pov)))
    for a, b in catat["ganti_nama"]:
        print("    %-30s -> %s" % (a, b))

    # --- pemeriksaan: setiap POV harus punya induk
    kode_rk = {f["props"].get("ID_TITIK") for f in rk_feats}
    yatim = [k for k, f in pov.items() if f["props"].get("ID_TITIK") not in kode_rk]
    print("POV tanpa induk setelah sinkron: %d" % len(yatim))
    for k in yatim[:10]:
        print("    ", k, "-> induk dicari:", pov[k]["props"].get("ID_TITIK"))

    # --- tulis data dasar baru
    os.makedirs(DATA, exist_ok=True)
    rk_out = [{"type": "Feature", "id": f["props"].get("ID_TITIK"),
               "properties": f["props"],
               "geometry": {"type": "Point", "coordinates": f["geom"]} if f["geom"] else None}
              for f in rk_feats]
    pv_out = [{"type": "Feature", "id": k,
               "properties": f["props"],
               "geometry": {"type": "Point", "coordinates": f["geom"]} if f["geom"] else None}
              for k, f in pov.items()]
    n1 = tulis(os.path.join(DATA, "reklame.geojson"),
               {"type": "FeatureCollection", "features": rk_out})
    n2 = tulis(os.path.join(DATA, "pov.geojson"),
               {"type": "FeatureCollection", "features": pv_out})

    kamus = baca_kamus(SRC_KAMUS)
    grup_label = OrderedDict([(k, l) for k, l, _ in GRUP] + [GRUP_LAIN])
    skema = {
        "generated": "tools/sinkron_webgis.py",
        "groups": grup_label,
        "reklame": {"idField": "ID_TITIK",
                    "fields": bangun_skema(rk_cols, [{"properties": f["props"]} for f in rk_feats], kamus)},
        "pov": {"idField": "ID_POV", "parentField": "ID_TITIK",
                "fields": bangun_skema(pv_cols, [{"properties": f["props"]} for f in pov.values()], kamus)},
    }
    n3 = tulis(os.path.join(DATA, "schema.json"), skema, pretty=True)
    tulis(os.path.join(DATA, "edits.json"),
          {"v": 1, "updated": None, "reklame": {}, "pov": {}}, pretty=True)

    print()
    print("reklame.geojson : %5d fitur  %6.2f MB" % (len(rk_out), n1 / 1e6))
    print("pov.geojson     : %5d fitur  %6.2f MB" % (len(pv_out), n2 / 1e6))
    print("schema.json     : %d + %d kolom" % (len(skema["reklame"]["fields"]),
                                               len(skema["pov"]["fields"])))
    print("edits.json      : dikosongkan (perubahan sudah menyatu ke data dasar)")


if __name__ == "__main__":
    main()
