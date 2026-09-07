// Peta Leaflet: peta dasar, penggambaran titik di kanvas, seleksi,
// dan penggeseran titik (drag) yang bekerja untuk tetikus maupun sentuh.

import { Store } from './store.js';
import { jarakM, fmtJarak, toast, $ } from './util.js';

const PALET = ['#4da3ff', '#ffd166', '#3fb950', '#f78166', '#bc8cff', '#56d4dd',
               '#ff7b3d', '#e3b341', '#7ee787', '#ff9bce', '#a5d6ff', '#d2a8ff'];
const WARNA_TETAP = {
  'Persimpangan': '#4da3ff', 'Koridor': '#3fb950', 'Pedestrian': '#bc8cff',
  'AKTIF': '#3fb950', 'TIDAK DITARIFKAN': '#8b9bb0',
};
const BATAM = [[0.95, 103.85], [1.25, 104.20]];

// Label jarak pada garis POV baru muncul saat peta cukup dekat, dan dibatasi
// jumlahnya, supaya tidak menutupi peta dan tetap ringan digambar.
const ZOOM_LABEL = 15;
const MAKS_LABEL = 250;
const MIN_PANJANG_PX = 30;   // garis lebih pendek dari ini tidak diberi label

export const Peta = {
  map: null, kanvas: null,
  lapisan: { reklame: new Map(), pov: new Map() },  // key -> L.CircleMarker
  grup: { reklame: null, pov: null, garis: null, labelJarak: null, sorot: null },
  pilih: null,                    // {ly, key}
  warnaOleh: 'JENIS',
  skalaWarna: new Map(),
  sembunyi: new Set(),            // nilai kategori yang dimatikan lewat legenda
  tampil: { reklame: true, pov: true, garis: true, labelJarak: true,
            dihapus: false, tanda: true },
  alat: null,                     // null | 'add-reklame' | 'add-pov' | 'measure'
  modeEdit: false,
  _drag: null, _tekanKlik: 0,
  _onPilih: null, _onKlikPeta: null,

  init() {
    this.map = L.map('map', {
      center: [1.09, 104.02], zoom: 12, zoomControl: true,
      preferCanvas: true, maxZoom: 22, zoomSnap: 0.5, worldCopyJump: false,
    });
    this.map.zoomControl.setPosition('bottomright');
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 160 }).addTo(this.map);

    this.dasar = {
      'sat': L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 22, maxNativeZoom: 19,
          attribution: 'Citra: Esri, Maxar, Earthstar Geographics' }),
      'osm': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 22, maxNativeZoom: 19, attribution: '&copy; Kontributor OpenStreetMap' }),
    };
    this.label = L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 22, maxNativeZoom: 19, pane: 'shadowPane' }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 22, maxNativeZoom: 19, pane: 'shadowPane' }),
    ]);

    this.kanvas = L.canvas({ padding: 0.35 });
    this.grup.garis = L.layerGroup().addTo(this.map);
    this.grup.labelJarak = L.layerGroup().addTo(this.map);
    this.grup.reklame = L.layerGroup().addTo(this.map);
    this.grup.pov = L.layerGroup().addTo(this.map);
    this.grup.sorot = L.layerGroup().addTo(this.map);

    this.gantiDasar('sat-label');
    this._pasangInteraksi();
    this.map.on('zoomend', () => this._perbaruiRadius());
    // Label hanya digambar untuk garis yang sedang terlihat, jadi ikut
    // disegarkan setiap kali peta digeser atau diperbesar.
    this.map.on('moveend', () => this.gambarLabelJarak());

    // Lebar peta berubah saat panel samping atau tabel dibuka/ditutup, dan
    // ukuran awal bisa terbaca nol bila tata letak belum selesai dihitung.
    this.map.invalidateSize({ animate: false });
    this._ro = new ResizeObserver(() => this.map.invalidateSize({ animate: false }));
    this._ro.observe(document.getElementById('map-wrap'));
    window.addEventListener('load', () => this.map.invalidateSize({ animate: false }));
    return this.map;
  },

  gantiDasar(kunci) {
    for (const l of Object.values(this.dasar)) this.map.removeLayer(l);
    this.map.removeLayer(this.label);
    if (kunci === 'osm') this.dasar.osm.addTo(this.map);
    else {
      this.dasar.sat.addTo(this.map);
      if (kunci === 'sat-label') this.label.addTo(this.map);
    }
  },

  // ------------------------------------------------------------ penggambaran
  gambarUlang() {
    this._hitungSkalaWarna();
    for (const ly of ['reklame', 'pov']) {
      this.grup[ly].clearLayers();
      this.lapisan[ly].clear();
      if (!this.tampil[ly]) continue;
      for (const [key, f] of Store.semua(ly)) {
        const m = this._buat(ly, key, f);
        if (m) { this.lapisan[ly].set(key, m); m.addTo(this.grup[ly]); }
      }
    }
    this.gambarGaris();
    this.sorotPilihan();
    this._hitungan();
  },

  _buat(ly, key, f) {
    if (!f || !f.geom) return null;
    if (f.status === 'del' && !this.tampil.dihapus) return null;
    if (ly === 'reklame' && this.sembunyi.size && this.warnaOleh !== '_none') {
      if (this.sembunyi.has(this._kunciWarna(f))) return null;
    }
    const m = L.circleMarker([f.geom[1], f.geom[0]], {
      renderer: this.kanvas, ...this._gaya(ly, f), interactive: false,
    });
    m._ly = ly; m._key = key;
    return m;
  },

  _gaya(ly, f) {
    const r = this._radius(ly);
    if (f.status === 'del') {
      return { radius: r * 0.8, color: '#4b5563', weight: 1, fillColor: '#6b7280',
               fillOpacity: 0.35, opacity: 0.6 };
    }
    let isi = ly === 'pov' ? '#ffd166' : this._warna(f);
    let garis = '#0b0f14', tebal = 1.2;
    if (f.status === 'new') { garis = '#3fb950'; tebal = 2.2; }
    else if (f.status === 'mod') { garis = '#ff7b3d'; tebal = 2.2; }
    else if (this.tampil.tanda && ly === 'reklame' && this.koordinatJanggal(f)) {
      garis = '#f85149'; tebal = 2.2;
    }
    return { radius: ly === 'pov' ? r * 0.68 : r, color: garis, weight: tebal,
             fillColor: isi, fillOpacity: 0.92, opacity: 1 };
  },

  _radius() {
    const z = this.map.getZoom();
    return z >= 18 ? 8 : z >= 16 ? 6.5 : z >= 14 ? 5 : z >= 12 ? 4 : 3;
  },

  _perbaruiRadius() {
    for (const ly of ['reklame', 'pov']) {
      for (const [key, m] of this.lapisan[ly]) {
        const f = Store.get(ly, key);
        if (f) m.setStyle(this._gaya(ly, f));
      }
    }
    this.sorotPilihan();
  },

  /** Titik dengan geometri yang tidak cocok dengan kolom LONG/LAT-nya. */
  koordinatJanggal(f) {
    const lo = f.props.LONG ?? f.props.LON, la = f.props.LAT;
    if (lo == null || la == null || !f.geom) return 0;
    const d = jarakM(f.geom[0], f.geom[1], lo, la);
    return d > 1 ? d : 0;
  },

  perbarui(ly, key) {
    const f = Store.get(ly, key);
    const lama = this.lapisan[ly].get(key);
    if (lama) { this.grup[ly].removeLayer(lama); this.lapisan[ly].delete(key); }
    const baru = this._buat(ly, key, f);
    if (baru) { this.lapisan[ly].set(key, baru); baru.addTo(this.grup[ly]); }
    this.gambarGaris();
    this.sorotPilihan();
    this._hitungan();
  },

  gambarGaris() {
    this.grup.garis.clearLayers();
    if (this.tampil.garis && this.tampil.pov) {
      const seg = [];
      for (const [key, p] of Store.semua('pov')) {
        if (!p || !p.geom || !p.pkey) continue;
        if (p.status === 'del' && !this.tampil.dihapus) continue;
        const r = Store.get('reklame', p.pkey);
        if (!r || !r.geom) continue;
        if (r.status === 'del' && !this.tampil.dihapus) continue;
        seg.push([[p.geom[1], p.geom[0]], [r.geom[1], r.geom[0]]]);
      }
      if (seg.length) {
        L.polyline(seg, { renderer: this.kanvas, color: '#ffd166', weight: 1,
                          opacity: 0.4, dashArray: '3,4', interactive: false })
          .addTo(this.grup.garis);
      }
    }
    // Selalu dipanggil, termasuk saat garis dimatikan, agar label lama ikut hilang.
    this.gambarLabelJarak();
  },

  /**
   * Tempelkan jarak dalam meter di tengah setiap garis POV -> reklame.
   * Yang digambar hanya garis yang tengahnya sedang terlihat di layar, dan
   * hanya pada perbesaran tertentu ke atas, agar peta tidak penuh tulisan.
   */
  gambarLabelJarak() {
    this.grup.labelJarak.clearLayers();
    let n = 0, terpotong = false;
    const bolehGambar = this.tampil.labelJarak && this.tampil.garis && this.tampil.pov;

    if (bolehGambar && this.map.getZoom() >= ZOOM_LABEL) {
      const b = this.map.getBounds().pad(0.1);
      const terisi = [];                        // kotak layar yang sudah dipakai label
      for (const [key, p] of Store.semua('pov')) {
        if (!p || !p.geom || !p.pkey) continue;
        if (p.status === 'del' && !this.tampil.dihapus) continue;
        const r = Store.get('reklame', p.pkey);
        if (!r || !r.geom) continue;
        if (r.status === 'del' && !this.tampil.dihapus) continue;

        const tengah = [(p.geom[1] + r.geom[1]) / 2, (p.geom[0] + r.geom[0]) / 2];
        if (!b.contains(tengah)) continue;

        // Garis yang terlalu pendek di layar tidak muat diberi label.
        const a1 = this.map.latLngToContainerPoint([p.geom[1], p.geom[0]]);
        const a2 = this.map.latLngToContainerPoint([r.geom[1], r.geom[0]]);
        if (Math.hypot(a2.x - a1.x, a2.y - a1.y) < MIN_PANJANG_PX) continue;

        const info = this._ukurGaris(p, r);
        const q = this.map.latLngToContainerPoint(tengah);
        const w = info.teks.length * 6 + (info.beda ? 20 : 10), h = 15;
        const kotak = [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2];
        // Lewati label yang akan menimpa label lain agar peta tetap terbaca.
        if (terisi.some((k) => k[0] < kotak[2] && k[2] > kotak[0] &&
                               k[1] < kotak[3] && k[3] > kotak[1])) continue;

        if (n >= MAKS_LABEL) { terpotong = true; break; }
        terisi.push(kotak);
        this._labelJarak(tengah, info, this.grup.labelJarak);
        n++;
      }
    }

    const nota = $('#lbl-note');
    if (nota) {
      nota.textContent = !bolehGambar ? ''
        : terpotong ? MAKS_LABEL + '+'
        : n === 0 ? 'perbesar'
        : String(n);
    }
  },

  /**
   * Jarak sebuah garis POV -> reklame. Dihitung dari geometri yang benar-benar
   * digambar, bukan dari kolom JARAK_M, supaya label selalu sesuai dengan garis
   * yang terlihat. Selisih besar terhadap kolomnya ditandai agar ketahuan.
   */
  _ukurGaris(p, r) {
    const d = jarakM(p.geom[0], p.geom[1], r.geom[0], r.geom[1]);
    const kolom = p.props.JARAK_M;
    return { d, teks: fmtJarak(d), beda: kolom != null && Math.abs(kolom - d) > 1 };
  },

  _labelJarak(pos, info, grup, kelas = '') {
    L.tooltip({
      permanent: true, direction: 'center', interactive: false,
      className: 'jarak' + (kelas ? ' ' + kelas : '') + (info.beda ? ' beda' : ''),
    }).setLatLng(pos).setContent(info.teks).addTo(grup);
  },

  // ------------------------------------------------------------ warna
  _kunciWarna(f) { return String(f.props[this.warnaOleh] ?? '(kosong)'); },

  _warna(f) {
    if (this.warnaOleh === '_none') return '#4da3ff';
    return this.skalaWarna.get(this._kunciWarna(f)) || '#8b9bb0';
  },

  _hitungSkalaWarna() {
    this.skalaWarna.clear();
    this.hitungKategori = new Map();
    if (this.warnaOleh === '_none') return;
    for (const f of Store.semua('reklame').values()) {
      if (!f || (f.status === 'del' && !this.tampil.dihapus)) continue;
      const k = this._kunciWarna(f);
      this.hitungKategori.set(k, (this.hitungKategori.get(k) || 0) + 1);
    }
    const urut = [...this.hitungKategori.entries()].sort((a, b) => b[1] - a[1]);
    urut.forEach(([k], i) => {
      this.skalaWarna.set(k, WARNA_TETAP[k] || PALET[i % PALET.length]);
    });
  },

  // ------------------------------------------------------------ seleksi
  pilihTitik(ly, key, { zoom = false } = {}) {
    this.pilih = ly && key ? { ly, key } : null;
    this.sorotPilihan();
    if (zoom && this.pilih) {
      const f = Store.get(ly, key);
      if (f?.geom) this.map.setView([f.geom[1], f.geom[0]], Math.max(this.map.getZoom(), 18));
    }
    this._onPilih?.(this.pilih);
  },

  sorotPilihan() {
    this.grup.sorot.clearLayers();
    if (!this.pilih) return;
    const { ly, key } = this.pilih;
    const f = Store.get(ly, key);
    if (!f || !f.geom) return;
    const r = this._radius() + 6;
    L.circleMarker([f.geom[1], f.geom[0]], {
      renderer: this.kanvas, radius: r, color: '#fff', weight: 2.5,
      fillOpacity: 0, opacity: 1, interactive: false,
    }).addTo(this.grup.sorot);
    L.circleMarker([f.geom[1], f.geom[0]], {
      renderer: this.kanvas, radius: r + 4, color: '#4da3ff', weight: 1.5,
      fillOpacity: 0, opacity: 0.8, interactive: false,
    }).addTo(this.grup.sorot);

    // tegaskan relasi induk-anak dari titik terpilih
    const pasangan = ly === 'reklame'
      ? Store.anakDari(key).map((k) => Store.get('pov', k))
      : (f.pkey ? [Store.get('reklame', f.pkey)] : []);
    const seg = [];
    for (const o of pasangan) {
      if (!o?.geom) continue;
      seg.push([[f.geom[1], f.geom[0]], [o.geom[1], o.geom[0]]]);
      // Jarak titik terpilih selalu diberi label, berapa pun perbesarannya.
      const tengah = [(f.geom[1] + o.geom[1]) / 2, (f.geom[0] + o.geom[0]) / 2];
      const [pov, rek] = ly === 'reklame' ? [o, f] : [f, o];
      this._labelJarak(tengah, this._ukurGaris(pov, rek), this.grup.sorot, 'pilih');
    }
    if (seg.length) {
      L.polyline(seg, { renderer: this.kanvas, color: '#fff', weight: 1.8,
                        opacity: 0.85, interactive: false }).addTo(this.grup.sorot);
    }
  },

  // ------------------------------------------------------------ interaksi
  _pasangInteraksi() {
    const el = this.map.getContainer();

    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      if (this.alat === 'measure') return;              // penggaris punya alur sendiri
      const kena = this._cariTitik(ev);
      if (!kena) return;

      if (!this.modeEdit || this.alat) {                // hanya pilih, jangan geser
        this._drag = { ...kena, geser: false, kunci: false, ev };
        return;
      }
      this._drag = {
        ...kena, geser: false, kunci: true, ev,
        x0: ev.clientX, y0: ev.clientY,
      };
      this.map.dragging.disable();
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* diabaikan */ }
    });

    el.addEventListener('pointermove', (ev) => {
      const d = this._drag;
      if (!d || !d.kunci) return;
      if (!d.geser) {
        if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 4) return;
        d.geser = true;
        document.body.classList.add('dragging-pt');
        this.pilihTitik(d.ly, d.key);
      }
      const ll = this.map.mouseEventToLatLng(ev);
      const m = this.lapisan[d.ly].get(d.key);
      if (m) m.setLatLng(ll);
      d.ll = ll;
      this._pratinjauGeser(d, ll);
      ev.preventDefault();
    });

    const selesai = (ev) => {
      const d = this._drag;
      if (!d) return;
      this._drag = null;
      document.body.classList.remove('dragging-pt');
      if (d.kunci) {
        this.map.dragging.enable();
        try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* diabaikan */ }
      }
      if (d.geser && d.ll) {
        this._tekanKlik = Date.now();
        Store.pindah(d.ly, d.key, d.ll.lng, d.ll.lat);
        this.grup.sorot.clearLayers();
        this.sorotPilihan();
      } else {
        this._tekanKlik = Date.now();
        this.pilihTitik(d.ly, d.key);
      }
    };
    el.addEventListener('pointerup', selesai);
    el.addEventListener('pointercancel', () => {
      if (this._drag?.kunci) this.map.dragging.enable();
      document.body.classList.remove('dragging-pt');
      this._drag = null;
      this.gambarUlang();
    });

    this.map.on('click', (e) => {
      if (Date.now() - this._tekanKlik < 350) return;   // sisa dari geser/pilih
      if (this.alat === 'add-reklame' || this.alat === 'add-pov') {
        this._onKlikPeta?.(e.latlng);
        return;
      }
      if (this.alat === 'measure') return;
      this.pilihTitik(null, null);
    });
  },

  /** Selama menggeser, garis relasi ikut bergerak agar terlihat langsung. */
  _pratinjauGeser(d, ll) {
    this.grup.sorot.clearLayers();
    const f = Store.get(d.ly, d.key);
    const pasangan = d.ly === 'reklame'
      ? Store.anakDari(d.key).map((k) => Store.get('pov', k))
      : (f?.pkey ? [Store.get('reklame', f.pkey)] : []);
    const seg = [];
    for (const o of pasangan) {
      if (!o?.geom) continue;
      seg.push([[ll.lat, ll.lng], [o.geom[1], o.geom[0]]]);
      // Jarak dihitung dari posisi kursor supaya angkanya berubah saat digeser.
      L.tooltip({ permanent: true, direction: 'center', interactive: false,
                  className: 'jarak pilih' })
        .setLatLng([(ll.lat + o.geom[1]) / 2, (ll.lng + o.geom[0]) / 2])
        .setContent(fmtJarak(jarakM(ll.lng, ll.lat, o.geom[0], o.geom[1])))
        .addTo(this.grup.sorot);
    }
    if (seg.length) {
      L.polyline(seg, { renderer: this.kanvas, color: '#fff', weight: 1.8,
                        opacity: 0.85, interactive: false }).addTo(this.grup.sorot);
    }
    L.circleMarker(ll, { renderer: this.kanvas, radius: this._radius() + 6,
      color: '#ff7b3d', weight: 2.5, fillOpacity: 0, interactive: false })
      .addTo(this.grup.sorot);
  },

  /** Cari titik terdekat dari posisi kursor dalam radius toleransi layar. */
  _cariTitik(ev) {
    const p = this.map.mouseEventToContainerPoint(ev);
    const tol = ev.pointerType === 'touch' ? 22 : 12;
    const b = this.map.getBounds().pad(0.02);
    let terbaik = null, jarakTerbaik = tol * tol;
    for (const ly of ['pov', 'reklame']) {          // POV lebih kecil: prioritaskan
      if (!this.tampil[ly]) continue;
      for (const [key, m] of this.lapisan[ly]) {
        const ll = m.getLatLng();
        if (!b.contains(ll)) continue;
        const q = this.map.latLngToContainerPoint(ll);
        const d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d2 < jarakTerbaik) { jarakTerbaik = d2; terbaik = { ly, key }; }
      }
      if (terbaik) break;
    }
    return terbaik;
  },

  _hitungan() {
    const hidup = (ly) => [...Store.semua(ly).values()]
      .filter((f) => f && (f.status !== 'del' || this.tampil.dihapus)).length;
    const a = $('#cnt-reklame'), b = $('#cnt-pov');
    if (a) a.textContent = hidup('reklame').toLocaleString('id-ID');
    if (b) b.textContent = hidup('pov').toLocaleString('id-ID');
  },

  /**
   * Pas-kan tampilan ke Kota Batam. Saat halaman baru dimuat, ukuran wadah
   * peta kadang masih nol; ulangi sampai tata letak selesai agar tingkat
   * perbesarannya tidak salah hitung.
   */
  keBatam(sisaCoba = 40) {
    this.map.invalidateSize({ animate: false });
    if (this.map.getSize().x < 50 && sisaCoba > 0) {
      requestAnimationFrame(() => this.keBatam(sisaCoba - 1));
      return;
    }
    this.map.fitBounds(BATAM, { padding: [20, 20] });
  },
};
