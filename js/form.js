// Panel samping: formulir atribut titik terpilih, dikelompokkan menurut
// schema.json, plus daftar POV milik reklame yang sedang dipilih.

import { Store, KUNCI } from './store.js';
import { Peta } from './map.js';
import { $, esc, fmtWaktu, fmtJarak, toast } from './util.js';

const TERBUKA = new Set(['identitas', 'lokasi', 'media']);   // grup yang mekar

export const Form = {
  target: null,

  init() {
    $('#side-close').addEventListener('click', () => this.tutup());
    $('#side-body').addEventListener('change', (e) => this._simpanKolom(e));
    $('#side-body').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
    });
    $('#side-body').addEventListener('click', (e) => {
      const it = e.target.closest('.pov-item');
      if (it) Peta.pilihTitik('pov', it.dataset.key, { zoom: true });
      const grp = e.target.closest('summary');
      if (grp) {
        const d = grp.parentElement;
        setTimeout(() => (d.open ? TERBUKA.add(d.dataset.g) : TERBUKA.delete(d.dataset.g)));
      }
    });
  },

  tutup() {
    $('#side').classList.add('collapsed');
    Peta.pilihTitik(null, null);
  },

  tampilkan(sel) {
    this.target = sel;
    const sisi = $('#side');
    if (!sel) {
      sisi.classList.add('collapsed');
      return;
    }
    const f = Store.get(sel.ly, sel.key);
    if (!f) { sisi.classList.add('collapsed'); return; }
    sisi.classList.remove('collapsed');
    this.render();
  },

  /** Gambar ulang panel tanpa mengubah titik yang sedang dipilih. */
  render() {
    if (!this.target) return;
    const { ly, key } = this.target;
    const f = Store.get(ly, key);
    if (!f) { $('#side').classList.add('collapsed'); return; }

    $('#side-title').textContent = f.props[KUNCI[ly]] || key;
    $('#side-sub').innerHTML = this._lencana(ly, f);

    const skema = Store.schema[ly].fields;
    const grup = Store.schema.groups;
    const perGrup = new Map();
    for (const d of skema) {
      if (d.name === 'fid' || d.name === 'FID_ASLI') continue;
      if (!perGrup.has(d.group)) perGrup.set(d.group, []);
      perGrup.get(d.group).push(d);
    }

    let html = '';
    if (ly === 'reklame') html += this._blokPov(key);
    for (const [g, label] of Object.entries(grup)) {
      const daftar = perGrup.get(g);
      if (!daftar || !daftar.length) continue;
      const nUbah = daftar.filter((d) => f.ubah.has(d.name)).length;
      html += `<details class="grp" data-g="${g}"${TERBUKA.has(g) ? ' open' : ''}>
        <summary>${esc(label)}<em>${nUbah ? nUbah + ' diubah' : daftar.length}</em></summary>
        <div class="grp-body">${daftar.map((d) => this._kolom(ly, f, d)).join('')}</div>
      </details>`;
    }
    $('#side-body').innerHTML = html;
  },

  _lencana(ly, f) {
    const b = [];
    b.push(`<span class="badge">${ly === 'pov' ? 'Titik POV' : 'Reklame'}</span>`);
    if (f.status === 'new') b.push('<span class="badge new">baru</span>');
    if (f.status === 'mod') b.push(`<span class="badge mod">${f.ubah.size} kolom diubah</span>`);
    if (f.status === 'del') {
      b.push('<span class="badge del">dihapus</span>' +
             ' <button class="btn small" onclick="window.__pulihkan()">Pulihkan</button>');
    }
    const janggal = ly === 'reklame' ? Peta.koordinatJanggal(f) : 0;
    if (janggal) {
      b.push(`<span class="badge flag" title="Geometri di peta berbeda ${fmtJarak(janggal)} dari nilai kolom LONG/LAT. Geser titik ini untuk menyelaraskan keduanya.">koordinat janggal ${fmtJarak(janggal)}</span>`);
    }
    if (f.by) b.push(`<span class="badge">${esc(f.by)} · ${fmtWaktu(f.at)}</span>`);
    if (ly === 'pov' && f.props.JARAK_M != null) {
      b.push(`<span class="badge">${fmtJarak(f.props.JARAK_M)} dari reklame</span>`);
    }
    return b.join(' ');
  },

  _blokPov(key) {
    const anak = Store.anakDari(key);
    const kepala = `<details class="grp" data-g="_pov"${TERBUKA.has('_pov') ? ' open' : ''}>
      <summary>Titik POV terkait<em>${anak.length}</em></summary><div class="pov-list">`;
    if (!anak.length) {
      return kepala + '<div class="empty" style="padding:10px">Belum ada titik POV. ' +
        'Aktifkan mode edit lalu tekan “＋ POV”.</div></div></details>';
    }
    const baris = anak.map((k) => {
      const p = Store.get('pov', k);
      const tanda = p.status === 'new' ? '<span class="badge new">baru</span>'
                  : p.status === 'mod' ? '<span class="badge mod">diubah</span>' : '';
      return `<div class="pov-item" data-key="${esc(k)}">
        <span class="sw sw-pov"></span>
        <span>POV ${p.props.POV_KE ?? '?'}</span> ${tanda}
        <span class="k">${p.props.JARAK_M != null ? fmtJarak(p.props.JARAK_M) : '—'}</span>
      </div>`;
    }).join('');
    return kepala + baris + '</div></details>';
  },

  _kolom(ly, f, d) {
    const nilai = f.props[d.name];
    const berubah = f.ubah.has(d.name);
    const kunci = d.name === KUNCI[ly] || d.name === 'UID' || d.name === 'ID_WEBGIS';
    const mati = !Peta.modeEdit || f.status === 'del' || kunci;
    const koord = ['LONG', 'LON', 'LAT'].includes(d.name);
    const id = `f_${ly}_${d.name}`;
    const catatan = kunci ? ' title="Kolom identitas — tidak dapat diubah agar relasi antar-tabel tetap utuh."'
                  : koord ? ' title="Terisi otomatis saat titik digeser di peta."' : '';

    let kendali;
    if (d.options && d.options.length) {
      const opsi = d.options.slice();
      if (nilai != null && !opsi.includes(String(nilai))) opsi.unshift(String(nilai));
      kendali = `<select id="${id}" data-f="${esc(d.name)}"${mati ? ' disabled' : ''}${catatan}>
        <option value=""${nilai == null ? ' selected' : ''}>— kosong —</option>
        ${opsi.map((o) => `<option${String(nilai) === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
    } else {
      const tipe = d.type === 'number' || d.type === 'integer' ? 'number' : 'text';
      const langkah = d.type === 'integer' ? '1' : 'any';
      kendali = `<input id="${id}" data-f="${esc(d.name)}" type="${tipe}"
        ${tipe === 'number' ? `step="${langkah}"` : ''}
        value="${esc(nilai ?? '')}"${mati || koord ? ' disabled' : ''}${catatan}>`;
    }
    return `<label class="fld${berubah ? ' changed' : ''}">
      <span>${esc(d.label)}<i class="fld-code">${esc(d.name)}</i></span>${kendali}</label>`;
  },

  _simpanKolom(e) {
    const el = e.target.closest('[data-f]');
    if (!el || !this.target) return;
    Store.setNilai(this.target.ly, this.target.key, el.dataset.f, el.value);
  },
};

window.__pulihkan = () => {
  const t = Form.target;
  if (!t) return;
  Store.pulihkan(t.ly, t.key);
  toast('Titik dipulihkan.', 'ok');
};
