// Klien GitHub Contents API.
//
// Berkas data/edits.json berperan sebagai basis data perubahan. Setiap
// penyimpanan: ambil versi terbaru dari GitHub, gabungkan perubahan lokal
// di atasnya, lalu kirim dengan sha lama sebagai penjaga agar perubahan
// pengedit lain tidak tertimpa diam-diam.

import { keB64, dariB64 } from './util.js';
import { Store } from './store.js';

const JALUR = 'data/edits.json';
const API = 'https://api.github.com';

function siap(cfg) { return !!(cfg.owner && cfg.repo && cfg.token); }

function kepala(cfg, tambahan = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {}),
    ...tambahan,
  };
}

async function pesanGagal(res) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch (e) { /* bukan JSON */ }
  const umum = {
    401: 'Token ditolak. Periksa kembali token akses di Pengaturan.',
    403: 'Akses ditolak. Pastikan token punya izin Contents: Read and write untuk repositori ini.',
    404: 'Repositori atau branch tidak ditemukan. Periksa nama pemilik, repositori, dan branch.',
    409: 'Ada perubahan lain yang lebih baru di GitHub.',
    422: 'GitHub menolak isi permintaan.',
  }[res.status];
  return (umum || 'Gagal menghubungi GitHub (HTTP ' + res.status + ')') +
         (detail ? ' — ' + detail : '');
}

export const GH = {
  /** Ambil edits.json terbaru beserta sha-nya. Kembalikan null bila belum ada. */
  async ambilEdits(cfg = Store.cfg) {
    if (!cfg.owner || !cfg.repo) return null;
    const url = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${JALUR}` +
                `?ref=${encodeURIComponent(cfg.branch || 'main')}&t=${Date.now()}`;
    const res = await fetch(url, { headers: kepala(cfg), cache: 'no-store' });
    if (res.status === 404) return { isi: null, sha: null };
    if (!res.ok) throw new Error(await pesanGagal(res));
    const j = await res.json();
    return { isi: JSON.parse(dariB64(j.content)), sha: j.sha };
  },

  /**
   * Kirim seluruh overlay saat ini sebagai satu commit.
   * Bila ada pengedit lain yang menyimpan lebih dulu, perubahannya
   * diambil dulu lalu digabung, dan pengiriman diulang.
   */
  async simpan(cfg = Store.cfg, { pesan } = {}) {
    if (!siap(cfg)) throw new Error('Koneksi GitHub belum diatur. Buka Pengaturan (⚙).');

    for (let coba = 0; coba < 3; coba++) {
      const jauh = await this.ambilEdits(cfg);
      Store.terapkanRemote(jauh.isi, { pertahankanLokal: true });

      const isi = Store.berkasEdits();
      const n = Store.jmlBelumKirim();
      const body = {
        message: pesan || `Perubahan peta reklame: ${n} titik (${cfg.editor || 'anonim'})`,
        content: keB64(JSON.stringify(isi, null, 1)),
        branch: cfg.branch || 'main',
        ...(jauh.sha ? { sha: jauh.sha } : {}),
      };
      const res = await fetch(
        `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${JALUR}`,
        { method: 'PUT', headers: kepala(cfg, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body) });

      if (res.ok) {
        const j = await res.json();
        Store.sha = j.content.sha;
        Store.tandaiTerkirim();
        return { sha: j.content.sha, commit: j.commit?.html_url, jumlah: n };
      }
      if (res.status === 409 || res.status === 422) continue;  // bentrok: ulangi
      throw new Error(await pesanGagal(res));
    }
    throw new Error('Gagal menyimpan setelah 3 percobaan karena perubahan bersamaan. Coba lagi.');
  },

  /** Uji apakah token dan repositori dapat diakses untuk menulis. */
  async uji(cfg) {
    if (!cfg.owner || !cfg.repo) throw new Error('Nama pemilik dan repositori wajib diisi.');
    const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}`, { headers: kepala(cfg) });
    if (!res.ok) throw new Error(await pesanGagal(res));
    const j = await res.json();
    if (!j.permissions?.push) {
      throw new Error('Terhubung, tetapi token tidak punya izin menulis (Contents: Read and write).');
    }
    return `Terhubung ke ${j.full_name} — izin tulis aktif.`;
  },
};
