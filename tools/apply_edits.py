# -*- coding: utf-8 -*-
"""
Terapkan data/edits.json ke GeoPackage asli, lalu hasilkan GPKG baru
(plus CSV) yang sudah berisi seluruh hasil penyuntingan dari WebGIS.

    python tools/apply_edits.py                    # keluaran ke folder keluaran/
    python tools/apply_edits.py --keluaran D:\\hasil

Titik yang ditandai dihapus di WebGIS tidak dibuang, melainkan diberi
kolom STATUS_EDIT = 'dihapus' agar tetap dapat ditelusuri. Gunakan
--buang-dihapus bila memang ingin membuangnya dari keluaran.
"""
import sqlite3
import json
import os
import shutil
import struct
import argparse
import csv as csvmod
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

SRC_REKLAME = r"C:\Users\USER\Downloads\20260907 19.30 - Titik Reklame Revisi Manual\Reklame_Master_Gabungan.gpkg"
SRC_POV = r"C:\Users\USER\Downloads\Titik_POV_Reklame_Batam\Titik_POV_Reklame_Batam.gpkg"

LAPISAN = {
    "reklame": {"tabel": "Reklame_Master_Gabungan", "id": "ID_TITIK",
                "lon": "LONG", "lat": "LAT", "sumber": SRC_REKLAME},
    "pov": {"tabel": "Titik_POV_Reklame_Batam", "id": "ID_POV",
            "lon": "LON", "lat": "LAT", "sumber": SRC_POV},
}
TAMBAHAN = [("STATUS_EDIT", "TEXT"), ("DIUBAH_OLEH", "TEXT"), ("DIUBAH_PADA", "TEXT")]


def blob_point(lon, lat, srs=4326):
    """Susun BLOB geometri GeoPackage untuk sebuah POINT."""
    hdr = b"GP" + bytes([0, 1]) + struct.pack("<i", srs)
    wkb = b"\x01" + struct.pack("<I", 1) + struct.pack("<dd", lon, lat)
    return hdr + wkb


def baca_point(blob):
    """Kebalikan blob_point: (lon, lat) atau None."""
    if not blob or len(blob) < 8 or bytes(blob[0:2]) != b"GP":
        return None
    env = (blob[3] >> 1) & 0x07
    env_len = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(env)
    if env_len is None:
        return None
    wkb = bytes(blob[8 + env_len:])
    if len(wkb) < 21:
        return None
    fmt = "<" if wkb[0] == 1 else ">"
    if struct.unpack(fmt + "I", wkb[1:5])[0] & 0xFF != 1:
        return None
    return struct.unpack(fmt + "dd", wkb[5:21])


def daftar_fungsi_st(con):
    """
    GeoPackage memasang trigger indeks spasial yang memanggil ST_MinX dan
    kawan-kawan. Fungsi itu tidak ada di SQLite bawaan Python, jadi kita
    sediakan sendiri — cukup untuk geometri titik seperti data ini.
    """
    def sumbu(i):
        def f(blob):
            p = baca_point(blob)
            return None if p is None else p[i]
        return f

    con.create_function("ST_MinX", 1, sumbu(0))
    con.create_function("ST_MaxX", 1, sumbu(0))
    con.create_function("ST_MinY", 1, sumbu(1))
    con.create_function("ST_MaxY", 1, sumbu(1))
    con.create_function("ST_IsEmpty", 1, lambda b: 0 if baca_point(b) else 1)


def muat_edits(path):
    if not os.path.exists(path):
        print("Tidak ada", path, "— tidak ada perubahan untuk diterapkan.")
        return {"reklame": {}, "pov": {}}
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    return {"reklame": d.get("reklame") or {}, "pov": d.get("pov") or {}}


def kolom_tabel(con, tabel):
    return [r[1] for r in con.execute('PRAGMA table_info("' + tabel + '")')]


