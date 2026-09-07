// Tabel atribut: penggulungan virtual (hanya baris terlihat yang digambar),
// penyaringan, pengurutan, pemilihan kolom, dan penyuntingan langsung di sel.

import { Store, KUNCI } from './store.js';
import { Peta } from './map.js';
import { $, $$, esc, fmtAngka, toast, debounce } from './util.js';

const TINGGI = 27;
const LS_KOL = 'reklame3.kolom.v1';
const BAWAAN = {
  reklame: ['ID_TITIK', 'NAMA_JALAN', 'KELURAHAN', 'KECAMATAN', 'JENIS', 'TIPE',
            'TIPE_MEDIA', 'UKR_MEDIA', 'KEWENANGAN', 'STAT_TTK', 'JML_POV', 'LONG', 'LAT'],
  pov: ['ID_POV', 'ID_TITIK', 'POV_KE', 'JARAK_M', 'STATUS_POV', 'SURVEYOR',
        'NAMA_JALAN', 'KELURAHAN', 'LON', 'LAT'],
};

export const Tabel = {
  layer: 'reklame',
  kolom: { reklame: [...BAWAAN.reklame], pov: [...BAWAAN.pov] },
  urut: { f: null, naik: true },
  saring: '', hanyaTampak: false, hanyaBerubah: false,
  baris: [],           // key hasil saring + urut
  _sunting: null,

  init() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KOL) || 'null');
      if (s?.reklame?.length) this.kolom = s;
    } catch (e) { /* pakai bawaan */ }

    $('#table-toggle').addEventListener('click', () => this.buka());
    $$('.tabs .tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      this.layer = t.dataset.layer;
      this.urut = { f: null, naik: true };
      this.render();
    }));

    $('#table-filter').addEventListener('input', debounce((e) => {
      this.saring = e.target.value.trim().toLowerCase();
      this.render();
    }, 180));
    $('#only-view').addEventListener('change', (e) => {
      this.hanyaTampak = e.target.checked; this.render();
    });
    $('#only-changed').addEventListener('change', (e) => {
      this.hanyaBerubah = e.target.checked; this.render();
    });

    $('#table-scroll').addEventListener('scroll', () => this._gambarBaris());
    $('#thead-row').addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (!th || !th.dataset.f) return;
      if (this.urut.f === th.dataset.f) this.urut.naik = !this.urut.naik;
      else this.urut = { f: th.dataset.f, naik: true };
      this.render();
    });

    const tb = $('#tbody');
    tb.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      const tr = e.target.closest('tr');
      if (!tr || !tr.dataset.key) return;
      if (Peta.modeEdit && td?.dataset.f && !td.querySelector('input,select')) {
        this._buka(td, tr.dataset.key);
        return;
      }
      Peta.pilihTitik(this.layer, tr.dataset.key, { zoom: true });
    });

    Peta.map.on('moveend', debounce(() => { if (this.hanyaTampak) this.render(); }, 250));
    this.pasangModalKolom();
  },

  buka(paksa) {
    const p = $('#tablepane');
    const tutup = paksa === undefined ? !p.classList.contains('collapsed') : !paksa;
    p.classList.toggle('collapsed', tutup);
    if (!tutup) this.render();
  },

  render() {
    const skema = Store.schema[this.layer].fields;
    const def = new Map(skema.map((d) => [d.name, d]));
    this.def = def;

    // ---- kepala tabel
    $('#thead-row').innerHTML = this.kolom[this.layer].map((c) => {
      const d = def.get(c);
      const ar = this.urut.f === c ? `<span class="ar">${this.urut.naik ? '▲' : '▼'}</span>` : '';
      return `<th data-f="${esc(c)}" title="${esc(c)}">${esc(d?.label || c)}${ar}</th>`;
    }).join('');

    // ---- penyaringan
    const b = this.hanyaTampak ? Peta.map.getBounds() : null;
    const q = this.saring;
    const kunci = KUNCI[this.layer];
    const hasil = [];
    for (const [key, f] of Store.semua(this.layer)) {
      if (!f) continue;
      if (f.status === 'del' && !Peta.tampil.dihapus) continue;
      if (this.hanyaBerubah && f.status === 'base') continue;
      if (b && (!f.geom || !b.contains([f.geom[1], f.geom[0]]))) continue;
      if (q) {
        let cocok = false;
        for (const c of this.kolom[this.layer]) {
          const v = f.props[c];
          if (v != null && String(v).toLowerCase().includes(q)) { cocok = true; break; }
        }
        if (!cocok && !String(f.props[kunci] || '').toLowerCase().includes(q)) continue;
      }
      hasil.push(key);
    }

    // ---- pengurutan
    if (this.urut.f) {
      const c = this.urut.f, arah = this.urut.naik ? 1 : -1;
      const angka = ['number', 'integer'].includes(def.get(c)?.type);
      hasil.sort((x, y) => {
        const a = Store.get(this.layer, x).props[c];
        const z = Store.get(this.layer, y).props[c];
        if (a == null && z == null) return 0;
        if (a == null) return 1;
        if (z == null) return -1;
        return (angka ? a - z : String(a).localeCompare(String(z), 'id')) * arah;
      });
    }

    this.baris = hasil;
    $('#tcnt-reklame').textContent = Store.semua('reklame').size.toLocaleString('id-ID');
    $('#tcnt-pov').textContent = Store.semua('pov').size.toLocaleString('id-ID');
    const ubah = [...Store.semua(this.layer).values()].filter((f) => f && f.status !== 'base').length;
    $('#table-info').textContent =
      `${hasil.length.toLocaleString('id-ID')} baris ditampilkan · ` +
      `${ubah.toLocaleString('id-ID')} baris berubah · ${this.kolom[this.layer].length} kolom` +
      (Peta.modeEdit ? ' · klik sel untuk mengedit' : ' · aktifkan mode edit untuk mengubah nilai');

    $('#table-scroll').scrollTop = 0;
    this._gambarBaris();
  },

  _gambarBaris() {
    const sc = $('#table-scroll');
    const n = this.baris.length;
    const mulai = Math.max(0, Math.floor(sc.scrollTop / TINGGI) - 5);
    const muat = Math.ceil(sc.clientHeight / TINGGI) + 12;
    const akhir = Math.min(n, mulai + muat);
    const kols = this.kolom[this.layer];
    const pilih = Peta.pilih;

    let html = '';
    if (mulai > 0) html += `<tr class="spacer-row"><td colspan="${kols.length}" style="height:${mulai * TINGGI}px"></td></tr>`;
    for (let i = mulai; i < akhir; i++) {
      const key = this.baris[i];
      const f = Store.get(this.layer, key);
      if (!f) continue;
      const kls = [f.status === 'new' ? 'new' : f.status === 'mod' ? 'mod' : '',
                   f.status === 'del' ? 'del' : '',
                   pilih && pilih.ly === this.layer && pilih.key === key ? 'sel' : '']
                  .filter(Boolean).join(' ');
      html += `<tr data-key="${esc(key)}" class="${kls}">`;
      for (const c of kols) {
        const d = this.def.get(c);
        const angka = d && ['number', 'integer'].includes(d.type);
        const v = f.props[c];
        const cc = f.ubah.has(c) ? ' cell-changed' : '';
        html += `<td data-f="${esc(c)}" class="${angka ? 'num' : ''}${cc}">${esc(fmtAngka(v))}</td>`;
      }
      html += '</tr>';
    }
    if (akhir < n) html += `<tr class="spacer-row"><td colspan="${kols.length}" style="height:${(n - akhir) * TINGGI}px"></td></tr>`;
    $('#tbody').innerHTML = html;
  },

  /** Buka penyuntingan langsung pada satu sel. */
  _buka(td, key) {
    const nama = td.dataset.f;
    const d = this.def.get(nama);
    if (nama === KUNCI[this.layer] || nama === 'UID' || nama === 'ID_WEBGIS') {
      toast('Kolom identitas tidak dapat diubah.', 'warn'); return;
    }
    if (['LONG', 'LON', 'LAT'].includes(nama)) {
      toast('Koordinat diubah dengan menggeser titik di peta.', 'warn'); return;
    }
    const f = Store.get(this.layer, key);
    if (f.status === 'del') { toast('Titik ini berstatus dihapus. Pulihkan dulu.', 'warn'); return; }

    const nilai = f.props[nama] ?? '';
    const lebar = td.offsetWidth;
    let el;
    if (d?.options?.length) {
      const opsi = d.options.includes(String(nilai)) || nilai === ''
        ? d.options : [String(nilai), ...d.options];
      td.innerHTML = `<select>${['', ...opsi].map((o) =>
        `<option value="${esc(o)}"${String(nilai) === o ? ' selected' : ''}>${o === '' ? '— kosong —' : esc(o)}</option>`).join('')}</select>`;
      el = td.querySelector('select');
    } else {
      const tipe = d && ['number', 'integer'].includes(d.type) ? 'number' : 'text';
      td.innerHTML = `<input type="${tipe}" value="${esc(nilai)}">`;
      el = td.querySelector('input');
    }
    td.style.minWidth = lebar + 'px';
    el.focus();
    if (el.select) el.select();

    const simpan = () => {
      if (this._sunting !== el) return;
      this._sunting = null;
      Store.setNilai(this.layer, key, nama, el.value);
      this._gambarBaris();
    };
    this._sunting = el;
    el.addEventListener('blur', simpan);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { this._sunting = null; this._gambarBaris(); }
    });
    if (el.tagName === 'SELECT') el.addEventListener('change', () => el.blur());
  },

  // ------------------------------------------------------------ pilih kolom
  pasangModalKolom() {
    $('#btn-cols').addEventListener('click', () => {
      this._isiDaftarKolom();
      window.__modal('#modal-cols', true);
    });
    $('#col-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('#col-list label').forEach((l) => {
        l.style.display = l.dataset.cari.includes(q) ? '' : 'none';
      });
      $$('#col-list .cgrp').forEach((g) => { g.style.display = q ? 'none' : ''; });
    });
    $('#cols-default').addEventListener('click', () => {
      this.kolom[this.layer] = [...BAWAAN[this.layer]]; this._simpanKolom();
    });
    $('#cols-all').addEventListener('click', () => {
      this.kolom[this.layer] = Store.schema[this.layer].fields
        .map((d) => d.name).filter((n) => n !== 'fid');
      this._simpanKolom();
    });
    $('#cols-none').addEventListener('click', () => {
      this.kolom[this.layer] = [KUNCI[this.layer]]; this._simpanKolom();
    });
    $('#col-list').addEventListener('change', (e) => {
      const cb = e.target;
      if (!cb.dataset.c) return;
      const arr = this.kolom[this.layer];
      if (cb.checked) { if (!arr.includes(cb.dataset.c)) arr.push(cb.dataset.c); }
      else {
        const i = arr.indexOf(cb.dataset.c);
        if (i >= 0) arr.splice(i, 1);
      }
      this._simpanKolom(false);
    });
  },

  _simpanKolom(isiUlang = true) {
    localStorage.setItem(LS_KOL, JSON.stringify(this.kolom));
    if (isiUlang) this._isiDaftarKolom();
    this.render();
  },

  _isiDaftarKolom() {
    const dipakai = new Set(this.kolom[this.layer]);
    const grup = Store.schema.groups;
    const perGrup = new Map();
    for (const d of Store.schema[this.layer].fields) {
      if (d.name === 'fid') continue;
      if (!perGrup.has(d.group)) perGrup.set(d.group, []);
      perGrup.get(d.group).push(d);
    }
    let html = '';
    for (const [g, label] of Object.entries(grup)) {
      const arr = perGrup.get(g);
      if (!arr?.length) continue;
      html += `<div class="cgrp">${esc(label)}</div>`;
      for (const d of arr) {
        const isi = Math.round(100 * d.filled / Math.max(1, d.total));
        html += `<label data-cari="${esc((d.label + ' ' + d.name).toLowerCase())}">
          <input type="checkbox" data-c="${esc(d.name)}"${dipakai.has(d.name) ? ' checked' : ''}>
          <span>${esc(d.label)}</span>
          <span class="cn">${esc(d.name)} · ${isi}% terisi</span></label>`;
      }
    }
    $('#col-list').innerHTML = html;
  },
};
