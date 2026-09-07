// Perangkai utama: pemuatan awal, bilah alat, mode edit, pencarian,
// penyimpanan ke GitHub, ekspor, dan pintasan papan ketik.

import { Store, KUNCI } from './store.js';
import { GH } from './github.js';
import { Peta } from './map.js';
import { Form } from './form.js';
import { Tabel } from './table.js';
import { Penggaris } from './measure.js';
import { $, $$, esc, toast, unduh, csv, fmtWaktu, fmtJarak, debounce } from './util.js';

const App = {
  simpanOtomatis: null,
  jedaPoll: null,

  async mulai() {
    const isi = $('#boot-fill'), pesan = $('#boot-msg');
    const maju = (p, m) => { isi.style.width = p + '%'; if (m) pesan.textContent = m; };

    try {
      await Store.muat(maju);
    } catch (e) {
      pesan.innerHTML = '<span style="color:#f85149">Gagal memuat data.</span><br>' +
        '<small>' + esc(e.message) + '</small><br><br>' +
        '<small>Halaman ini perlu dijalankan lewat server web, bukan dibuka langsung ' +
        'sebagai berkas. Di komputer: <code>python -m http.server 8000</code> lalu buka ' +
        '<code>http://localhost:8000</code>.</small>';
      return;
    }

    maju(88, 'Menyiapkan peta…');
    Peta.init();
    Penggaris.init(Peta.map);
    Form.init();

    Peta._onPilih = (sel) => { Form.tampilkan(sel); Tabel._gambarBaris(); };
    Peta._onKlikPeta = (ll) => this.klikTambah(ll);
    Penggaris.onMati = () => this.pilihAlat(null);

    Peta.gambarUlang();
    Peta.keBatam();
    Tabel.init();
    Tabel.render();

    this.pasangBilahAlat();
    this.pasangLegenda();
    this.pasangPencarian();
    this.pasangPengaturan();
    this.pasangEkspor();
    this.pasangPintasan();

    Store.onUbah(() => this.setelahUbah());
    this.perbaruiStatus();

    maju(96, 'Mengambil perubahan terbaru…');
    await this.muatEdits();
    maju(100, 'Siap.');

    setTimeout(() => $('#boot').classList.add('done'), 250);
    setTimeout(() => $('#boot').remove(), 900);

    if (Store.jmlBelumKirim()) {
      toast(`Ada <b>${Store.jmlBelumKirim()}</b> perubahan dari sesi sebelumnya yang belum terkirim.`, 'warn', 7000);
    }
    if (!Store.cfg.editor) {
      setTimeout(() => {
        toast('Isi nama Anda di Pengaturan (⚙) agar perubahan tercatat atas nama siapa.', '', 8000);
      }, 1200);
    }
    if (Store.yatim?.length) {
      console.warn('POV tanpa reklame induk:', Store.yatim.length);
    }
    this.mulaiPoll();
  },

  // ------------------------------------------------------------ data jarak jauh
  async muatEdits() {
    try {
      if (Store.cfg.owner && Store.cfg.repo) {
        const r = await GH.ambilEdits();
        Store.sha = r.sha;
        Store.terapkanRemote(r.isi, { pertahankanLokal: true });
      } else {
        const res = await fetch('data/edits.json?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) Store.terapkanRemote(await res.json(), { pertahankanLokal: true });
      }
      Peta.gambarUlang();
      Tabel.render();
      Form.render();
    } catch (e) {
      console.warn('Gagal mengambil edits.json:', e.message);
    }
  },

  mulaiPoll() {
    clearInterval(this.jedaPoll);
    this.jedaPoll = setInterval(async () => {
      if (document.hidden || document.body.classList.contains('saving')) return;
      const sebelum = JSON.stringify(Store.remote);
      await this.muatEdits();
      if (JSON.stringify(Store.remote) !== sebelum) {
        toast('Perubahan terbaru dari pengedit lain telah dimuat.', '', 4000);
      }
    }, 120000);
  },

  // ------------------------------------------------------------ bilah alat
  pasangBilahAlat() {
    $('#btn-mode').addEventListener('click', () => this.gantiMode());

    $$('.btn.tool').forEach((b) => b.addEventListener('click', () => {
      const alat = b.dataset.tool;
      if (alat === 'delete') return this.hapusTerpilih();
      this.pilihAlat(Peta.alat === alat ? null : alat);
    }));

    $('#btn-undo').addEventListener('click', () => { Store.undo(); toast('Diurungkan.', ''); });
    $('#btn-redo').addEventListener('click', () => { Store.redo(); toast('Diulangi.', ''); });
    $('#btn-save').addEventListener('click', () => this.simpan());
    $('#basemap').addEventListener('change', (e) => {
      Peta.gantiDasar(e.target.value);
      Store.simpanCfg({ basemap: e.target.value });
    });
    if (Store.cfg.basemap) {
      $('#basemap').value = Store.cfg.basemap;
      Peta.gantiDasar(Store.cfg.basemap);
    }
  },

  gantiMode(paksa) {
    const nyala = paksa === undefined ? !Peta.modeEdit : paksa;
    Peta.modeEdit = nyala;
    document.body.classList.toggle('editing', nyala);
    $('#mode-label').textContent = nyala ? 'Mode Edit AKTIF' : 'Mode Lihat';
    $('#btn-mode').title = nyala ? 'Kembali ke mode lihat (E)' : 'Aktifkan mode edit (E)';
    $('#edit-tools').hidden = !nyala;
    if (!nyala) this.pilihAlat(null);
    Form.render();
    Tabel.render();
    this.petunjuk(nyala
      ? 'Mode edit aktif — seret titik untuk memindahkan, klik untuk mengubah atributnya.'
      : null);
  },

  pilihAlat(alat) {
    if (Peta.alat === 'measure' && alat !== 'measure') Penggaris.matikan();
    Peta.alat = alat;
    $$('.btn.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === alat));
    document.body.classList.toggle('tool-measure', alat === 'measure');

    if (alat === 'measure') { Penggaris.nyalakan(); this.petunjuk(null); return; }
    if (alat === 'add-reklame') {
      this.petunjuk('Klik di peta untuk menempatkan titik reklame baru. Esc untuk batal.');
    } else if (alat === 'add-pov') {
      const s = Peta.pilih;
      if (!s || s.ly !== 'reklame') {
        toast('Pilih dulu satu titik reklame sebagai induk POV, lalu tekan “＋ POV”.', 'warn', 5000);
        Peta.alat = null;
        $$('.btn.tool').forEach((b) => b.classList.remove('active'));
        return;
      }
      const r = Store.get('reklame', s.key);
      this.petunjuk(`Klik di peta untuk menambah POV pada <b>${esc(r.props.ID_TITIK)}</b>. Esc untuk batal.`);
    } else {
      this.petunjuk(Peta.modeEdit
        ? 'Mode edit aktif — seret titik untuk memindahkan, klik untuk mengubah atributnya.'
        : null);
    }
  },

  petunjuk(html) {
    const el = $('#hint');
    if (!html) { el.hidden = true; return; }
    el.innerHTML = html;
    el.hidden = false;
  },

  klikTambah(ll) {
    if (Peta.alat === 'add-reklame') {
      const f = Store.tambahReklame(ll.lng, ll.lat);
      Peta.gambarUlang();
      Peta.pilihTitik('reklame', f.key);
      $('#side').classList.remove('collapsed');
      toast(`Titik <b>${esc(f.props.ID_TITIK)}</b> ditambahkan. Lengkapi atributnya di panel kanan.`, 'ok', 6000);
      this.pilihAlat(null);
    } else if (Peta.alat === 'add-pov') {
      const s = Peta.pilih;
      if (!s || s.ly !== 'reklame') { this.pilihAlat(null); return; }
      const f = Store.tambahPov(s.key, ll.lng, ll.lat);
      if (!f) return;
      Peta.gambarUlang();
      toast(`POV ${f.props.POV_KE} ditambahkan — ${fmtJarak(f.props.JARAK_M)} dari reklame.`, 'ok');
      this.pilihAlat(null);
    }
  },

  hapusTerpilih() {
    const s = Peta.pilih;
    if (!s) { toast('Pilih dulu titik yang akan dihapus.', 'warn'); return; }
    const f = Store.get(s.ly, s.key);
    const nama = f.props[KUNCI[s.ly]];
    const anak = s.ly === 'reklame' ? Store.anakDari(s.key).length : 0;
    const tanya = `Tandai ${s.ly === 'pov' ? 'titik POV' : 'reklame'} "${nama}" sebagai dihapus?` +
      (anak ? `\n\n${anak} titik POV miliknya ikut ditandai dihapus.` : '') +
      '\n\nData tidak dibuang permanen dan dapat dipulihkan kembali.';
    if (!confirm(tanya)) return;
    Store.hapus(s.ly, s.key);
    Peta.gambarUlang();
    toast('Ditandai dihapus. Tekan Ctrl+Z untuk membatalkan.', 'ok', 6000);
  },

  // ------------------------------------------------------------ legenda
  pasangLegenda() {
    const pasang = (id, kunci) => $(id).addEventListener('change', (e) => {
      Peta.tampil[kunci] = e.target.checked;
      Peta.gambarUlang();
      Tabel.render();
    });
    pasang('#ly-reklame', 'reklame');
    pasang('#ly-pov', 'pov');
    pasang('#ly-link', 'garis');
    pasang('#ly-deleted', 'dihapus');
    pasang('#ly-flag', 'tanda');

    $('#legend-toggle').addEventListener('click', () => {
      const l = $('#legend');
      l.classList.toggle('min');
      $('#legend-toggle').textContent = l.classList.contains('min') ? '+' : '–';
    });

    $('#color-by').addEventListener('change', (e) => {
      Peta.warnaOleh = e.target.value;
      Peta.sembunyi.clear();
      Peta.gambarUlang();
      this.legendaWarna();
      Store.simpanCfg({ warnaOleh: e.target.value });
    });
    if (Store.cfg.warnaOleh) {
      $('#color-by').value = Store.cfg.warnaOleh;
      Peta.warnaOleh = Store.cfg.warnaOleh;
      Peta.gambarUlang();
    }

    $('#color-legend').addEventListener('click', (e) => {
      const el = e.target.closest('.cl');
      if (!el) return;
      const k = el.dataset.k;
      if (Peta.sembunyi.has(k)) Peta.sembunyi.delete(k); else Peta.sembunyi.add(k);
      Peta.gambarUlang();
      this.legendaWarna();
    });
    this.legendaWarna();
  },

  legendaWarna() {
    const box = $('#color-legend');
    if (Peta.warnaOleh === '_none') { box.innerHTML = ''; return; }
    const urut = [...(Peta.hitungKategori || new Map())].sort((a, b) => b[1] - a[1]);
    box.innerHTML = urut.map(([k, n]) => `
      <div class="cl${Peta.sembunyi.has(k) ? ' off' : ''}" data-k="${esc(k)}" title="Klik untuk menyembunyikan">
        <span class="sw" style="background:${Peta.skalaWarna.get(k) || '#8b9bb0'}"></span>
        <span>${esc(k)}</span><em>${n.toLocaleString('id-ID')}</em></div>`).join('');
  },

  // ------------------------------------------------------------ pencarian
  pasangPencarian() {
    const kotak = $('#search'), hasil = $('#search-results');
    const cari = debounce(() => {
      const q = kotak.value.trim().toLowerCase();
      if (q.length < 2) { hasil.hidden = true; return; }
      const out = [];
      for (const ly of ['reklame', 'pov']) {
        for (const [key, f] of Store.semua(ly)) {
          if (!f || (f.status === 'del' && !Peta.tampil.dihapus)) continue;
          const p = f.props;
          const teks = [p[KUNCI[ly]], p.NAMA_JALAN, p.KELURAHAN, p.KECAMATAN, p.UID]
            .filter(Boolean).join(' ').toLowerCase();
          if (teks.includes(q)) out.push({ ly, key, f });
          if (out.length > 40) break;
        }
        if (out.length > 40) break;
      }
      hasil.innerHTML = out.length
        ? out.slice(0, 25).map((o) => `<div class="sr" data-ly="${o.ly}" data-key="${esc(o.key)}">
            <b>${esc(o.f.props[KUNCI[o.ly]])}</b>
            <small>${o.ly === 'pov' ? 'POV · ' : ''}${esc(o.f.props.NAMA_JALAN || '')} · ${esc(o.f.props.KELURAHAN || '')}</small>
          </div>`).join('')
        : '<div class="sr" style="color:#8b9bb0">Tidak ditemukan.</div>';
      hasil.hidden = false;
    }, 200);

    kotak.addEventListener('input', cari);
    kotak.addEventListener('focus', cari);
    hasil.addEventListener('click', (e) => {
      const el = e.target.closest('.sr[data-key]');
      if (!el) return;
      Peta.pilihTitik(el.dataset.ly, el.dataset.key, { zoom: true });
      $('#side').classList.remove('collapsed');
      hasil.hidden = true;
      kotak.blur();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#search') && !e.target.closest('#search-results')) hasil.hidden = true;
    });
  },

  // ------------------------------------------------------------ penyimpanan
  setelahUbah() {
    for (const k of Store.terakhirUbah || []) {
      const i = k.indexOf(':');
      Peta.perbarui(k.slice(0, i), k.slice(i + 1));
    }
    Form.render();
    Tabel._gambarBaris();
    this.perbaruiStatus();
    this.legendaWarna();

    if (Store.cfg.autosave !== false && Store.cfg.token && Store.jmlBelumKirim()) {
      this.simpanOtomatis ??= debounce(() => this.simpan({ diam: true }), 5000);
      this.simpanOtomatis();
    }
  },

  perbaruiStatus() {
    const n = Store.jmlBelumKirim();
    document.body.classList.toggle('dirty', n > 0);
    $('#btn-undo').disabled = !Store.bisaUndo();
    $('#btn-redo').disabled = !Store.bisaRedo();
    if (document.body.classList.contains('saving')) return;
    $('#save-icon').textContent = n ? '⬆' : '☁';
    $('#save-text').textContent = n ? `Simpan ${n}` : 'Tersimpan';
    $('#btn-save').title = n
      ? `${n} titik berubah dan belum terkirim ke GitHub (Ctrl+S)`
      : 'Semua perubahan sudah tersimpan di GitHub';
  },

  async simpan({ diam = false } = {}) {
    if (!Store.jmlBelumKirim()) {
      if (!diam) toast('Tidak ada perubahan yang perlu disimpan.', '');
      return;
    }
    if (!Store.cfg.token) {
      window.__modal('#modal-settings', true);
      toast('Atur koneksi GitHub dulu agar perubahan bisa disimpan.', 'warn', 6000);
      return;
    }
    document.body.classList.add('saving');
    document.body.classList.remove('saveerr');
    $('#save-icon').textContent = '↻';
    $('#save-text').textContent = 'Menyimpan…';
    try {
      const r = await GH.simpan();
      document.body.classList.remove('saving');
      this.perbaruiStatus();
      Peta.gambarUlang();
      Tabel.render();
      Form.render();
      toast(`Tersimpan ke GitHub — ${r.jumlah} titik, ${new Date().toLocaleTimeString('id-ID')}.`, 'ok');
    } catch (e) {
      document.body.classList.remove('saving');
      document.body.classList.add('saveerr');
      $('#save-icon').textContent = '⚠';
      $('#save-text').textContent = 'Gagal';
      toast('Gagal menyimpan: ' + esc(e.message), 'err', 9000);
    }
  },

  // ------------------------------------------------------------ pengaturan
  pasangPengaturan() {
    const isi = () => {
      $('#cfg-editor').value = Store.cfg.editor || '';
      $('#cfg-owner').value = Store.cfg.owner || '';
      $('#cfg-repo').value = Store.cfg.repo || '';
      $('#cfg-branch').value = Store.cfg.branch || 'main';
      $('#cfg-token').value = Store.cfg.token || '';
      $('#cfg-autosave').checked = Store.cfg.autosave !== false;
    };
    $('#btn-settings').addEventListener('click', () => { isi(); window.__modal('#modal-settings', true); });

    const simpanCfg = () => Store.simpanCfg({
      editor: $('#cfg-editor').value.trim(),
      owner: $('#cfg-owner').value.trim(),
      repo: $('#cfg-repo').value.trim(),
      branch: $('#cfg-branch').value.trim() || 'main',
      token: $('#cfg-token').value.trim(),
      autosave: $('#cfg-autosave').checked,
    });
    ['#cfg-editor', '#cfg-owner', '#cfg-repo', '#cfg-branch', '#cfg-token', '#cfg-autosave']
      .forEach((s) => $(s).addEventListener('change', () => { simpanCfg(); this.perbaruiStatus(); }));

    $('#btn-test').addEventListener('click', async () => {
      simpanCfg();
      const out = $('#test-result');
      out.textContent = 'Menguji…';
      try {
        out.innerHTML = '<span style="color:#3fb950">✓ ' + esc(await GH.uji(Store.cfg)) + '</span>';
      } catch (e) {
        out.innerHTML = '<span style="color:#f85149">✕ ' + esc(e.message) + '</span>';
      }
    });

    $('#btn-reload').addEventListener('click', async () => {
      await this.muatEdits();
      toast('Data terbaru dimuat dari GitHub.', 'ok');
    });

    // penutupan modal
    window.__modal = (sel, buka) => {
      $('#modal-backdrop').hidden = !buka;
      $(sel).hidden = !buka;
      if (!buka) $$('.modal').forEach((m) => (m.hidden = true));
    };
    $('#modal-backdrop').addEventListener('click', () => window.__modal('.modal', false));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
      $('#modal-backdrop').hidden = true;
      $$('.modal').forEach((m) => (m.hidden = true));
    }));
  },

  // ------------------------------------------------------------ ekspor
  pasangEkspor() {
    $('#btn-export').addEventListener('click', () => window.__modal('#modal-export', true));
    $$('[data-export]').forEach((b) => b.addEventListener('click', () => {
      const jenis = b.dataset.export;
      const cap = new Date().toISOString().slice(0, 10);
      if (jenis === 'edits') {
        unduh(`edits-${cap}.json`, JSON.stringify(Store.berkasEdits(), null, 1));
      } else {
        const [ly, fmt] = jenis.split('-');
        if (fmt === 'geojson') unduh(`${ly}-${cap}.geojson`, JSON.stringify(this.keGeoJSON(ly)));
        else unduh(`${ly}-${cap}.csv`, this.keCSV(ly), 'text/csv');
      }
      toast('Berkas diunduh.', 'ok');
    }));
  },

  keGeoJSON(ly) {
    const feats = [];
    for (const [key, f] of Store.semua(ly)) {
      if (!f || f.status === 'del') continue;
      const props = { ...f.props };
      if (ly === 'pov' && f.pkey) {                    // selaraskan tautan ke induk
        const r = Store.get('reklame', f.pkey);
        if (r) { props.ID_TITIK = r.props.ID_TITIK; props.UID = r.props.UID; }
      }
      props._STATUS_EDIT = f.status;
      if (f.by) { props._DIUBAH_OLEH = f.by; props._DIUBAH_PADA = f.at; }
      feats.push({
        type: 'Feature', id: props[KUNCI[ly]],
        properties: props,
        geometry: f.geom ? { type: 'Point', coordinates: f.geom } : null,
      });
    }
    return { type: 'FeatureCollection',
             crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
             features: feats };
  },

  keCSV(ly) {
    const kol = Store.schema[ly].fields.map((d) => d.name).filter((n) => n !== 'fid');
    const kepala = [...kol, '_STATUS_EDIT', '_DIUBAH_OLEH', '_DIUBAH_PADA'];
    const baris = [kepala];
    for (const [key, f] of Store.semua(ly)) {
      if (!f || f.status === 'del') continue;
      baris.push([...kol.map((c) => f.props[c] ?? ''), f.status, f.by || '', f.at || '']);
    }
    return csv(baris);
  },

  // ------------------------------------------------------------ pintasan
  pasangPintasan() {
    document.addEventListener('keydown', (e) => {
      const dalamIsian = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); this.simpan(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); Store.undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' ||
          (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault(); Store.redo(); return;
      }
      if (dalamIsian) return;
      if (e.key === 'e' || e.key === 'E') this.gantiMode();
      if (e.key === 'm' || e.key === 'M') this.pilihAlat(Peta.alat === 'measure' ? null : 'measure');
      if (e.key === 'Delete' && Peta.modeEdit) this.hapusTerpilih();
      if (e.key === 'Escape') {
        if (Peta.alat && Peta.alat !== 'measure') this.pilihAlat(null);
        else if (!$('#modal-backdrop').hidden) window.__modal('.modal', false);
        else Form.tutup();
      }
      if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    });

    window.addEventListener('beforeunload', (e) => {
      if (Store.jmlBelumKirim()) { e.preventDefault(); e.returnValue = ''; }
    });
  },
};

App.mulai();
window.App = App;
window.Peta = Peta;
window.Store = Store;
