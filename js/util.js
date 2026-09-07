// Fungsi bantu umum: format angka, jarak, notifikasi, unduhan.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Jarak elipsoid pendek (haversine) dalam meter. */
export function jarakM(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Luas poligon bola dalam m2, titik = [[lon,lat],…] tertutup atau tidak. */
export function luasM2(pts) {
  if (pts.length < 3) return 0;
  const R = 6371008.8, rad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    total += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
  }
  return Math.abs(total * R * R / 2);
}

export function fmtJarak(m) {
  if (!isFinite(m)) return '—';
  return m < 1000 ? m.toFixed(m < 10 ? 2 : 1) + ' m'
                  : (m / 1000).toFixed(m < 10000 ? 3 : 2) + ' km';
}

export function fmtLuas(m2) {
  if (m2 < 10000) return m2.toFixed(1) + ' m²';
  if (m2 < 1e6) return (m2 / 10000).toFixed(3) + ' ha';
  return (m2 / 1e6).toFixed(3) + ' km²';
}

export function fmtAngka(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v.toLocaleString('id-ID');
  return v.toLocaleString('id-ID', { maximumFractionDigits: 6 });
}

export function fmtWaktu(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric',
                                     hour: '2-digit', minute: '2-digit' });
}

export function toast(msg, jenis = '', ms = 3800) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + jenis;
  el.innerHTML = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

export function unduh(namaFile, isi, mime = 'application/json') {
  const blob = new Blob([isi], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = namaFile;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Base64 aman-UTF8 untuk GitHub Contents API. */
export function keB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export function dariB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function csv(baris) {
  const q = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + baris.map((r) => r.map(q).join(';')).join('\r\n');
}
