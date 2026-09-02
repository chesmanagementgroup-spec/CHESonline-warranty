/* Customer portal: register equipment, keep details current, report faults. */
(function () {
  'use strict';

  const {
    api, $, $$, el, clear, fmtDate, fmtDateTime, setStatus, hideStatus,
    clearFieldErrors, showFieldErrors, errorMessage, warrantyBadge, modal, filePicker,
  } = window.App;
  const T = (k, v) => window.I18N.t(k, v);
  const TV = (kind, value) => window.I18N.tv(kind, value);

  const state = { customer: null, devices: [], summary: {}, claims: [], categories: [] };

  // --- Boot ----------------------------------------------------------------

  async function boot() {
    let session;
    try {
      session = await api.get('/api/auth/session');
    } catch (err) {
      location.href = '/';
      return;
    }
    if (!session.customer) { location.href = '/'; return; }

    await Promise.all([loadProfile(), loadDevices(), loadClaims()]);
    render();
  }

  async function loadProfile() {
    const data = await api.get('/api/portal/profile');
    state.customer = data.customer;
    state.categories = data.categories || [];
    $('#companyName').textContent = data.customer.company_name || data.customer.email;
    fillProfileForm();
  }

  async function loadDevices() {
    const data = await api.get('/api/portal/devices');
    state.devices = data.devices;
    state.summary = data.summary;
  }

  async function loadClaims() {
    const data = await api.get('/api/portal/claims');
    state.claims = data.claims;
  }

  function render() {
    renderStats();
    renderDevices();
    renderClaims();
  }

  // --- Stats ---------------------------------------------------------------

  function renderStats() {
    const grid = $('#statGrid');
    clear(grid);
    const s = state.summary;
    const tiles = [
      [s.total || 0, T('tab_equipment'), false],
      [s.pending || 0, T('dev_pending'), (s.pending || 0) > 0],
      [s.in_warranty || 0, T('dev_warranty_active'), false],
      [s.expiring || 0, T('dev_warranty_expiring'), (s.expiring || 0) > 0],
    ];
    for (const [num, label, alert] of tiles) {
      grid.appendChild(el('div', { class: 'stat' + (alert ? ' alert' : '') }, [
        el('div', { class: 'stat-num', text: String(num) }),
        el('div', { class: 'stat-label', text: label }),
      ]));
    }
  }

  // --- Equipment -----------------------------------------------------------

  function deviceSubtitle(d) {
    const bits = [];
    if (d.brand) bits.push(d.brand);
    if (d.model_code) bits.push(d.model_code);
    if (d.serial_number) bits.push('S/N ' + d.serial_number);
    bits.push(d.asset_tag);
    return bits.join('  ·  ');
  }

  function warrantyLine(d) {
    if (d.warranty_status === 'unknown' || !d.warranty_end) return T('dev_warranty_unknown');
    const until = T('dev_warranty_until') + ' ' + fmtDate(d.warranty_end);
    // Until the delivery date is confirmed the end date is only provisional —
    // it is derived from the invoice date, not from when the machine landed.
    if (d.needs_registration) return T('dev_warranty_provisional', { date: fmtDate(d.warranty_end) });
    if (d.warranty_status === 'expired') return until;
    return until + '  ·  ' + T('dev_days_left', { n: d.warranty_days_remaining });
  }

  function renderDevices() {
    const list = $('#deviceList');
    clear(list);

    if (!state.devices.length) {
      list.appendChild(el('div', { class: 'empty', text: T('dev_none') }));
      return;
    }

    for (const d of state.devices) {
      const card = el('button', { class: 'card', type: 'button', onclick: () => openDevice(d.id) }, [
        el('div', { class: 'card-top' }, [
          el('div', {}, [
            el('div', { class: 'card-title', text: d.product_name }),
            el('div', { class: 'card-meta', text: deviceSubtitle(d) }),
            el('div', { class: 'card-meta', text: warrantyLine(d) }),
          ]),
          el('div', { style: 'display:flex; flex-direction:column; gap:5px; align-items:flex-end;' }, [
            d.needs_registration
              ? el('span', { class: 'badge badge-dark', text: T('dev_pending') })
              : warrantyBadge(d),
          ]),
        ]),
      ]);
      list.appendChild(card);
    }
  }

  /** Device detail + registration form. */
  async function openDevice(id) {
    let data;
    try {
      data = await api.get('/api/portal/devices/' + id);
    } catch (err) {
      alert(errorMessage(err));
      return;
    }
    const d = data.device;

    const form = el('form', { id: 'deviceForm', novalidate: 'novalidate' }, [
      el('dl', { class: 'dl', style: 'margin-bottom:20px;' }, [
        el('dt', { text: T('dev_product') }), el('dd', { text: d.product_name }),
        el('dt', { text: T('dev_asset') }), el('dd', { text: d.asset_tag }),
        d.brand ? el('dt', { text: T('dev_brand') }) : null, d.brand ? el('dd', { text: d.brand }) : null,
        d.model_code ? el('dt', { text: T('dev_model') }) : null, d.model_code ? el('dd', { text: d.model_code }) : null,
        d.invoice_number ? el('dt', { text: T('dev_invoice') }) : null, d.invoice_number ? el('dd', { text: d.invoice_number }) : null,
        d.purchase_date ? el('dt', { text: T('dev_purchased') }) : null, d.purchase_date ? el('dd', { text: fmtDate(d.purchase_date) }) : null,
        el('dt', { text: T('dev_warranty') }), el('dd', {}, [warrantyBadge(d), el('span', { text: '  ' + warrantyLine(d) })]),
      ]),

      field('delivered_at', T('dev_delivered'), el('input', {
        type: 'date', id: 'delivered_at', value: d.delivered_at || '',
        max: new Date().toISOString().slice(0, 10),
      }), T('dev_delivered_hint'), true),

      field('serial_number', T('dev_serial'), el('input', {
        type: 'text', id: 'serial_number', value: d.serial_number || '',
      }), T('dev_serial_hint')),

      field('location_note', T('dev_location'), el('input', {
        type: 'text', id: 'location_note', value: d.location_note || '',
      }), T('dev_location_hint')),

      field('notes', T('dev_notes'), el('textarea', { id: 'notes', style: 'min-height:70px;', text: d.notes || '' })),
    ]);

    const picker = filePicker({ accept: 'image/*', max: 5, labelKey: 'dev_photos' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { text: T('dev_photos') }),
      picker.node,
    ]));

    if (data.attachments.length) {
      const grid = el('div', { class: 'preview-grid' });
      for (const a of data.attachments) {
        grid.appendChild(el('div', { class: 'preview-thumb' }, [
          a.mime_type.startsWith('image/')
            ? el('img', { src: '/api/files/' + a.id, alt: a.original_name })
            : el('div', { class: 'vid-label', text: a.original_name }),
        ]));
      }
      form.appendChild(grid);
    }

    const status = el('div', { class: 'status' });
    form.appendChild(status);

    const saveBtn = el('button', { class: 'btn', type: 'submit', form: 'deviceForm', text: T('save') });
    const reportBtn = el('button', {
      class: 'btn btn-ghost', type: 'button', text: T('dev_report'),
      onclick: () => { m.close(); openClaimForm(d.id); },
    });

    const m = modal({
      title: d.product_name,
      body: form,
      footer: [reportBtn, saveBtn],
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors(form);
      hideStatus(status);
      saveBtn.disabled = true;
      try {
        await api.put('/api/portal/devices/' + id, {
          delivered_at: $('#delivered_at', form).value,
          serial_number: $('#serial_number', form).value,
          location_note: $('#location_note', form).value,
          notes: $('#notes', form).value,
        });
        if (picker.files.length) {
          const fd = new FormData();
          picker.files.forEach((f) => fd.append('files', f));
          await api.upload('/api/portal/devices/' + id + '/photos', fd);
        }
        await loadDevices();
        render();
        m.close();
      } catch (err) {
        if (err.fields && showFieldErrors(err.fields)) { /* shown inline */ }
        else setStatus(status, 'fail', errorMessage(err));
        saveBtn.disabled = false;
      }
    });
  }

  function field(id, label, input, hint, required) {
    return el('div', { class: 'field' }, [
      el('label', { for: id }, [
        el('span', { text: label }),
        required ? el('span', { class: 'req', text: ' *' }) : null,
      ]),
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);
  }

  /** Manually add a machine that never came through an invoice import. */
  function openAddDevice() {
    const form = el('form', { id: 'addDeviceForm', novalidate: 'novalidate' }, [
      field('product_name', T('dev_product'), el('input', { type: 'text', id: 'new_product_name' }), null, true),
      el('div', { class: 'row-2' }, [
        field('brand', T('dev_brand'), el('input', { type: 'text', id: 'new_brand' })),
        field('model_code', T('dev_model'), el('input', { type: 'text', id: 'new_model_code' })),
      ]),
      el('div', { class: 'row-2' }, [
        field('serial_number', T('dev_serial'), el('input', { type: 'text', id: 'new_serial_number' })),
        field('invoice_number', T('dev_invoice'), el('input', { type: 'text', id: 'new_invoice_number' })),
      ]),
      el('div', { class: 'row-2' }, [
        field('purchase_date', T('dev_purchased'), el('input', { type: 'date', id: 'new_purchase_date' })),
        field('delivered_at', T('dev_delivered'), el('input', {
          type: 'date', id: 'new_delivered_at', max: new Date().toISOString().slice(0, 10),
        })),
      ]),
      field('location_note', T('dev_location'), el('input', { type: 'text', id: 'new_location_note' })),
    ]);
    const status = el('div', { class: 'status' });
    form.appendChild(status);

    const saveBtn = el('button', { class: 'btn', type: 'submit', form: 'addDeviceForm', text: T('save') });
    const m = modal({ title: T('dev_add'), body: form, footer: [saveBtn] });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors(form);
      saveBtn.disabled = true;
      try {
        await api.post('/api/portal/devices', {
          product_name: $('#new_product_name', form).value,
          brand: $('#new_brand', form).value,
          model_code: $('#new_model_code', form).value,
          serial_number: $('#new_serial_number', form).value,
          invoice_number: $('#new_invoice_number', form).value,
          purchase_date: $('#new_purchase_date', form).value,
          delivered_at: $('#new_delivered_at', form).value,
          location_note: $('#new_location_note', form).value,
        });
        await loadDevices();
        render();
        m.close();
      } catch (err) {
        setStatus(status, 'fail', errorMessage(err));
        saveBtn.disabled = false;
      }
    });
  }

  // --- Service requests ----------------------------------------------------

  function statusBadge(claim) {
    const cls = claim.status === 'resolved' || claim.status === 'closed'
      ? 'badge badge-ok'
      : claim.status === 'submitted' ? 'badge badge-dark' : 'badge';
    return el('span', { class: cls, text: TV('status', claim.status) });
  }

  function renderClaims() {
    const list = $('#claimList');
    clear(list);
    if (!state.claims.length) {
      list.appendChild(el('div', { class: 'empty', text: T('claim_none') }));
      return;
    }
    for (const c of state.claims) {
      list.appendChild(el('button', { class: 'card', type: 'button', onclick: () => openClaim(c.id) }, [
        el('div', { class: 'card-top' }, [
          el('div', {}, [
            el('div', { class: 'card-title', text: (c.device_name || TV('category', c.category)) }),
            el('div', { class: 'card-meta', text: c.reference + '  ·  ' + TV('category', c.category) + (c.asset_tag ? '  ·  ' + c.asset_tag : '') }),
            el('div', { class: 'card-meta', text: T('claim_lodged') + ' ' + fmtDateTime(c.created_at) }),
          ]),
          statusBadge(c),
        ]),
      ]));
    }
  }

  async function openClaim(id) {
    const data = await api.get('/api/portal/claims/' + id);
    const c = data.claim;

    const body = el('div', {}, [
      el('dl', { class: 'dl' }, [
        el('dt', { text: T('claim_ref') }), el('dd', { text: c.reference }),
        el('dt', { text: T('claim_status') }), el('dd', {}, [statusBadge(c)]),
        el('dt', { text: T('dev_product') }), el('dd', { text: c.device_name || '—' }),
        el('dt', { text: T('claim_category') }), el('dd', { text: TV('category', c.category) }),
        el('dt', { text: T('claim_lodged') }), el('dd', { text: fmtDateTime(c.created_at) }),
        c.manufacturer_ref ? el('dt', { text: T('claim_mfr_ref') }) : null,
        c.manufacturer_ref ? el('dd', { text: c.manufacturer_ref }) : null,
      ]),
      el('div', { class: 'field', style: 'margin-top:20px;' }, [
        el('label', { text: T('claim_description') }),
        el('div', { style: 'white-space:pre-wrap; font-size:13px;', text: c.description }),
      ]),
    ]);

    if (data.attachments.length) {
      const grid = el('div', { class: 'preview-grid' });
      for (const a of data.attachments) {
        grid.appendChild(el('a', { href: '/api/files/' + a.id, target: '_blank', class: 'preview-thumb' }, [
          a.mime_type.startsWith('image/')
            ? el('img', { src: '/api/files/' + a.id, alt: a.original_name })
            : el('div', { class: 'vid-label', text: a.original_name }),
        ]));
      }
      body.appendChild(el('div', { class: 'field' }, [el('label', { text: T('claim_media') }), grid]));
    }

    if (data.events.length) {
      const timeline = el('div', { class: 'timeline' });
      for (const ev of data.events) {
        timeline.appendChild(el('div', { class: 'timeline-item' }, [
          el('div', { text: ev.message }),
          el('div', { class: 'timeline-meta', text: fmtDateTime(ev.created_at) }),
        ]));
      }
      body.appendChild(el('div', { class: 'field' }, [el('label', { text: T('claim_history') }), timeline]));
    }

    modal({ title: c.reference, body });
  }

  /** The fault report form — the machine list is the customer's own devices. */
  function openClaimForm(preselectDeviceId) {
    const usable = state.devices.filter((d) => d.status !== 'decommissioned');
    if (!usable.length) {
      modal({ title: T('claim_new'), body: el('div', { class: 'empty', text: T('claim_no_devices') }) });
      return;
    }

    const c = state.customer;
    const deviceSelect = el('select', { id: 'claim_device_id' }, [
      el('option', { value: '', disabled: 'disabled', selected: 'selected', text: T('claim_device_ph') }),
      ...usable.map((d) => el('option', {
        value: String(d.id),
        selected: String(d.id) === String(preselectDeviceId) ? 'selected' : null,
        text: `${d.product_name} — ${d.asset_tag}${d.location_note ? ' (' + d.location_note + ')' : ''}`,
      })),
    ]);

    const categorySelect = el('select', { id: 'claim_category' }, [
      el('option', { value: '', disabled: 'disabled', selected: 'selected', text: T('claim_category_ph') }),
      ...state.categories.map((cat) => el('option', { value: cat, text: TV('category', cat) })),
    ]);

    const prioritySelect = el('select', { id: 'claim_priority' }, [
      el('option', { value: 'low', text: T('claim_priority_low') }),
      el('option', { value: 'normal', selected: 'selected', text: T('claim_priority_normal') }),
      el('option', { value: 'urgent', text: T('claim_priority_urgent') }),
    ]);

    const picker = filePicker({ accept: 'image/*,video/*', max: 10, labelKey: 'claim_media', hintKey: 'claim_media_hint' });

    const form = el('form', { id: 'claimForm', novalidate: 'novalidate' }, [
      field('device_id', T('claim_device'), deviceSelect, null, true),
      field('category', T('claim_category'), categorySelect, null, true),
      el('div', { class: 'row-2' }, [
        field('priority', T('claim_priority'), prioritySelect),
        field('fault_started_on', T('claim_started'), el('input', {
          type: 'date', id: 'claim_fault_started_on', max: new Date().toISOString().slice(0, 10),
        })),
      ]),
      field('description', T('claim_description'), el('textarea', {
        id: 'claim_description', 'data-i18n-placeholder': 'claim_description_ph', placeholder: T('claim_description_ph'),
      }), null, true),
      el('div', { class: 'section-title', style: 'margin:22px 0 12px;', text: T('claim_contact') }),
      el('div', { class: 'row-2' }, [
        field('contact_name', T('claim_contact_name'), el('input', {
          type: 'text', id: 'claim_contact_name', value: c.site_contact_name || c.contact_name || '',
        }), null, true),
        field('contact_phone', T('claim_contact_phone'), el('input', {
          type: 'tel', id: 'claim_contact_phone', value: c.site_contact_phone || c.phone || '',
        }), null, true),
      ]),
      el('div', { class: 'row-2' }, [
        field('contact_email', T('claim_contact_email'), el('input', {
          type: 'email', id: 'claim_contact_email', value: c.site_contact_email || c.email || '',
        })),
        field('preferred_times', T('claim_times'), el('input', {
          type: 'text', id: 'claim_preferred_times', placeholder: T('claim_times_ph'),
        })),
      ]),
      el('div', { class: 'field' }, [el('label', { text: T('claim_media') }), picker.node]),
    ]);

    const status = el('div', { class: 'status' });
    form.appendChild(status);

    const submitBtn = el('button', { class: 'btn', type: 'submit', form: 'claimForm', text: T('claim_submit') });
    const m = modal({ title: T('claim_new'), body: form, footer: [submitBtn] });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors(form);
      hideStatus(status);
      submitBtn.disabled = true;
      submitBtn.textContent = '…';

      const fd = new FormData();
      fd.append('device_id', $('#claim_device_id', form).value);
      fd.append('category', $('#claim_category', form).value);
      fd.append('priority', $('#claim_priority', form).value);
      fd.append('fault_started_on', $('#claim_fault_started_on', form).value);
      fd.append('description', $('#claim_description', form).value);
      fd.append('contact_name', $('#claim_contact_name', form).value);
      fd.append('contact_phone', $('#claim_contact_phone', form).value);
      fd.append('contact_email', $('#claim_contact_email', form).value);
      fd.append('preferred_times', $('#claim_preferred_times', form).value);
      picker.files.forEach((f) => fd.append('files', f));

      try {
        const res = await api.upload('/api/portal/claims', fd);
        m.close();
        await loadClaims();
        render();
        switchTab('requests');
        const done = modal({
          title: res.reference,
          body: el('div', { class: 'status show ok', text: T('claim_submitted', { ref: res.reference }) }),
        });
        setTimeout(() => done.close(), 9000);
      } catch (err) {
        if (err.fields) {
          // Field ids in this form are prefixed to avoid clashing with the page.
          const mapped = {};
          for (const [k, v] of Object.entries(err.fields)) mapped['claim_' + k] = v;
          if (!showFieldErrors(mapped)) setStatus(status, 'fail', Object.values(err.fields)[0]);
        } else {
          setStatus(status, 'fail', errorMessage(err));
        }
        submitBtn.disabled = false;
        submitBtn.textContent = T('claim_submit');
      }
    });
  }

  // --- Profile -------------------------------------------------------------

  const PROFILE_FIELDS = [
    'company_name', 'contact_name', 'phone', 'address_line1', 'address_line2',
    'suburb', 'state', 'postcode', 'site_contact_name', 'site_contact_role',
    'site_contact_phone', 'site_contact_email',
  ];

  function fillProfileForm() {
    const c = state.customer;
    for (const name of PROFILE_FIELDS) {
      const node = document.getElementById(name);
      if (node) node.value = c[name] || '';
    }
    $('#profileEmail').value = c.email || '';
  }

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = $('#profileSave');
    clearFieldErrors(form);
    hideStatus($('#profileStatus'));
    btn.disabled = true;

    const payload = {};
    for (const name of PROFILE_FIELDS) payload[name] = (document.getElementById(name) || {}).value || '';

    try {
      const res = await api.put('/api/portal/profile', payload);
      state.customer = res.customer;
      setStatus($('#profileStatus'), 'ok', T('profile_saved'));
      $('#companyName').textContent = res.customer.company_name;
    } catch (err) {
      if (!err.fields || !showFieldErrors(err.fields)) setStatus($('#profileStatus'), 'fail', errorMessage(err));
    } finally {
      btn.disabled = false;
    }
  });

  // --- Tabs / chrome -------------------------------------------------------

  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['equipment', 'requests', 'details'].forEach((n) => {
      const panel = document.getElementById('panel-' + n);
      if (panel) panel.hidden = n !== name;
    });
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#reportBtn').addEventListener('click', () => openClaimForm());
  $('#reportBtn2').addEventListener('click', () => openClaimForm());
  $('#addDeviceBtn').addEventListener('click', openAddDevice);
  $('#signOut').addEventListener('click', async () => {
    await api.post('/api/auth/logout', {}).catch(() => {});
    location.href = '/';
  });

  window.App.initLangToggle();
  document.addEventListener('langchange', render);

  boot().catch((err) => {
    console.error(err);
    document.querySelector('.page').prepend(
      el('div', { class: 'status show fail', text: errorMessage(err) })
    );
  });
})();
