# -*- coding: utf-8 -*-
"""
Hitung ulang seluruh kolom ringkasan POV dari geometri yang sebenarnya,
lalu satukan perubahan WebGIS ke data dasar.

Nilai diambil dari jarak geodetik antara setiap titik POV dan reklame
induknya, bukan dari kolom lama yang sudah tidak sesuai.

Tabel reklame : JML_POV, POV_RERATA, POV_MEDIAN, POV_MAKS, POV_MIN
Tabel POV     : JARAK_M (per baris) + JML_POV, POV_MEAN, POV_MEDIAN,
                POV_MAKS, POV_MIN (ringkasan induk, disalin ke tiap anak)

    python tools/hitung_pov.py <edits.json>
"""
import json
import os
import sys
import math
import statistics
import collections
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, HERE)
from gpkg_to_geojson import baca_kamus, bangun_skema, GRUP, GRUP_LAIN, SRC_KAMUS

KOL_RK = ["JML_POV", "POV_RERATA", "POV_MEDIAN", "POV_MAKS", "POV_MIN"]
KOL_PV = ["JML_POV", "POV_MEAN", "POV_MEDIAN", "POV_MAKS", "POV_MIN"]


def jarak(lon1, lat1, lon2, lat2):
    R = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def muat(nm, idf):
    g = json.load(open(os.path.join(DATA, nm), encoding="utf-8"))
    out = OrderedDict()
    for f in g["features"]:
        out[str(f.get("id") or f["properties"][idf])] = {
            "props": dict(f["properties"]),
            "geom": list(f["geometry"]["coordinates"]) if f["geometry"] else None,
            "pkey": None,
        }
    return out


def terap(base, entri):
    out = OrderedDict((k, dict(v, props=dict(v["props"]))) for k, v in base.items())
    n = collections.Counter()
    for k, e in (entri or {}).items():
        op = e.get("op")
        if op == "delete":
            if out.pop(k, None) is not None:
                n["hapus"] += 1
            continue
        cur = out.get(k) or {"props": {}, "geom": None, "pkey": None}
        for a, b in (e.get("props") or {}).items():
            if b is None:
                cur["props"].pop(a, None)
            else:
                cur["props"][a] = b
        if e.get("geom"):
            cur["geom"] = e["geom"]
        if e.get("_pkey"):
            cur["pkey"] = e["_pkey"]
        out[k] = cur
        n["baru" if op == "create" else "ubah"] += 1
    return out, n


