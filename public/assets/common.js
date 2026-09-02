/* Small shared helpers: fetch wrapper, DOM utilities, formatting. */
(function () {
  'use strict';

  async function request(method, url, body, { isForm = false } = {}) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined && body !== null) {
      if (isForm) options.body = body;
      else {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
    }

    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      throw Object.assign(new Error('network'), { network: true });
    }

    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => null);
    }

    if (!res.ok) {
      throw Object.assign(new Error((data && data.error) || 'http_' + res.status), {
        status: res.status,
        data,
        fields: (data && data.fields) || null,
      });
    }
    return data;
  }

  const api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url) => request('DELETE', url),
    upload: (url, formData) => request('POST', url, formData, { isForm: true }),
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Build an element. Text is set with textContent, never innerHTML. */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, val] of Object.entries(attrs || {})) {
      if (val === null || val === undefined || val === false) continue;
      if (k === 'class') node.className = val;
      else if (k === 'text') node.textContent = val;
      else if (k === 'html') node.innerHTML = val;
      else if (k.startsWith('on') && typeof val === 'function') node.addEventListener(k.slice(2), val);
      else if (k === 'dataset') Object.assign(node.dataset, val);
      else node.setAttribute(k, val);
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + (String(iso).length === 10 ? 'T00:00:00' : ''));
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtMoney(n) {
    if (n === null || n === undefined || n === '') return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Show a .status box; pass kind 'ok' | 'fail' | 'info'. */
  function setStatus(node, kind, message) {
    if (!node) return;
    node.className = 'status show ' + kind;
    node.textContent = message;
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideStatus(node) {
    if (node) node.className = 'status';
  }

  function clearFieldErrors(root) {
    $$('.err', root).forEach((n) => n.classList.remove('err'));
    $$('.ferr', root).forEach((n) => n.remove());
  }

  /** Paint server-side validation errors next to their inputs. */
  function showFieldErrors(fields, prefix) {
    let first = null;
    for (const [name, message] of Object.entries(fields || {})) {
      const node = document.getElementById((prefix || '') + name);
      if (!node) continue;
      node.classList.add('err');
      node.parentElement.appendChild(el('div', { class: 'ferr', text: message }));
      if (!first) first = node;
    }
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return Boolean(first);
  }

  function errorMessage(err) {
    if (err && err.network) return window.I18N.t('error_network');
    if (err && err.data && err.data.message) return err.data.message;
    return window.I18N.t('error_generic');
  }

  /** Warranty badge (colour + label) for a device. */
  function warrantyBadge(device) {
    const T = window.I18N.t;
    const map = {
      active: ['badge badge-ok', T('dev_warranty_active')],
      expiring: ['badge badge-warn', T('dev_warranty_expiring')],
      expired: ['badge badge-bad', T('dev_warranty_expired')],
      unknown: ['badge', T('dev_warranty_unknown')],
    };
    const [cls, label] = map[device.warranty_status] || map.unknown;
    return el('span', { class: cls, text: label });
  }

  function modal({ title, body, footer, wide }) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const closeIt = () => backdrop.remove();
    const box = el('div', { class: 'modal' + (wide ? ' modal-wide' : '') }, [
      el('div', { class: 'modal-header' }, [
        el('div', { class: 'modal-title', text: title }),
        el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', onclick: closeIt, html: '&times;' }),
      ]),
      el('div', { class: 'modal-body' }, body),
      footer ? el('div', { class: 'modal-footer' }, footer) : null,
    ]);
    backdrop.appendChild(box);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeIt(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { closeIt(); document.removeEventListener('keydown', onKey); }
    });
    document.body.appendChild(backdrop);
    return { node: backdrop, close: closeIt, body: box.querySelector('.modal-body') };
  }

  /** Reusable file picker with thumbnails. */
  function filePicker({ accept, max = 10, labelKey = 'claim_media', hintKey }) {
    const files = [];
    const input = el('input', { type: 'file', accept, multiple: 'multiple' });
    const grid = el('div', { class: 'preview-grid' });
    const zone = el('div', { class: 'upload-zone' }, [
      input,
      el('div', { class: 'upload-label', text: window.I18N.t(labelKey) }),
      hintKey ? el('div', { class: 'upload-hint', text: window.I18N.t(hintKey) }) : null,
    ]);

    function render() {
      clear(grid);
      files.forEach((f, i) => {
        const wrap = el('div', { class: 'preview-thumb' });
        if (f.type.startsWith('image/')) {
          const url = URL.createObjectURL(f);
          wrap.appendChild(el('img', { src: url, alt: f.name, onload: () => URL.revokeObjectURL(url) }));
        } else {
          wrap.appendChild(el('div', { class: 'vid-label', text: f.name }));
        }
        wrap.appendChild(el('button', {
          type: 'button', class: 'remove-thumb', html: '&times;',
          onclick: () => { files.splice(i, 1); render(); },
        }));
        grid.appendChild(wrap);
      });
    }

    function add(list) {
      Array.from(list || []).forEach((f) => { if (files.length < max) files.push(f); });
      render();
    }

    input.addEventListener('change', () => { add(input.files); input.value = ''; });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag-over'); add(e.dataTransfer.files); });

    return { node: el('div', {}, [zone, grid]), files };
  }

  /** Wire the language toggle in the top bar. */
  function initLangToggle() {
    const btn = document.getElementById('langToggle');
    if (btn) btn.addEventListener('click', () => window.I18N.toggle());
  }

  window.App = {
    api, $, $$, el, clear, fmtDate, fmtDateTime, fmtMoney,
    setStatus, hideStatus, clearFieldErrors, showFieldErrors, errorMessage,
    warrantyBadge, modal, filePicker, initLangToggle,
  };
})();
