# -*- coding: utf-8 -*-
"""
Ekspor data ke GeoPackage lengkap dengan seluruh kolom.

    python tools/ekspor_gpkg.py [keluaran.gpkg]

Menghasilkan satu berkas berisi dua lapisan, Reklame dan Titik_POV, dengan
tipe kolom mengikuti schema.json dan indeks spasial R-tree agar cepat dibuka
di QGIS.
"""
import json
import os
import sys
import struct
import sqlite3
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

WKT_4326 = (
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,'
    'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],'
    'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
    'AUTHORITY["EPSG","4326"]]'
)
TIPE_SQL = {"integer": "MEDIUMINT", "number": "DOUBLE", "text": "TEXT"}


def blob_point(lon, lat, srs=4326):
    """BLOB geometri GeoPackage untuk sebuah POINT, dengan envelope."""
    flags = 0b00000011                      # little endian + envelope XY
    hdr = b"GP" + bytes([0, flags]) + struct.pack("<i", srs)
    env = struct.pack("<dddd", lon, lon, lat, lat)
    wkb = b"\x01" + struct.pack("<I", 1) + struct.pack("<dd", lon, lat)
    return hdr + env + wkb


def siapkan(con):
    con.execute("PRAGMA application_id = 1196444487")   # 'GPKG'
    con.execute("PRAGMA user_version = 10300")          # 1.3.0
    con.executescript("""
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
      identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id)
        REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL, m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT uk_gc_table_name UNIQUE (table_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name)
        REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id)
        REFERENCES gpkg_spatial_ref_sys (srs_id));
    """)
    con.executemany(
        "INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)",
        [("Undefined cartesian SRS", -1, "NONE", -1, "undefined",
          "undefined cartesian coordinate reference system"),
         ("Undefined geographic SRS", 0, "NONE", 0, "undefined",
          "undefined geographic coordinate reference system"),
         ("WGS 84 geodetic", 4326, "EPSG", 4326, WKT_4326,
          "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid")])


def tulis_lapisan(con, nama, keterangan, kolom, feats):
    """Buat tabel fitur, isi datanya, dan bangun indeks spasialnya."""
    kol_sql = ", ".join('"%s" %s' % (n, TIPE_SQL.get(t, "TEXT")) for n, t in kolom)
    con.execute('CREATE TABLE "%s" (fid INTEGER PRIMARY KEY AUTOINCREMENT, '
                'geom POINT, %s)' % (nama, kol_sql))

    nama_kol = [n for n, _t in kolom]
    sql = ('INSERT INTO "%s" (geom, %s) VALUES (?, %s)'
           % (nama, ",".join('"%s"' % n for n in nama_kol),
              ",".join("?" * len(nama_kol))))
    xs, ys = [], []
    baris = []
    for f in feats:
        p = f["properties"]
        g = f["geometry"]["coordinates"] if f["geometry"] else None
        if g:
            xs.append(g[0])
            ys.append(g[1])
        baris.append([blob_point(g[0], g[1]) if g else None] +
                     [p.get(n) for n in nama_kol])
    con.executemany(sql, baris)

    con.execute("INSERT INTO gpkg_contents (table_name, data_type, identifier, "
                "description, last_change, min_x, min_y, max_x, max_y, srs_id) "
                "VALUES (?,'features',?,?,?,?,?,?,?,4326)",
                (nama, nama, keterangan,
                 datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                 min(xs), min(ys), max(xs), max(ys)))
    con.execute("INSERT INTO gpkg_geometry_columns VALUES (?,'geom','POINT',4326,0,0)",
                (nama,))

    # indeks spasial: diisi langsung, tanpa perlu fungsi ST_* saat penulisan
    rt = "rtree_%s_geom" % nama
    con.execute('CREATE VIRTUAL TABLE "%s" USING rtree(id, minx, maxx, miny, maxy)' % rt)
    con.execute('INSERT INTO "%s" SELECT fid, "LONG_X","LONG_X","LAT_Y","LAT_Y" '
                'FROM (SELECT fid, 0 AS "LONG_X", 0 AS "LAT_Y" FROM "%s" WHERE 0)'
                % (rt, nama))
    isi = []
    for fid, blob in con.execute('SELECT fid, geom FROM "%s"' % nama):
        if not blob:
            continue
        x, y = struct.unpack("<dd", bytes(blob)[-16:])
        isi.append((fid, x, x, y, y))
    con.executemany('INSERT INTO "%s" VALUES (?,?,?,?,?)' % rt, isi)
    con.execute("INSERT INTO gpkg_extensions (table_name, column_name, extension_name, "
                "definition, scope) VALUES (?,'geom','gpkg_rtree_index',"
                "'http://www.geopackage.org/spec120/#extension_rtree','write-only')",
                (nama,))
    return len(baris)


def main():
    keluar = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        ROOT, "keluaran", "Reklame_Batam_Lengkap.gpkg")
    os.makedirs(os.path.dirname(keluar), exist_ok=True)
    if os.path.exists(keluar):
        os.remove(keluar)

    skema = json.load(open(os.path.join(DATA, "schema.json"), encoding="utf-8"))
    con = sqlite3.connect(keluar)
    siapkan(con)
    con.executescript("""
    CREATE TABLE gpkg_extensions (
      table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL,
      definition TEXT NOT NULL, scope TEXT NOT NULL,
      CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name));
    """)

    total = {}
    for kunci, nama, ket in [("reklame", "Reklame", "Titik reklame Kota Batam"),
                             ("pov", "Titik_POV", "Titik POV (point of view) reklame")]:
        gj = json.load(open(os.path.join(DATA, "%s.geojson" % kunci), encoding="utf-8"))
        kolom = [(f["name"], f["type"]) for f in skema[kunci]["fields"]
                 if f["name"] != "fid"]
        total[nama] = tulis_lapisan(con, nama, ket, kolom, gj["features"])
        print("lapisan %-10s : %5d fitur, %3d kolom" % (nama, total[nama], len(kolom)))

    con.commit()
    con.execute("VACUUM")
    con.close()
    print()
    print("tersimpan: %s  (%.2f MB)" % (keluar, os.path.getsize(keluar) / 1e6))


if __name__ == "__main__":
    main()
