// Penggaris: ukur jarak beruntun dan luas area di peta.
// Klik untuk menambah titik, klik dua kali atau Esc untuk mengakhiri.

import { jarakM, luasM2, fmtJarak, fmtLuas, $ } from './util.js';

export const Penggaris = {
  map: null, aktif: false, titik: [], selesai: false,
  garis: null, karet: null, simpul: [], label: [],

  init(map) {
    this.map = map;
    this.lapis = L.layerGroup().addTo(map);
    map.on('click', (e) => { if (this.aktif) this._tambah(e.latlng); });
    map.on('mousemove', (e) => { if (this.aktif && !this.selesai) this._karet(e.latlng); });
    map.on('dblclick', (e) => {
      if (!this.aktif) return;
      L.DomEvent.stop(e);
      this._akhiri();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.aktif) {
        if (this.selesai || !this.titik.length) this.matikan(); else this._akhiri();
      }
    });
    $('#measure-clear')?.addEventListener('click', () => this.bersihkan());
    $('#measure-close')?.addEventListener('click', () => this.matikan());
  },

  nyalakan() {
    this.aktif = true;
    this.map.doubleClickZoom.disable();
    $('#measure-box').hidden = false;
    this.bersihkan();
  },

  matikan() {
    this.aktif = false;
    this.map.doubleClickZoom.enable();
    $('#measure-box').hidden = true;
    this.bersihkan();
    this.onMati?.();
  },

  bersihkan() {
    this.titik = []; this.selesai = false;
    this.lapis.clearLayers();
    this.garis = this.karet = null;
    this._tulis();
  },

  _tambah(ll) {
    if (this.selesai) this.bersihkan();
    this.titik.push([ll.lng, ll.lat]);
    L.circleMarker(ll, { radius: 4, color: '#4da3ff', weight: 2,
      fillColor: '#0b0f14', fillOpacity: 1 }).addTo(this.lapis);
    this._gambar();
  },

  _karet(ll) {
    if (!this.titik.length) return;
    const a = this.titik[this.titik.length - 1];
    if (this.karet) this.map.removeLayer(this.karet);
    this.karet = L.polyline([[a[1], a[0]], [ll.lat, ll.lng]],
      { color: '#4da3ff', weight: 1.5, dashArray: '4,5', opacity: 0.8 }).addTo(this.map);
    this._tulis(jarakM(a[0], a[1], ll.lng, ll.lat));
  },

  _akhiri() {
    if (this.karet) { this.map.removeLayer(this.karet); this.karet = null; }
    this.selesai = true;
    this._gambar();
    this._tulis();
  },

  _gambar() {
    if (this.garis) this.lapis.removeLayer(this.garis);
    for (const l of this.label) this.lapis.removeLayer(l);
    this.label = [];
    if (this.titik.length < 2) { this._tulis(); return; }

    const ll = this.titik.map(([x, y]) => [y, x]);
    this.garis = L.polyline(ll, { color: '#4da3ff', weight: 3, opacity: 0.9 }).addTo(this.lapis);

    for (let i = 1; i < this.titik.length; i++) {
      const a = this.titik[i - 1], b = this.titik[i];
      const d = jarakM(a[0], a[1], b[0], b[1]);
      const t = L.tooltip({ permanent: true, direction: 'center', className: 'mt' })
        .setLatLng([(a[1] + b[1]) / 2, (a[0] + b[0]) / 2])
        .setContent(fmtJarak(d));
      this.lapis.addLayer(t);
      this.label.push(t);
    }
    if (this.selesai && this.titik.length >= 3) {
      L.polygon(ll, { color: '#4da3ff', weight: 0, fillColor: '#4da3ff',
        fillOpacity: 0.14, interactive: false }).addTo(this.lapis);
    }
    this._tulis();
  },

  _tulis(sementara) {
    const box = $('#measure-readout');
    if (!box) return;
    if (!this.titik.length) {
      box.innerHTML = 'Klik di peta untuk mulai mengukur.<br>' +
                      '<small>Klik dua kali atau Esc untuk selesai.</small>';
      return;
    }
    let total = 0;
    const baris = [];
    for (let i = 1; i < this.titik.length; i++) {
      const a = this.titik[i - 1], b = this.titik[i];
      const d = jarakM(a[0], a[1], b[0], b[1]);
      total += d;
      baris.push(`<div class="seg">Segmen ${i}: ${fmtJarak(d)}</div>`);
    }
    if (sementara !== undefined) {
      baris.push(`<div class="seg">Segmen ${this.titik.length}: ${fmtJarak(sementara)} …</div>`);
      total += sementara;
    }
    let html = baris.join('');
    html += `<div class="tot">Total ${fmtJarak(total)}</div>`;
    if (this.titik.length >= 3) {
      html += `<div class="seg">Luas area: ${fmtLuas(luasM2(this.titik))}</div>`;
    }
    if (!this.selesai) html += '<div class="seg" style="margin-top:5px">Klik dua kali untuk mengakhiri.</div>';
    box.innerHTML = html;
  },
};
