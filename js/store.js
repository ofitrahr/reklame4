// Lapisan data: memuat data dasar, menerapkan lapisan perubahan (overlay),
// menyediakan operasi edit yang dapat diurungkan, dan menyimpan pekerjaan
// yang belum terkirim ke localStorage agar tidak hilang saat halaman ditutup.

import { jarakM } from './util.js';

const LS_PENDING = 'reklame3.pending.v1';
const LS_CFG = 'reklame3.config.v1';

/** Kolom identitas: tidak boleh diubah lewat form biasa. */
export const KUNCI = { reklame: 'ID_TITIK', pov: 'ID_POV' };
/** Kolom koordinat yang ikut disinkronkan saat titik digeser. */
const KOL_LON = { reklame: 'LONG', pov: 'LON' };
const KOL_LAT = { reklame: 'LAT', pov: 'LAT' };

export const Store = {
  schema: null,
  fieldOf: { reklame: new Map(), pov: new Map() },   // nama kolom -> definisi
  base: { reklame: new Map(), pov: new Map() },      // _key -> {props, geom}
  order: { reklame: [], pov: [] },                   // urutan asli
  overlay: { reklame: new Map(), pov: new Map() },   // _key -> entri perubahan
  remote: { reklame: {}, pov: {} },                  // salinan overlay dari GitHub
  pending: new Set(),                                // "layer:_key" belum terkirim
  anak: new Map(),                                   // _key reklame -> [_key pov]
  sha: null,                                         // sha edits.json di GitHub
  cfg: {},
  terakhirUbah: [],                                  // "layer:_key" dari transaksi terakhir
  _undo: [], _redo: [], _tx: null,
  _cache: { reklame: new Map(), pov: new Map() },
  _sub: new Set(),

  // -------------------------------------------------------------- pemuatan
  async muat(onProgress = () => {}) {
    onProgress(5, 'Memuat skema kolom…');
    this.schema = await (await fetch('data/schema.json', { cache: 'no-cache' })).json();
    for (const ly of ['reklame', 'pov']) {
      for (const f of this.schema[ly].fields) this.fieldOf[ly].set(f.name, f);
    }

    onProgress(15, 'Memuat 2.484 titik reklame…');
    const rk = await (await fetch('data/reklame.geojson', { cache: 'no-cache' })).json();
    onProgress(55, 'Memuat titik POV…');
    const pv = await (await fetch('data/pov.geojson', { cache: 'no-cache' })).json();

    onProgress(70, 'Menyusun indeks…');
    this._isi('reklame', rk.features, 'ID_TITIK');
    this._isi('pov', pv.features, 'ID_POV');
    this._indeksAnak();
    this.cfg = this._muatCfg();
    this._muatPending();
    this._bangunCache();
    onProgress(85, 'Siap.');
  },

  _isi(ly, feats, idField) {
    for (const f of feats) {
      const key = String(f.id ?? f.properties[idField]);
      this.base[ly].set(key, {
        props: f.properties,
        geom: f.geometry ? f.geometry.coordinates.slice() : null,
      });
      this.order[ly].push(key);
    }
  },

  /** Hubungkan POV ke reklame induknya lewat nilai ID_TITIK saat pemuatan. */
  _indeksAnak() {
    const byIdTitik = new Map();
    for (const [key, r] of this.base.reklame) byIdTitik.set(r.props.ID_TITIK, key);
    this.yatim = [];
    for (const [key, p] of this.base.pov) {
      const pk = byIdTitik.get(p.props.ID_TITIK);
      if (pk) {
        p._pkey = pk;
        if (!this.anak.has(pk)) this.anak.set(pk, []);
        this.anak.get(pk).push(key);
      } else {
        p._pkey = null;
        this.yatim.push(key);
      }
    }
  },

  // -------------------------------------------------------------- pembacaan
  /** Fitur efektif = data dasar + perubahan. Selalu dari cache. */
  get(ly, key) { return this._cache[ly].get(key); },
  semua(ly) { return this._cache[ly]; },

  _hitung(ly, key) {
    const b = this.base[ly].get(key);
    const e = this.overlay[ly].get(key);
    if (!b && !e) return undefined;
    if (!b) {  // fitur baru
      return {
        key, layer: ly, props: { ...e.props }, geom: e.geom ? e.geom.slice() : null,
        pkey: e._pkey ?? null, status: e.op === 'delete' ? 'del' : 'new',
        by: e.by, at: e.at, ubah: new Set(Object.keys(e.props || {})),
      };
    }
    const props = { ...b.props };
    let geom = b.geom ? b.geom.slice() : null;
    let status = 'base', ubah = new Set();
    if (e) {
      if (e.props) for (const [k, v] of Object.entries(e.props)) {
        if (v === null) delete props[k]; else props[k] = v;
        ubah.add(k);
      }
      if (e.geom) { geom = e.geom.slice(); ubah.add('_geom'); }
      status = e.op === 'delete' ? 'del' : (ubah.size ? 'mod' : 'base');
    }
    return { key, layer: ly, props, geom, pkey: b._pkey ?? null, status,
             by: e?.by, at: e?.at, ubah };
  },

  _bangunCache() {
    for (const ly of ['reklame', 'pov']) {
      const c = new Map();
      for (const key of this.order[ly]) c.set(key, this._hitung(ly, key));
      for (const key of this.overlay[ly].keys()) {
        if (!c.has(key)) c.set(key, this._hitung(ly, key));
      }
      this._cache[ly] = c;
    }
    this._ulangIndeksBaru();
  },

  /** Segarkan relasi induk-anak untuk fitur POV hasil penambahan. */
  _ulangIndeksBaru() {
    for (const [key, f] of this._cache.pov) {
      if (!f || !f.pkey) continue;
      const daftar = this.anak.get(f.pkey);
      if (!daftar) this.anak.set(f.pkey, [key]);
      else if (!daftar.includes(key)) daftar.push(key);
    }
  },

  _segar(ly, key) {
    const f = this._hitung(ly, key);
    if (f) this._cache[ly].set(key, f); else this._cache[ly].delete(key);
    return f;
  },

  anakDari(keyReklame) {
    return (this.anak.get(keyReklame) || [])
      .filter((k) => { const f = this.get('pov', k); return f && f.status !== 'del'; });
  },

  // -------------------------------------------------------------- transaksi
  /** Bungkus beberapa perubahan menjadi satu langkah undo. */
  tx(label, fn) {
    const luar = !this._tx;
    if (luar) this._tx = { label, snap: new Map() };
    try { fn(); } finally {
      if (luar) {
        const t = this._tx; this._tx = null;
        if (t.snap.size) {
          this._undo.push(t); this._redo.length = 0;
          if (this._undo.length > 200) this._undo.shift();
          this.terakhirUbah = [...t.snap.keys()];
          this._simpanPending();
          this._pancar();
        }
      }
    }
  },

  _catat(ly, key) {
    if (!this._tx || this._tx.snap.has(ly + ':' + key)) return;
    const e = this.overlay[ly].get(key);
    this._tx.snap.set(ly + ':' + key, e ? JSON.parse(JSON.stringify(e)) : null);
  },

  _entri(ly, key) {
    let e = this.overlay[ly].get(key);
    if (!e) {
      e = { op: this.base[ly].has(key) ? 'update' : 'create', props: {} };
      this.overlay[ly].set(key, e);
    }
    if (!e.props) e.props = {};
    e.by = this.cfg.editor || 'anonim';
    e.at = new Date().toISOString();
    this.pending.add(ly + ':' + key);
    return e;
  },

  // -------------------------------------------------------------- operasi
  /** Ubah satu nilai atribut. */
  setNilai(ly, key, field, nilai) {
    const f = this.get(ly, key);
    if (!f) return;
    const lama = f.props[field] ?? null;
    const baru = this._normalisasi(ly, field, nilai);
    if (String(lama ?? '') === String(baru ?? '')) return;
    this.tx('Ubah ' + field, () => {
      this._catat(ly, key);
      const e = this._entri(ly, key);
      const asli = this.base[ly].get(key)?.props?.[field] ?? null;
      if (e.op !== 'create' && String(asli ?? '') === String(baru ?? '')) delete e.props[field];
      else e.props[field] = baru;
      this._bersihkan(ly, key, e);
      this._segar(ly, key);
    });
  },

  _normalisasi(ly, field, v) {
    const def = this.fieldOf[ly].get(field);
    if (v === '' || v === null || v === undefined) return null;
    if (def && (def.type === 'number' || def.type === 'integer')) {
      const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
      if (!isFinite(n)) return null;
      return def.type === 'integer' ? Math.round(n) : n;
    }
    return String(v);
  },

  /** Pindahkan titik; kolom koordinat dan JARAK_M ikut dihitung ulang. */
  pindah(ly, key, lon, lat) {
    const f = this.get(ly, key);
    if (!f) return;
    this.tx('Geser titik', () => {
      this._catat(ly, key);
      const e = this._entri(ly, key);
      e.geom = [+lon.toFixed(8), +lat.toFixed(8)];
      e.props[KOL_LON[ly]] = e.geom[0];
      e.props[KOL_LAT[ly]] = e.geom[1];
      this._segar(ly, key);
      if (ly === 'reklame') for (const k of this.anakDari(key)) this._hitungJarak(k);
      else this._hitungJarak(key);
    });
  },

  /** Perbarui JARAK_M satu POV terhadap reklame induknya. */
  _hitungJarak(keyPov) {
    const p = this.get('pov', keyPov);
    if (!p || !p.geom || !p.pkey) return;
    const r = this.get('reklame', p.pkey);
    if (!r || !r.geom) return;
    const d = +jarakM(p.geom[0], p.geom[1], r.geom[0], r.geom[1]).toFixed(1);
    if (Math.abs((p.props.JARAK_M ?? -1) - d) < 0.05) return;
    this._catat('pov', keyPov);
    const e = this._entri('pov', keyPov);
    e.props.JARAK_M = d;
    this._segar('pov', keyPov);
  },

  /** Titik reklame baru pada koordinat tertentu. */
  tambahReklame(lon, lat) {
    const key = 'NEW-R-' + this._acak();
    const id = this._idBaru('reklame');
    let hasil;
    this.tx('Tambah reklame', () => {
      this._catat('reklame', key);
      const e = { op: 'create', props: {}, geom: [+lon.toFixed(8), +lat.toFixed(8)] };
      this.overlay.reklame.set(key, e);
      Object.assign(e.props, {
        ID_TITIK: id, UID: id, SUMBER: 'Tambahan WebGIS', KOTA_KAB: 'KOTA BATAM',
        STAT_TTK: 'AKTIF', JENIS_EDIT: 'tambah',
        LONG: e.geom[0], LAT: e.geom[1], JML_POV: 0,
      });
      e.by = this.cfg.editor || 'anonim';
      e.at = new Date().toISOString();
      this.pending.add('reklame:' + key);
      hasil = this._segar('reklame', key);
    });
    return hasil;
  },

  /** Titik POV baru yang menempel pada satu reklame induk. */
  tambahPov(keyInduk, lon, lat) {
    const induk = this.get('reklame', keyInduk);
    if (!induk) return null;
    const key = 'NEW-P-' + this._acak();
    const saudara = this.anakDari(keyInduk).map((k) => this.get('pov', k));
    const ke = saudara.reduce((m, s) => Math.max(m, s.props.POV_KE || 0), 0) + 1;
    const idTitik = induk.props.ID_TITIK;
    let hasil;
    this.tx('Tambah POV', () => {
      this._catat('pov', key);
      const e = {
        op: 'create', _pkey: keyInduk, geom: [+lon.toFixed(8), +lat.toFixed(8)], props: {},
      };
      this.overlay.pov.set(key, e);
      Object.assign(e.props, {
        ID_POV: idTitik + '-POV-' + String(ke).padStart(2, '0'),
        ID_TITIK: idTitik, UID: induk.props.UID, ID_WEBGIS: idTitik, POV_KE: ke,
        LON: e.geom[0], LAT: e.geom[1], STATUS_POV: 'baru',
        SURVEYOR: this.cfg.editor || '', WAKTU: new Date().toISOString(),
        CARA_COCOK: 'WebGIS', NAMA_JALAN: induk.props.NAMA_JALAN,
        KELURAHAN: induk.props.KELURAHAN, KECAMATAN: induk.props.KECAMATAN,
        JENIS: induk.props.JENIS, TIPE: induk.props.TIPE,
        JARAK_M: +jarakM(lon, lat, induk.geom[0], induk.geom[1]).toFixed(1),
      });
      e.by = this.cfg.editor || 'anonim';
      e.at = new Date().toISOString();
      this.pending.add('pov:' + key);
      if (!this.anak.has(keyInduk)) this.anak.set(keyInduk, []);
      this.anak.get(keyInduk).push(key);
      hasil = this._segar('pov', key);
      this._segarJmlPov(keyInduk);
    });
    return hasil;
  },

  /** Tandai nonaktif (bukan hapus permanen) — data tetap dapat dipulihkan. */
  hapus(ly, key) {
    const f = this.get(ly, key);
    if (!f || f.status === 'del') return;
    this.tx('Hapus titik', () => {
      this._catat(ly, key);
      const e = this._entri(ly, key);
      e.op = 'delete';
      this._segar(ly, key);
      if (ly === 'pov' && f.pkey) this._segarJmlPov(f.pkey);
      if (ly === 'reklame') for (const k of this.anakDari(key)) {
        this._catat('pov', k);
        this._entri('pov', k).op = 'delete';
        this._segar('pov', k);
      }
    });
  },

  pulihkan(ly, key) {
    const e = this.overlay[ly].get(key);
    if (!e || e.op !== 'delete') return;
    this.tx('Pulihkan titik', () => {
      this._catat(ly, key);
      e.op = this.base[ly].has(key) ? 'update' : 'create';
      this._bersihkan(ly, key, e);
      const f = this._segar(ly, key);
      if (ly === 'pov' && f?.pkey) this._segarJmlPov(f.pkey);
    });
  },

  _segarJmlPov(keyReklame) {
    const n = this.anakDari(keyReklame).length;
    const r = this.get('reklame', keyReklame);
    if (!r || r.props.JML_POV === n) return;
    this._catat('reklame', keyReklame);
    this._entri('reklame', keyReklame).props.JML_POV = n;
    this._segar('reklame', keyReklame);
  },

  /** Buang entri overlay yang sudah tidak berisi perubahan apa pun. */
  _bersihkan(ly, key, e) {
    if (e.op === 'update' && !e.geom && Object.keys(e.props || {}).length === 0) {
      this.overlay[ly].delete(key);
      this.pending.add(ly + ':' + key);   // hapus juga perlu dikirim
    }
  },

  _acak() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); },

  _idBaru(ly) {
    let n = 0;
    const pola = /^BARU-(\d+)$/;
    for (const f of this._cache[ly].values()) {
      const m = pola.exec(f?.props?.[KUNCI[ly]] || '');
      if (m) n = Math.max(n, +m[1]);
    }
    return 'BARU-' + String(n + 1).padStart(4, '0');
  },

  // -------------------------------------------------------------- undo/redo
  undo() { this._geser(this._undo, this._redo); },
  redo() { this._geser(this._redo, this._undo); },

  _geser(dari, ke) {
    const t = dari.pop();
    if (!t) return;
    const balik = { label: t.label, snap: new Map() };
    for (const [k, sebelum] of t.snap) {
      const [ly, key] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const kini = this.overlay[ly].get(key);
      balik.snap.set(k, kini ? JSON.parse(JSON.stringify(kini)) : null);
      if (sebelum) this.overlay[ly].set(key, sebelum);
      else this.overlay[ly].delete(key);
      this.pending.add(k);
      this._segar(ly, key);
    }
    ke.push(balik);
    this.terakhirUbah = [...t.snap.keys()];
    this._ulangIndeksBaru();
    this._simpanPending();
    this._pancar();
  },

  bisaUndo() { return this._undo.length > 0; },
  bisaRedo() { return this._redo.length > 0; },

  // -------------------------------------------------------------- penyimpanan
  /**
   * Jumlah titik yang benar-benar berbeda dari versi di GitHub. Entri yang
   * sudah diurungkan kembali ke keadaan semula dicoret dari antrean.
   */
  jmlBelumKirim() {
    let n = 0;
    for (const k of [...this.pending]) {
      const i = k.indexOf(':');
      const ly = k.slice(0, i), key = k.slice(i + 1);
      const kini = this.overlay[ly].get(key) ?? null;
      const jauh = this.remote[ly]?.[key] ?? null;
      if (JSON.stringify(kini) === JSON.stringify(jauh)) this.pending.delete(k);
      else n++;
    }
    return n;
  },

  /** Objek edits.json gabungan overlay saat ini. */
  berkasEdits() {
    const out = { v: 1, updated: new Date().toISOString(), reklame: {}, pov: {} };
    for (const ly of ['reklame', 'pov']) {
      for (const [key, e] of this.overlay[ly]) out[ly][key] = e;
    }
    return out;
  },

  /** Gabungkan overlay dari GitHub dengan perubahan lokal yang belum terkirim. */
  terapkanRemote(objek, { pertahankanLokal = true } = {}) {
    const lokal = {};
    if (pertahankanLokal) {
      for (const k of this.pending) {
        const [ly, key] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
        (lokal[ly] ||= {})[key] = this.overlay[ly].get(key) ?? null;
      }
    }
    for (const ly of ['reklame', 'pov']) {
      this.overlay[ly] = new Map(Object.entries(objek?.[ly] || {}));
      for (const [key, e] of Object.entries(lokal[ly] || {})) {
        if (e === null) this.overlay[ly].delete(key); else this.overlay[ly].set(key, e);
      }
    }
    this.remote = { reklame: objek?.reklame || {}, pov: objek?.pov || {} };
    this._bangunCache();
    this._pancar();
  },

  tandaiTerkirim() {
    this.remote = JSON.parse(JSON.stringify({
      reklame: Object.fromEntries(this.overlay.reklame),
      pov: Object.fromEntries(this.overlay.pov),
    }));
    this.pending.clear();
    this._simpanPending();
    this._pancar();
  },

  _simpanPending() {
    try {
      const data = { keys: [...this.pending], entri: {} };
      for (const k of this.pending) {
        const [ly, key] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
        (data.entri[ly] ||= {})[key] = this.overlay[ly].get(key) ?? null;
      }
      localStorage.setItem(LS_PENDING, JSON.stringify(data));
    } catch (err) { /* kuota penuh: abaikan, data tetap ada di memori */ }
  },

  _muatPending() {
    try {
      const raw = localStorage.getItem(LS_PENDING);
      if (!raw) return;
      const d = JSON.parse(raw);
      for (const ly of ['reklame', 'pov']) {
        for (const [key, e] of Object.entries(d.entri?.[ly] || {})) {
          if (e === null) this.overlay[ly].delete(key); else this.overlay[ly].set(key, e);
        }
      }
      for (const k of d.keys || []) this.pending.add(k);
    } catch (err) { /* berkas rusak: mulai bersih */ }
  },

  // -------------------------------------------------------------- konfigurasi
  _muatCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch (e) { c = {}; }
    // Tebak repositori dari alamat GitHub Pages: <owner>.github.io/<repo>/
    const h = location.hostname.match(/^([\w-]+)\.github\.io$/i);
    if (h && !c.owner) c.owner = h[1];
    const p = location.pathname.split('/').filter(Boolean);
    if (h && p.length && !c.repo) c.repo = p[0];
    c.branch ||= 'main';
    c.autosave = c.autosave !== false;
    return c;
  },

  simpanCfg(patch) {
    Object.assign(this.cfg, patch);
    const { ...simpan } = this.cfg;
    localStorage.setItem(LS_CFG, JSON.stringify(simpan));
  },

  // -------------------------------------------------------------- notifikasi
  onUbah(fn) { this._sub.add(fn); return () => this._sub.delete(fn); },
  _pancar() { for (const fn of this._sub) { try { fn(); } catch (e) { console.error(e); } } },
};