def main():
    src = sys.argv[1]
    ed = json.load(open(src, encoding="utf-8"))
    RK, nrk = terap(muat("reklame.geojson", "ID_TITIK"), ed.get("reklame"))
    PV, npv = terap(muat("pov.geojson", "ID_POV"), ed.get("pov"))
    print("perubahan WebGIS diterapkan -> reklame %s | POV %s" % (dict(nrk), dict(npv)))
    print("hasil: %d reklame, %d POV" % (len(RK), len(PV)))

    # --- kelompokkan POV ke induknya
    kode_ke_key = {v["props"].get("ID_TITIK"): k for k, v in RK.items()}
    anak = collections.defaultdict(list)
    yatim = []
    for k, v in PV.items():
        pk = v.get("pkey") if v.get("pkey") in RK else kode_ke_key.get(v["props"].get("ID_TITIK"))
        if pk is None:
            yatim.append(k)
        else:
            anak[pk].append(k)
    print("POV bertaut induk: %d | yatim: %d" % (len(PV) - len(yatim), len(yatim)))

    # --- hitung dan isi
    ubah_rk = collections.Counter()
    ubah_pv = collections.Counter()
    kosong = 0
    for pk, rv in RK.items():
        anak_k = anak.get(pk, [])
        g = rv["geom"]
        d = []
        for ak in anak_k:
            av = PV[ak]
            if g and av["geom"]:
                d.append((round(jarak(g[0], g[1], av["geom"][0], av["geom"][1]), 1), ak))
        d.sort()
        nilai = [x[0] for x in d]

        if nilai:
            ring = {
                "JML_POV": len(nilai),
                "POV_RERATA": round(statistics.fmean(nilai), 1),
                "POV_MEDIAN": round(statistics.median(nilai), 1),
                "POV_MAKS": max(nilai),
                "POV_MIN": min(nilai),
            }
        else:
            ring = {"JML_POV": 0, "POV_RERATA": None, "POV_MEDIAN": None,
                    "POV_MAKS": None, "POV_MIN": None}
            if any(rv["props"].get(c) is not None for c in KOL_RK if c != "JML_POV"):
                kosong += 1

        for c in KOL_RK:
            lama = rv["props"].get(c)
            baru = ring[c]
            if baru is None:
                if c in rv["props"]:
                    del rv["props"][c]
                    ubah_rk[c] += 1
            else:
                if lama != baru:
                    ubah_rk[c] += 1
                rv["props"][c] = baru

        # ringkasan yang sama disalin ke setiap anak, plus JARAK_M per baris
        for nilai_jarak, ak in d:
            p = PV[ak]["props"]
            if p.get("JARAK_M") != nilai_jarak:
                ubah_pv["JARAK_M"] += 1
            p["JARAK_M"] = nilai_jarak
            p["ID_TITIK"] = rv["props"].get("ID_TITIK")
            for c in KOL_PV:
                sumber = "POV_RERATA" if c == "POV_MEAN" else c
                if p.get(c) != ring[sumber]:
                    ubah_pv[c] += 1
                p[c] = ring[sumber]

    print()
    print("kolom tabel reklame yang berubah nilainya:")
    for c in KOL_RK:
        print("   %-12s %5d baris" % (c, ubah_rk[c]))
    print("kolom tabel POV yang berubah nilainya:")
    for c in ["JARAK_M"] + KOL_PV:
        print("   %-12s %5d baris" % (c, ubah_pv[c]))
    print()
    print("titik tanpa POV yang nilai jaraknya dikosongkan: %d" % kosong)

    # --- tulis
    def tulis(path, obj, pretty=False):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2 if pretty else None,
                      separators=None if pretty else (",", ":"))
        return os.path.getsize(path)

    rk_out = [{"type": "Feature", "id": v["props"].get("ID_TITIK"), "properties": v["props"],
               "geometry": {"type": "Point", "coordinates": v["geom"]} if v["geom"] else None}
              for v in RK.values()]
    pv_out = [{"type": "Feature", "id": v["props"].get("ID_POV"), "properties": v["props"],
               "geometry": {"type": "Point", "coordinates": v["geom"]} if v["geom"] else None}
              for v in PV.values()]
    n1 = tulis(os.path.join(DATA, "reklame.geojson"),
               {"type": "FeatureCollection", "features": rk_out})
    n2 = tulis(os.path.join(DATA, "pov.geojson"),
               {"type": "FeatureCollection", "features": pv_out})

    kamus = baca_kamus(SRC_KAMUS)
    kamus.setdefault("POV_MEDIAN", "POV median GIS (m)")
    kolom = lambda feats: [(c, "REAL" if c not in ("JML_POV",) else "INTEGER")
                           for c in OrderedDict.fromkeys(
                               k for f in feats for k in f["props"])]
    skema = {
        "generated": "tools/hitung_pov.py",
        "groups": OrderedDict([(k, l) for k, l, _ in GRUP] + [GRUP_LAIN]),
        "reklame": {"idField": "ID_TITIK",
                    "fields": bangun_skema(kolom(RK.values()),
                                           [{"properties": v["props"]} for v in RK.values()], kamus)},
        "pov": {"idField": "ID_POV", "parentField": "ID_TITIK",
                "fields": bangun_skema(kolom(PV.values()),
                                       [{"properties": v["props"]} for v in PV.values()], kamus)},
    }
    tulis(os.path.join(DATA, "schema.json"), skema, pretty=True)
    tulis(os.path.join(DATA, "edits.json"),
          {"v": 1, "updated": None, "reklame": {}, "pov": {}}, pretty=True)
    print()
    print("reklame.geojson %5d fitur %6.2f MB | pov.geojson %5d fitur %6.2f MB"
          % (len(rk_out), n1 / 1e6, len(pv_out), n2 / 1e6))
    print("edits.json dikosongkan")


if __name__ == "__main__":
    main()