def proses(nama, cfg, edits, keluaran, buang_dihapus):
    tabel, idf = cfg["tabel"], cfg["id"]
    tujuan = os.path.join(keluaran, os.path.basename(cfg["sumber"]))
    shutil.copyfile(cfg["sumber"], tujuan)

    con = sqlite3.connect(tujuan)
    con.row_factory = sqlite3.Row
    daftar_fungsi_st(con)
    cols = kolom_tabel(con, tabel)

    for nm, tp in TAMBAHAN:
        if nm not in cols:
            con.execute('ALTER TABLE "%s" ADD COLUMN "%s" %s' % (tabel, nm, tp))
    con.commit()
    cols = kolom_tabel(con, tabel)

    # peta ID -> fid untuk baris yang sudah ada
    fid_dari_id = {}
    for r in con.execute('SELECT fid, "%s" FROM "%s"' % (idf, tabel)):
        fid_dari_id[str(r[1])] = r[0]

    n_ubah = n_baru = n_hapus = n_geser = 0
    entri = edits.get(nama, {})

    for key, e in entri.items():
        op = e.get("op", "update")
        props = dict(e.get("props") or {})
        geom = e.get("geom")

        if op == "create":
            kolom = [c for c in props if c in cols]
            nilai = [props[c] for c in kolom]
            kolom += ["STATUS_EDIT", "DIUBAH_OLEH", "DIUBAH_PADA"]
            nilai += ["baru", e.get("by"), e.get("at")]
            if geom:
                kolom.append("geom")
                nilai.append(blob_point(geom[0], geom[1]))
            con.execute(
                'INSERT INTO "%s" (%s) VALUES (%s)'
                % (tabel, ",".join('"%s"' % c for c in kolom), ",".join("?" * len(kolom))),
                nilai)
            n_baru += 1
            continue

        fid = fid_dari_id.get(key)
        if fid is None:
            print("  ! lewati %s: tidak ditemukan di data asli" % key)
            continue

        if op == "delete":
            if buang_dihapus:
                con.execute('DELETE FROM "%s" WHERE fid=?' % tabel, (fid,))
            else:
                con.execute('UPDATE "%s" SET STATUS_EDIT=?, DIUBAH_OLEH=?, DIUBAH_PADA=? '
                            'WHERE fid=?' % tabel, ("dihapus", e.get("by"), e.get("at"), fid))
            n_hapus += 1
            continue

        setter, nilai = [], []
        for c, v in props.items():
            if c in cols:
                setter.append('"%s"=?' % c)
                nilai.append(v)
        if geom:
            setter.append('"geom"=?')
            nilai.append(blob_point(geom[0], geom[1]))
            n_geser += 1
        if not setter:
            continue
        setter += ['"STATUS_EDIT"=?', '"DIUBAH_OLEH"=?', '"DIUBAH_PADA"=?']
        nilai += ["diubah", e.get("by"), e.get("at"), fid]
        con.execute('UPDATE "%s" SET %s WHERE fid=?' % (tabel, ",".join(setter)), nilai)
        n_ubah += 1

    con.commit()

    # CSV pendamping
    csv_path = os.path.join(keluaran, nama + ".csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csvmod.writer(f, delimiter=";")
        isi = [c for c in cols if c != "geom"]
        w.writerow(isi)
        for r in con.execute('SELECT %s FROM "%s"' % (",".join('"%s"' % c for c in isi), tabel)):
            w.writerow(list(r))

    total = con.execute('SELECT COUNT(*) FROM "%s"' % tabel).fetchone()[0]
    con.close()
    print("%-8s -> %s" % (nama, tujuan))
    print("         %d baris; %d diubah (%d di antaranya digeser), %d baru, %d ditandai dihapus"
          % (total, n_ubah, n_geser, n_baru, n_hapus))
    print("         %s" % csv_path)


def main():
    ap = argparse.ArgumentParser(description="Terapkan edits.json ke GeoPackage asli.")
    ap.add_argument("--edits", default=os.path.join(DATA, "edits.json"))
    ap.add_argument("--keluaran", default=os.path.join(ROOT, "keluaran"))
    ap.add_argument("--buang-dihapus", action="store_true",
                    help="buang baris yang ditandai dihapus, bukan sekadar menandainya")
    a = ap.parse_args()

    edits = muat_edits(a.edits)
    n = sum(len(v) for v in edits.values())
    cap = datetime.now().strftime("%Y%m%d-%H%M")
    keluaran = os.path.join(a.keluaran, cap)
    os.makedirs(keluaran, exist_ok=True)

    print("Menerapkan %d perubahan ke %s\n" % (n, keluaran))
    for nama, cfg in LAPISAN.items():
        if not os.path.exists(cfg["sumber"]):
            print("%-8s ! berkas sumber tidak ditemukan: %s" % (nama, cfg["sumber"]))
            continue
        proses(nama, cfg, edits, keluaran, a.buang_dihapus)
    print("\nSelesai. Buka berkas .gpkg di QGIS untuk memeriksa hasilnya.")


if __name__ == "__main__":
    main()
