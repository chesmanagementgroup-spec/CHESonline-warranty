/* CHES staff console: invoice import, customers, equipment, service requests. */
(function () {
  'use strict';

  const {
    api, $, $$, el, clear, fmtDate, fmtDateTime, fmtMoney, setStatus, hideStatus,
    clearFieldErrors, showFieldErrors, errorMessage, warrantyBadge, modal,
  } = window.App;
  const T = (k, v) => window.I18N.t(k, v);
  const TV = (kind, value) => window.I18N.tv(kind, value);

  const state = { meta: null, stats: null, customers: [], draft: null };

  // --- Boot ----------------------------------------------------------------

  async function boot() {
    let session;
    try {
      session = await api.get('/api/auth/session');
    } catch (err) { location.href = '/'; return; }
    if (!session.staff) { location.href = '/'; return; }

    $('#staffName').textContent = session.staff.name;
    state.meta = await api.get('/api/admin/meta');
    await Promise.all([loadStats(), loadCustomers()]);
    routeFromHash();
  }

  async function loadStats() {
    state.stats = await api.get('/api/admin/stats');
    renderStats();
    if (!state.stats.smtp_configured) {
      setStatus($('#smtpWarning'), 'info', T('a_smtp_warning'));
    } else {
      hideStatus($('#smtpWarning'));
    }
  }

  async function loadCustomers(q) {
    const data = await api.get('/api/admin/customers?q=' + encodeURIComponent(q || ''));
    state.customers = data.customers;
    return data.customers;
  }

  async function refreshMeta() {
    state.meta = await api.get('/api/admin/meta');
  }

  // --- Dashboard -----------------------------------------------------------

  function renderStats() {
    const s = state.stats;
    const grid = $('#statGrid');
    clear(grid);
    const tiles = [
      [s.claims_new, T('a_stat_new'), s.claims_new > 0],
      [s.claims_open, T('a_stat_open'), false],
      [s.devices, T('a_stat_devices'), false],
      [s.devices_in_warranty, T('a_stat_inwarranty'), false],
      [s.devices_expiring_60d, T('a_stat_expiring'), s.devices_expiring_60d > 0],
      [s.customers, T('a_stat_customers'), false],
    ];
    for (const [num, label, alert] of tiles) {
      grid.appendChild(el('div', { class: 'stat' + (alert ? ' alert' : '') }, [
        el('div', { class: 'stat-num', text: String(num) }),
        el('div', { class: 'stat-label', text: label }),
      ]));
    }

    const body = $('#expiringBody');
    clear(body);
    if (!s.expiring_soon.length) {
      body.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    body.appendChild(table(
      [T('dev_asset'), T('dev_product'), T('a_tab_customers'), T('dev_warranty_until')],
      s.expiring_soon.map((d) => ({
        cells: [d.asset_tag, d.product_name, d.customer_name || '', fmtDate(d.warranty_end)],
        onClick: () => openDevice(d.id),
      }))
    ));
  }

  /** Build a table from headings and rows. */
  function table(headings, rows) {
    const thead = el('thead', {}, [el('tr', {}, headings.map((h) => el('th', {}, [
      typeof h === 'string' ? document.createTextNode(h) : h,
    ])))]);
    const tbody = el('tbody', {}, rows.map((r) => {
      if (r.span) {
        return el('tr', { class: 'row-detail' }, [
          el('td', { colspan: String(headings.length) }, [r.cells]),
        ]);
      }
      return el('tr', {
        class: r.onClick ? 'clickable' : null,
        onclick: r.onClick || null,
      }, r.cells.map((c) => el('td', { class: c && c.num ? 'num' : null },
        [typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : (c && c.node) || c || '']
      )));
    }));
    return el('div', { class: 'table-wrap' }, [el('table', {}, [thead, tbody])]);
  }

  function fieldRow(id, label, input, hint, required) {
    return el('div', { class: 'field' }, [
      el('label', { for: id }, [
        el('span', { text: label }),
        required ? el('span', { class: 'req', text: ' *' }) : null,
      ]),
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);
  }

  // --- Invoice import ------------------------------------------------------

  $('#invoiceFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = $('#invoiceStatus');
    setStatus(status, 'info', T('a_inv_reading'));
    clear($('#invoiceDraft'));

    const fd = new FormData();
    fd.append('file', file);
    try {
      const draft = await api.upload('/api/admin/invoices/upload', fd);
      state.draft = draft;
      hideStatus(status);
      renderDraft(draft);
      if (draft.warning === 'no_lines_found') setStatus(status, 'fail', T('a_inv_nolines'));
    } catch (err) {
      setStatus(status, 'fail', errorMessage(err));
    } finally {
      e.target.value = '';
    }
  });

  /**
   * The parsed invoice, laid out for correction. Nothing is created until
   * "Create equipment records" is pressed.
   */
  function renderDraft(draft) {
    const host = $('#invoiceDraft');
    clear(host);

    const customerSelect = el('select', { id: 'draft_customer_id' }, [
      el('option', { value: '', disabled: 'disabled', selected: !draft.suggested_customer ? 'selected' : null, text: T('a_inv_pick') }),
      ...state.customers.map((c) => el('option', {
        value: String(c.id),
        selected: draft.suggested_customer && draft.suggested_customer.id === c.id ? 'selected' : null,
        text: `${c.company_name} — ${c.email}`,
      })),
    ]);

    // Every physical machine gets its own row and its own serial box. Two of
    // the same model are two records with two warranties, so a fault on one
    // must never be able to look like a fault on the other — and that only
    // works if the serials are entered per machine, not as one shared field.
    const rows = [];

    draft.lines.forEach((line, i) => {
      const include = el('input', { type: 'checkbox', id: 'line_include_' + i, checked: line.include ? 'checked' : null });
      const desc = el('input', { type: 'text', id: 'line_desc_' + i, value: line.description, style: 'min-width:300px;' });
      const qty = el('input', { type: 'number', id: 'line_qty_' + i, value: String(line.quantity), min: '1', max: '200', style: 'width:64px;' });
      const brand = el('input', { type: 'text', id: 'line_brand_' + i, value: line.brand || '', style: 'min-width:104px;' });
      const model = el('input', { type: 'text', id: 'line_model_' + i, value: line.model_code || '', style: 'min-width:104px;' });
      const months = el('input', {
        type: 'number', id: 'line_months_' + i, min: '0', max: '240', style: 'width:74px;',
        value: String(line.warranty_months || state.meta.default_warranty_months),
      });

      rows.push({
        cells: [
          { node: include },
          { node: desc },
          { node: qty },
          { node: brand },
          { node: model },
          { node: months },
          fmtMoney(line.unit_price_ex_gst),
        ],
      });

      // One serial row per machine, rebuilt whenever the quantity changes.
      const unitHost = el('div', { id: 'line_units_' + i, style: 'display:grid; gap:5px;' });

      function renderUnits() {
        const count = Math.max(1, Math.min(200, Number(qty.value) || 1));
        const existing = Array.from(unitHost.querySelectorAll('input')).map((n) => n.value);
        const parsed = line.serial_numbers || [];
        clear(unitHost);
        for (let u = 0; u < count; u++) {
          unitHost.appendChild(el('div', { style: 'display:flex; align-items:center; gap:8px;' }, [
            el('span', {
              style: 'font-size:12px; color:var(--text-2); min-width:96px;',
              text: T('a_inv_unit', { n: u + 1, total: count }),
            }),
            el('input', {
              type: 'text', id: `line_serial_${i}_${u}`,
              value: existing[u] !== undefined ? existing[u] : (parsed[u] || ''),
              placeholder: T('a_inv_serial_each'),
              style: 'flex:1; min-width:160px;',
            }),
          ]));
        }
      }
      renderUnits();
      qty.addEventListener('input', renderUnits);

      rows.push({
        span: true,
        cells: el('div', {}, [
          el('div', { style: 'font-size:12px; font-weight:600; margin-bottom:6px;', text: T('a_inv_units') }),
          unitHost,
        ]),
      });
    });

    // A rent-try-buy invoice is billed to the finance company, but the venue
    // named on it is who actually ends up with the machines.
    const venue = draft.customer_details;
    let venuePanel = null;
    if (venue && (venue.company_name || venue.email)) {
      const matched = draft.suggested_customer;
      const createBtn = el('button', { class: 'btn btn-sm', type: 'button', text: T('a_inv_venue_create') });
      venuePanel = el('div', { class: 'section', style: 'margin-bottom:12px;' }, [
        el('div', { class: 'section-header' }, [
          el('div', { class: 'section-num', text: '@' }),
          el('div', { class: 'section-title', text: T('a_inv_venue') }),
        ]),
        el('div', { class: 'section-body' }, [
          el('p', { class: 'section-note', text: T('a_inv_venue_lead') }),
          el('dl', { class: 'dl' }, [
            el('dt', { text: T('profile_company') }), el('dd', { text: venue.company_name || '—' }),
            el('dt', { text: T('profile_contact') }), el('dd', { text: venue.contact_name || '—' }),
            el('dt', { text: T('profile_phone') }), el('dd', { text: venue.phone || '—' }),
            el('dt', { text: T('profile_email') }), el('dd', { text: venue.email || '—' }),
            el('dt', { text: T('profile_address') }), el('dd', { text: venue.address || '—' }),
            draft.reference ? el('dt', { text: T('a_inv_reference') }) : null,
            draft.reference ? el('dd', { text: draft.reference }) : null,
          ]),
          matched
            ? el('div', { class: 'status show ok', text: T('a_inv_venue_matched') })
            : el('div', { class: 'btn-row', style: 'margin-top:14px;' }, [createBtn]),
        ]),
      ]);

      createBtn.addEventListener('click', () => {
        openNewCustomer({
          company_name: venue.company_name,
          contact_name: venue.contact_name,
          email: venue.email,
          phone: venue.phone,
          address_line1: venue.address_line1 || venue.address,
          suburb: venue.suburb,
          state: venue.state,
          postcode: venue.postcode,
          site_contact_name: venue.contact_name,
          site_contact_phone: venue.phone,
          site_contact_email: venue.email,
          site_name: venue.suburb || venue.company_name,
        }, (created) => {
          customerSelect.appendChild(el('option', { value: String(created.id), text: `${created.company_name} — ${created.email}` }));
          customerSelect.value = String(created.id);
          refreshSites(created.id);
          createBtn.replaceWith(el('span', { class: 'badge badge-ok', text: T('a_inv_venue_matched') }));
        });
      });
    }

    // Which venue the machines land at, and the date cover starts.
    const siteSelect = el('select', { id: 'draft_site_id' }, [
      el('option', { value: '', text: T('a_inv_pick') }),
      ...(draft.sites || []).map((st) => el('option', { value: String(st.id), text: st.name })),
    ]);
    const deliveryInput = el('input', {
      type: 'date', id: 'draft_delivery_date',
      value: draft.delivery_date || draft.invoice_date || '',
    });

    async function refreshSites(customerId) {
      clear(siteSelect);
      siteSelect.appendChild(el('option', { value: '', text: T('a_inv_pick') }));
      if (!customerId) return;
      const data = await api.get('/api/admin/customers/' + customerId + '/sites').catch(() => ({ sites: [] }));
      for (const st of data.sites || []) {
        siteSelect.appendChild(el('option', { value: String(st.id), text: st.name }));
      }
      if (siteSelect.options.length === 2) siteSelect.selectedIndex = 1;
    }
    customerSelect.addEventListener('change', () => refreshSites(customerSelect.value));
    if (draft.suggested_customer) refreshSites(draft.suggested_customer.id);

    const sendInvite = el('input', { type: 'checkbox', id: 'draft_invite', checked: 'checked' });
    const commitBtn = el('button', { class: 'btn', type: 'button', text: T('a_inv_commit') });
    const status = el('div', { class: 'status' });

    if (venuePanel) host.appendChild(venuePanel);

    host.appendChild(el('div', { class: 'section' }, [
      el('div', { class: 'section-header' }, [
        el('div', { class: 'section-num', text: '✓' }),
        el('div', { class: 'section-title', text: T('a_inv_lines') }),
        el('div', { class: 'spacer' }),
        el('a', {
          class: 'btn btn-ghost btn-sm', href: '/api/admin/invoices/' + draft.import_id + '/text',
          target: '_blank', text: T('a_inv_rawtext'),
        }),
      ]),
      el('div', { class: 'section-body' }, [
        el('div', { class: 'row-3' }, [
          fieldRow('draft_customer_id', T('a_inv_customer'), customerSelect,
            draft.detected_customer ? T('a_inv_detected') + ': ' + draft.detected_customer : null, true),
          fieldRow('draft_invoice_number', T('a_inv_number'),
            el('input', { type: 'text', id: 'draft_invoice_number', value: draft.invoice_number || '' })),
          fieldRow('draft_invoice_date', T('a_inv_date'),
            el('input', { type: 'date', id: 'draft_invoice_date', value: draft.invoice_date || '' })),
        ]),
        el('div', { class: 'row-2' }, [
          fieldRow('draft_site_id', T('a_inv_site'), siteSelect),
          fieldRow('draft_delivery_date', T('a_inv_delivery'), deliveryInput, T('a_inv_delivery_hint')),
        ]),
        rows.length
          ? table(
            [T('a_inv_include'), T('a_inv_desc'), T('a_inv_qty'), T('a_inv_brand'), T('a_inv_model'), T('a_inv_warranty'), T('a_inv_price')],
            rows
          )
          : el('div', { class: 'empty', text: T('a_inv_nolines') }),
        el('div', { class: 'hint', style: 'margin-top:10px;', text: T('a_inv_serial_hint') }),
        el('div', { class: 'check-row', style: 'margin-top:16px;' }, [sendInvite, el('span', { text: T('a_inv_invite') })]),
        el('div', { class: 'btn-row', style: 'margin-top:16px;' }, [commitBtn]),
        status,
      ]),
    ]));

    commitBtn.addEventListener('click', async () => {
      const customerId = customerSelect.value;
      if (!customerId) {
        setStatus(status, 'fail', T('a_inv_customer'));
        return;
      }
      commitBtn.disabled = true;
      const lines = draft.lines.map((line, i) => {
        const quantity = Number($('#line_qty_' + i).value) || 1;
        const serials = [];
        for (let u = 0; u < quantity; u++) {
          const box = $(`#line_serial_${i}_${u}`);
          serials.push(box ? box.value.trim() : '');
        }
        return {
          ...line,
          include: $('#line_include_' + i).checked,
          description: $('#line_desc_' + i).value,
          quantity,
          brand: $('#line_brand_' + i).value,
          model_code: $('#line_model_' + i).value,
          // Positional: serial 1 goes to machine 1. A blank stays blank rather
          // than shifting the next machine's serial onto this one.
          serial_numbers: serials,
          warranty_months: Number($('#line_months_' + i).value),
        };
      });

      try {
        const res = await api.post('/api/admin/invoices/' + draft.import_id + '/commit', {
          customer_id: Number(customerId),
          site_id: siteSelect.value ? Number(siteSelect.value) : null,
          invoice_number: $('#draft_invoice_number').value,
          invoice_date: $('#draft_invoice_date').value,
          delivery_date: deliveryInput.value,
          lines,
          send_invite: sendInvite.checked,
        });
        const customer = state.customers.find((c) => String(c.id) === String(customerId));
        setStatus(status, 'ok', T('a_inv_done', {
          n: res.devices_created,
          customer: customer ? customer.company_name : '',
        }));
        commitBtn.remove();
        await Promise.all([loadStats(), loadInvoiceHistory()]);
      } catch (err) {
        setStatus(status, 'fail', err.fields ? Object.values(err.fields)[0] : errorMessage(err));
        commitBtn.disabled = false;
      }
    });
  }

  async function loadInvoiceHistory() {
    const host = $('#invoiceHistory');
    clear(host);
    const data = await api.get('/api/admin/invoices');
    if (!data.imports.length) {
      host.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    host.appendChild(table(
      [T('a_inv_number'), T('a_tab_customers'), T('a_inv_date'), T('a_stat_devices'), T('claim_status'), T('claim_lodged')],
      data.imports.map((i) => ({
        cells: [
          i.invoice_number || i.original_name,
          i.customer_name || i.detected_customer || '—',
          fmtDate(i.invoice_date),
          { num: true, node: document.createTextNode(String(i.devices_created)) },
          { node: el('span', { class: 'badge' + (i.status === 'committed' ? ' badge-ok' : ''), text: i.status }) },
          fmtDateTime(i.created_at),
        ],
      }))
    ));
  }

  // --- Service requests ----------------------------------------------------

  async function loadClaims() {
    const host = $('#claimTable');
    const q = $('#claimSearch').value;
    const status = $('#claimFilter').value;
    const data = await api.get(`/api/admin/claims?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
    clear(host);
    if (!data.claims.length) {
      host.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    host.appendChild(table(
      [T('claim_ref'), T('a_tab_customers'), T('dev_product'), T('claim_category'), T('claim_status'), T('claim_lodged')],
      data.claims.map((c) => ({
        cells: [
          { node: el('strong', { text: c.reference }) },
          c.customer_name,
          (c.device_name || '—') + (c.asset_tag ? '  ·  ' + c.asset_tag : ''),
          TV('category', c.category),
          {
            node: el('span', {
              class: 'badge' + (c.status === 'submitted' ? ' badge-dark' : c.priority === 'urgent' && c.status !== 'closed' ? ' badge-bad' : ''),
              text: TV('status', c.status),
            }),
          },
          fmtDateTime(c.created_at),
        ],
        onClick: () => openClaim(c.id),
      }))
    ));
  }

  async function openClaim(id) {
    const data = await api.get('/api/admin/claims/' + id);
    const c = data.claim;
    const d = data.device;
    const cust = data.customer;

    const statusSelect = el('select', { id: 'claim_status_sel' }, state.meta.claim_statuses.map((s) => el('option', {
      value: s, selected: s === c.status ? 'selected' : null, text: TV('status', s),
    })));
    const mfrSelect = el('select', { id: 'claim_mfr_sel' }, [
      el('option', { value: '', text: '—' }),
      ...state.meta.manufacturers.map((m) => el('option', {
        value: String(m.id), selected: c.manufacturer_id === m.id ? 'selected' : null, text: m.name,
      })),
    ]);
    const mfrRef = el('input', { type: 'text', id: 'claim_mfr_ref', value: c.manufacturer_ref || '' });
    const internal = el('textarea', { id: 'claim_internal', style: 'min-height:80px;', text: c.internal_notes || '' });
    const notify = el('input', { type: 'checkbox', id: 'claim_notify' });
    const status = el('div', { class: 'status' });

    const body = el('div', {}, [
      el('dl', { class: 'dl' }, [
        el('dt', { text: T('claim_status') }), el('dd', {}, [
          el('span', { class: 'badge', text: TV('status', c.status) }),
          el('span', { text: '  ' }),
          el('span', { class: 'badge' + (c.priority === 'urgent' ? ' badge-bad' : ''), text: TV('priority', c.priority) }),
          el('span', { text: '  ' }),
          el('span', { class: 'badge' + (c.under_warranty ? ' badge-ok' : ' badge-bad'), text: c.under_warranty ? T('dev_warranty_active') : T('dev_warranty_expired') }),
        ]),
        el('dt', { text: T('a_tab_customers') }), el('dd', { text: `${cust.company_name} · ${cust.email} · ${cust.phone || '—'}` }),
        el('dt', { text: T('claim_contact') }), el('dd', { text: `${c.contact_name || '—'} · ${c.contact_phone || '—'} · ${c.contact_email || '—'}` }),
        el('dt', { text: T('profile_address') }), el('dd', { text: c.site_address || '—' }),
        el('dt', { text: T('claim_times') }), el('dd', { text: c.preferred_times || '—' }),
        el('dt', { text: T('dev_product') }), el('dd', { text: d ? `${d.product_name} · ${d.asset_tag}` : '—' }),
        el('dt', { text: T('dev_serial') }), el('dd', { text: (d && d.serial_number) || '—' }),
        el('dt', { text: T('dev_warranty_until') }), el('dd', { text: d ? fmtDate(d.warranty_end) : '—' }),
        el('dt', { text: T('claim_category') }), el('dd', { text: TV('category', c.category) }),
      ]),
      el('div', { class: 'field', style: 'margin-top:18px;' }, [
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

    body.appendChild(el('div', { class: 'row-3', style: 'margin-top:20px;' }, [
      fieldRow('claim_status_sel', T('claim_status'), statusSelect),
      fieldRow('claim_mfr_sel', T('a_tab_manufacturers'), mfrSelect),
      fieldRow('claim_mfr_ref', T('a_mfr_ref'), mfrRef),
    ]));
    body.appendChild(fieldRow('claim_internal', T('a_internal_notes'), internal));
    body.appendChild(el('div', { class: 'check-row' }, [notify, el('span', { text: T('a_notify_customer') })]));
    body.appendChild(status);

    if (data.events.length) {
      const timeline = el('div', { class: 'timeline' });
      for (const ev of data.events) {
        timeline.appendChild(el('div', { class: 'timeline-item' }, [
          el('div', { text: ev.message }),
          el('div', { class: 'timeline-meta', text: `${fmtDateTime(ev.created_at)} · ${ev.actor_label || ev.actor_type}${ev.visible_to_customer ? '' : ' · internal'}` }),
        ]));
      }
      body.appendChild(el('div', { class: 'field', style: 'margin-top:20px;' }, [
        el('label', { text: T('claim_history') }), timeline,
      ]));
    }

    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('a_status_update') });
    const forwardBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: T('a_forward') });
    const m = modal({ title: c.reference, body, footer: [forwardBtn, saveBtn], wide: true });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await api.put('/api/admin/claims/' + id, {
          status: statusSelect.value,
          manufacturer_id: mfrSelect.value ? Number(mfrSelect.value) : null,
          manufacturer_ref: mfrRef.value,
          internal_notes: internal.value,
          notify_customer: notify.checked,
        });
        setStatus(status, 'ok', T('a_saved'));
        await Promise.all([loadStats(), loadClaims()]);
      } catch (err) {
        setStatus(status, 'fail', errorMessage(err));
      } finally {
        saveBtn.disabled = false;
      }
    });

    forwardBtn.addEventListener('click', () => {
      m.close();
      openForward(id, mfrSelect.value);
    });
  }

  /** Preview and send the manufacturer email. */
  async function openForward(claimId, manufacturerId) {
    const url = '/api/admin/claims/' + claimId + '/forward'
      + (manufacturerId ? '?manufacturer_id=' + encodeURIComponent(manufacturerId) : '');
    const draft = await api.get(url);

    const to = el('input', { type: 'email', id: 'fwd_to', value: draft.to || '' });
    const cc = el('input', { type: 'email', id: 'fwd_cc', value: draft.cc || '' });
    const subject = el('input', { type: 'text', id: 'fwd_subject', value: draft.subject });
    const bodyInput = el('textarea', { id: 'fwd_body', style: 'min-height:320px; font-family:ui-monospace,Menlo,monospace; font-size:12px;', text: draft.body });
    const notify = el('input', { type: 'checkbox', id: 'fwd_notify', checked: 'checked' });
    const status = el('div', { class: 'status' });

    const body = el('div', {}, [
      el('p', { class: 'section-note', text: T('a_forward_lead') }),
      draft.portal_url
        ? el('div', { class: 'status show info' }, [
          el('span', { text: T('a_forward_portal') + ': ' }),
          el('a', { href: draft.portal_url, target: '_blank', rel: 'noopener', text: draft.portal_url }),
        ])
        : null,
      draft.warranty_notes || draft.supplier_notes
        ? el('div', { class: 'panel', style: 'margin-bottom:14px;' }, [
          el('div', { style: 'font-weight:500; margin-bottom:5px;', text: T('a_forward_conditions') }),
          draft.warranty_notes ? el('div', { style: 'font-size:13px; color:var(--text-2);', text: draft.warranty_notes }) : null,
          draft.supplier_notes ? el('div', { style: 'font-size:13px; color:var(--text-2); margin-top:5px;', text: draft.supplier_notes }) : null,
        ])
        : null,
      el('div', { class: 'row-2' }, [
        fieldRow('fwd_to', T('a_forward_to'), to, draft.to ? null : T('a_forward_noemail'), true),
        fieldRow('fwd_cc', T('a_forward_cc'), cc),
      ]),
      fieldRow('fwd_subject', T('a_forward_subject'), subject),
      fieldRow('fwd_body', T('a_forward_body'), bodyInput),
      el('div', { class: 'check-row' }, [notify, el('span', { text: T('a_notify_customer') })]),
      (draft.checklist || []).length
        ? el('details', { style: 'margin-top:14px;' }, [
          el('summary', { style: 'cursor:pointer; font-size:13px; color:var(--text-2);', text: T('a_forward_checklist') }),
          el('ul', { style: 'margin:8px 0 0 18px; font-size:13px; color:var(--text-2);' },
            draft.checklist.map((item) => el('li', { text: item, style: 'margin-bottom:3px;' }))),
        ])
        : null,
      status,
    ]);

    const sendBtn = el('button', { class: 'btn', type: 'button', text: T('a_forward_send') });
    const m = modal({ title: T('a_forward'), body, footer: [sendBtn], wide: true });

    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      try {
        const res = await api.post('/api/admin/claims/' + claimId + '/forward', {
          to: to.value,
          cc: cc.value,
          subject: subject.value,
          body: bodyInput.value,
          manufacturer_id: manufacturerId ? Number(manufacturerId) : null,
          notify_customer: notify.checked,
        });
        if (res.ok) {
          setStatus(status, 'ok', T('a_forward_sent', { to: to.value })
            + (res.status === 'logged' ? ' (' + T('a_smtp_warning') + ')' : ''));
          await Promise.all([loadStats(), loadClaims()]);
          setTimeout(() => m.close(), 2500);
        } else {
          setStatus(status, 'fail', res.error || errorMessage({}));
          sendBtn.disabled = false;
        }
      } catch (err) {
        setStatus(status, 'fail', err.fields ? Object.values(err.fields)[0] : errorMessage(err));
        sendBtn.disabled = false;
      }
    });
  }

  // --- Customers -----------------------------------------------------------

  async function renderCustomers() {
    const host = $('#customerTable');
    const list = await loadCustomers($('#customerSearch').value);
    clear(host);
    if (!list.length) {
      host.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    host.appendChild(table(
      [T('profile_company'), T('profile_contact'), T('profile_phone'), T('a_stat_devices'), T('a_stat_sites'), T('a_stat_open')],
      list.map((c) => ({
        cells: [
          { node: el('strong', { text: c.company_name }) },
          `${c.contact_name || '—'}  ·  ${c.email}`,
          c.phone || '—',
          { num: true, node: document.createTextNode(String(c.device_count)) },
          { num: true, node: document.createTextNode(String(c.site_count || 0)) },
          { num: true, node: document.createTextNode(String(c.open_claims)) },
        ],
        onClick: () => openCustomer(c.id),
      }))
    ));
  }

  const CUSTOMER_FIELDS = [
    ['company_name', 'profile_company', true],
    ['contact_name', 'profile_contact', false],
    ['email', 'profile_email', true],
    ['phone', 'profile_phone', false],
    ['address_line1', 'profile_addr1', false],
    ['address_line2', 'profile_addr2', false],
    ['suburb', 'profile_suburb', false],
    ['state', 'profile_state', false],
    ['postcode', 'profile_postcode', false],
    ['site_contact_name', 'profile_site_name', false],
    ['site_contact_role', 'profile_site_role', false],
    ['site_contact_phone', 'profile_site_phone', false],
    ['site_contact_email', 'profile_site_email', false],
  ];

  function customerForm(existing) {
    const form = el('form', { id: 'customerForm', novalidate: 'novalidate' });
    for (const [name, key, required] of CUSTOMER_FIELDS) {
      form.appendChild(fieldRow(name, T(key), el('input', {
        type: name.includes('email') ? 'email' : 'text',
        id: name,
        value: (existing && existing[name]) || '',
      }), null, required));
    }
    form.appendChild(fieldRow('notes', T('dev_notes'), el('textarea', {
      id: 'notes', style: 'min-height:70px;', text: (existing && existing.notes) || '',
    })));
    return form;
  }

  function readCustomerForm(form) {
    const payload = {};
    for (const [name] of CUSTOMER_FIELDS) payload[name] = $('#' + name, form).value;
    payload.notes = $('#notes', form).value;
    return payload;
  }

  function openNewCustomer(prefill, onCreated) {
    const form = customerForm(prefill || null);
    const status = el('div', { class: 'status' });
    form.appendChild(status);
    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('save') });
    const m = modal({ title: T('a_new_customer'), body: form, footer: [saveBtn] });

    saveBtn.addEventListener('click', async () => {
      clearFieldErrors(form);
      saveBtn.disabled = true;
      try {
        const res = await api.post('/api/admin/customers', readCustomerForm(form));
        m.close();
        await Promise.all([renderCustomers(), loadStats()]);
        if (onCreated) onCreated(res.customer);
      } catch (err) {
        if (!err.fields || !showFieldErrors(err.fields)) setStatus(status, 'fail', errorMessage(err));
        saveBtn.disabled = false;
      }
    });
  }

  async function openCustomer(id) {
    const data = await api.get('/api/admin/customers/' + id);
    const form = customerForm(data.customer);
    const status = el('div', { class: 'status' });

    const body = el('div', {}, [form, status]);

    const addSiteBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: T('a_site_add') });
    body.appendChild(el('div', { class: 'field', style: 'margin-top:22px;' }, [
      el('label', { text: T('a_tab_sites') }),
      (data.sites || []).length
        ? table(
          [T('site_name'), T('profile_address'), T('site_contact'), T('a_stat_devices')],
          data.sites.map((st) => ({
            cells: [
              st.name,
              [st.address_line1, st.suburb, st.state, st.postcode].filter(Boolean).join(', ') || '—',
              [st.contact_name, st.contact_phone].filter(Boolean).join('  ·  ') || '—',
              { num: true, node: document.createTextNode(String(st.device_count || 0)) },
            ],
            onClick: () => openSite(st, () => openCustomer(id)),
          }))
        )
        : el('div', { class: 'empty', text: T('site_none') }),
      el('div', { class: 'btn-row', style: 'margin-top:10px;' }, [addSiteBtn]),
    ]));
    addSiteBtn.addEventListener('click', () => openSite({ customer_id: id }, () => openCustomer(id)));

    if (data.devices.length) {
      body.appendChild(el('div', { class: 'field', style: 'margin-top:22px;' }, [
        el('label', { text: T('a_tab_devices') }),
        table(
          [T('dev_asset'), T('dev_product'), T('site_one'), T('dev_serial'), T('dev_delivered'), T('dev_warranty')],
          data.devices.map((d) => ({
            cells: [
              d.asset_tag, d.product_name, d.site_name || '—', d.serial_number || '—', fmtDate(d.delivered_at),
              { node: warrantyBadge(d) },
            ],
            onClick: () => openDevice(d.id),
          }))
        ),
      ]));
    }

    if (data.claims.length) {
      body.appendChild(el('div', { class: 'field', style: 'margin-top:22px;' }, [
        el('label', { text: T('a_tab_claims') }),
        table(
          [T('claim_ref'), T('dev_product'), T('claim_status'), T('claim_lodged')],
          data.claims.map((c) => ({
            cells: [c.reference, c.device_name || '—', TV('status', c.status), fmtDateTime(c.created_at)],
            onClick: () => openClaim(c.id),
          }))
        ),
      ]));
    }

    const inviteBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: T('a_invite') });
    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('save') });
    modal({ title: data.customer.company_name, body, footer: [inviteBtn, saveBtn], wide: true });

    saveBtn.addEventListener('click', async () => {
      clearFieldErrors(form);
      saveBtn.disabled = true;
      try {
        await api.put('/api/admin/customers/' + id, readCustomerForm(form));
        setStatus(status, 'ok', T('a_saved'));
        await renderCustomers();
      } catch (err) {
        if (!err.fields || !showFieldErrors(err.fields)) setStatus(status, 'fail', errorMessage(err));
      } finally {
        saveBtn.disabled = false;
      }
    });

    inviteBtn.addEventListener('click', async () => {
      inviteBtn.disabled = true;
      try {
        const res = await api.post('/api/admin/customers/' + id + '/invite', {});
        setStatus(status, 'ok', T('a_saved') + ' (' + res.status + ')');
      } catch (err) {
        setStatus(status, 'fail', errorMessage(err));
      } finally {
        inviteBtn.disabled = false;
      }
    });
  }

  // --- Sites ------------------------------------------------------------------

  const SITE_FIELDS = [
    ['name', 'site_name', true],
    ['address_line1', 'profile_addr1', false],
    ['address_line2', 'profile_addr2', false],
    ['suburb', 'profile_suburb', false],
    ['state', 'profile_state', false],
    ['postcode', 'profile_postcode', false],
    ['contact_name', 'profile_site_name', false],
    ['contact_role', 'profile_site_role', false],
    ['contact_phone', 'profile_site_phone', false],
    ['contact_email', 'profile_site_email', false],
  ];

  function openSite(site, onSaved) {
    const form = el('form', { id: 'siteForm', novalidate: 'novalidate' });
    for (const [name, key, required] of SITE_FIELDS) {
      form.appendChild(fieldRow('asite_' + name, T(key), el('input', {
        type: name === 'contact_email' ? 'email' : 'text',
        id: 'asite_' + name, value: site[name] || '',
      }), null, required));
    }
    const status = el('div', { class: 'status' });
    form.appendChild(status);

    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('save') });
    const m = modal({ title: site.id ? site.name : T('a_site_add'), body: form, footer: [saveBtn] });

    saveBtn.addEventListener('click', async () => {
      clearFieldErrors(form);
      saveBtn.disabled = true;
      const payload = {};
      for (const [name] of SITE_FIELDS) payload[name] = $('#asite_' + name, form).value;
      try {
        if (site.id) await api.put('/api/admin/sites/' + site.id, payload);
        else await api.post('/api/admin/customers/' + site.customer_id + '/sites', payload);
        m.close();
        if (onSaved) onSaved();
      } catch (err) {
        if (!err.fields || !showFieldErrors(err.fields)) setStatus(status, 'fail', errorMessage(err));
        saveBtn.disabled = false;
      }
    });
  }

  // --- Equipment -----------------------------------------------------------

  async function renderDevices() {
    const host = $('#deviceTable');
    const data = await api.get('/api/admin/devices?q=' + encodeURIComponent($('#deviceSearch').value));
    clear(host);
    if (!data.devices.length) {
      host.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    host.appendChild(table(
      [T('dev_asset'), T('dev_product'), T('a_tab_customers'), T('site_one'), T('dev_serial'), T('dev_invoice'), T('dev_delivered'), T('dev_warranty')],
      data.devices.map((d) => ({
        cells: [
          d.asset_tag,
          d.product_name + (d.model_code ? '  ·  ' + d.model_code : ''),
          d.customer_name,
          d.site_name || '—',
          d.serial_number || '—',
          d.invoice_number || '—',
          fmtDate(d.delivered_at),
          { node: warrantyBadge(d) },
        ],
        onClick: () => openDevice(d.id),
      }))
    ));
  }

  const DEVICE_FIELDS = [
    ['product_name', 'dev_product', 'text', true],
    ['brand', 'dev_brand', 'text', false],
    ['model_code', 'dev_model', 'text', false],
    ['serial_number', 'dev_serial', 'text', false],
    ['invoice_number', 'dev_invoice', 'text', false],
    ['purchase_date', 'dev_purchased', 'date', false],
    ['delivered_at', 'dev_delivered', 'date', false],
    ['warranty_months', 'a_inv_warranty', 'number', false],
    ['location_note', 'dev_location', 'text', false],
    ['unit_price_ex_gst', 'a_inv_price', 'text', false],
  ];

  function deviceForm(existing) {
    const form = el('form', { id: 'deviceForm', novalidate: 'novalidate' });

    const customerSelect = el('select', { id: 'device_customer_id' }, [
      el('option', { value: '', disabled: 'disabled', selected: existing ? null : 'selected', text: T('a_inv_pick') }),
      ...state.customers.map((c) => el('option', {
        value: String(c.id),
        selected: existing && existing.customer_id === c.id ? 'selected' : null,
        text: c.company_name,
      })),
    ]);
    form.appendChild(fieldRow('device_customer_id', T('a_tab_customers'), customerSelect, null, true));

    for (const [name, key, type, required] of DEVICE_FIELDS) {
      let value = existing ? existing[name] : '';
      if (name === 'warranty_months' && !existing) value = state.meta.default_warranty_months;
      form.appendChild(fieldRow('dev_' + name, T(key), el('input', {
        type, id: 'dev_' + name, value: value === null || value === undefined ? '' : String(value),
      }), null, required));
    }

    if (existing) {
      form.appendChild(fieldRow('dev_status', T('claim_status'), el('select', { id: 'dev_status' },
        state.meta.device_statuses.map((s) => el('option', {
          value: s, selected: s === existing.status ? 'selected' : null, text: TV('device_status', s),
        }))
      )));
    }

    form.appendChild(fieldRow('dev_notes', T('dev_notes'), el('textarea', {
      id: 'dev_notes', style: 'min-height:70px;', text: (existing && existing.notes) || '',
    })));
    return form;
  }

  function readDeviceForm(form) {
    const payload = { customer_id: Number($('#device_customer_id', form).value) || null };
    for (const [name] of DEVICE_FIELDS) payload[name] = $('#dev_' + name, form).value;
    const statusNode = $('#dev_status', form);
    if (statusNode) payload.status = statusNode.value;
    payload.notes = $('#dev_notes', form).value;
    return payload;
  }

  function openNewDevice() {
    const form = deviceForm(null);
    const status = el('div', { class: 'status' });
    form.appendChild(status);
    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('save') });
    const m = modal({ title: T('a_new_device'), body: form, footer: [saveBtn] });

    saveBtn.addEventListener('click', async () => {
      clearFieldErrors(form);
      saveBtn.disabled = true;
      try {
        await api.post('/api/admin/devices', readDeviceForm(form));
        m.close();
        await Promise.all([renderDevices(), loadStats()]);
      } catch (err) {
        if (!err.fields || !showFieldErrors(err.fields)) setStatus(status, 'fail', errorMessage(err));
        saveBtn.disabled = false;
      }
    });
  }

  async function openDevice(id) {
    const data = await api.get('/api/admin/devices/' + id);
    const form = deviceForm(data.device);
    const status = el('div', { class: 'status' });
    const body = el('div', {}, [
      el('div', { class: 'card static' }, [
        el('div', { class: 'card-meta', text: `${T('dev_asset')}: ${data.device.asset_tag}` }),
        el('div', { class: 'card-meta' }, [
          warrantyBadge(data.device),
          el('span', { text: data.device.warranty_end ? '  ' + T('dev_warranty_until') + ' ' + fmtDate(data.device.warranty_end) : '' }),
        ]),
      ]),
      form,
      status,
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
      body.appendChild(el('div', { class: 'field' }, [el('label', { text: T('dev_photos') }), grid]));
    }

    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('save') });
    modal({ title: data.device.product_name, body, footer: [saveBtn], wide: true });

    saveBtn.addEventListener('click', async () => {
      clearFieldErrors(form);
      saveBtn.disabled = true;
      try {
        await api.put('/api/admin/devices/' + id, readDeviceForm(form));
        setStatus(status, 'ok', T('a_saved'));
        await Promise.all([renderDevices(), loadStats()]);
      } catch (err) {
        if (!err.fields || !showFieldErrors(err.fields)) setStatus(status, 'fail', errorMessage(err));
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // --- Manufacturers -------------------------------------------------------

  async function renderManufacturers() {
    const host = $('#manufacturerTable');
    const data = await api.get('/api/admin/manufacturers');
    clear(host);
    if (!data.manufacturers.length) {
      host.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    host.appendChild(table(
      [T('a_tab_manufacturers'), T('a_forward_to'), T('a_mfr_months'), T('a_mfr_aliases'), T('profile_phone'), T('a_stat_devices')],
      data.manufacturers.map((m) => ({
        cells: [
          { node: el('strong', { text: m.name }) },
          m.service_email || '—',
          m.default_warranty_months ? String(m.default_warranty_months) : 'by model',
          (m.aliases || '—').slice(0, 60),
          m.phone || '—',
          { num: true, node: document.createTextNode(String(m.device_count)) },
        ],
        onClick: () => openManufacturer(m),
      }))
    ));
  }

  function openManufacturer(existing) {
    const form = el('form', { id: 'mfrForm', novalidate: 'novalidate' }, [
      fieldRow('mfr_name', T('a_tab_manufacturers'), el('input', { type: 'text', id: 'mfr_name', value: (existing && existing.name) || '' }), null, true),
      fieldRow('mfr_service_email', T('a_forward_to'), el('input', { type: 'email', id: 'mfr_service_email', value: (existing && existing.service_email) || '' })),
      fieldRow('mfr_cc_email', T('a_mfr_cc'), el('input', { type: 'email', id: 'mfr_cc_email', value: (existing && existing.cc_email) || '' })),
      fieldRow('mfr_aliases', T('a_mfr_aliases'), el('input', {
        type: 'text', id: 'mfr_aliases', value: (existing && existing.aliases) || '',
      }), T('a_mfr_aliases_hint')),
      fieldRow('mfr_default_warranty_months', T('a_mfr_months'), el('input', {
        type: 'number', id: 'mfr_default_warranty_months', min: '0', max: '240',
        value: existing && existing.default_warranty_months ? String(existing.default_warranty_months) : '',
      }), T('a_mfr_months_hint')),
      fieldRow('mfr_warranty_notes', T('a_mfr_warranty_notes'), el('textarea', {
        id: 'mfr_warranty_notes', style: 'min-height:70px;', text: (existing && existing.warranty_notes) || '',
      })),
      fieldRow('mfr_portal_url', T('a_forward_portal'), el('input', { type: 'text', id: 'mfr_portal_url', value: (existing && existing.portal_url) || '' })),
      fieldRow('mfr_phone', T('profile_phone'), el('input', { type: 'text', id: 'mfr_phone', value: (existing && existing.phone) || '' })),
      fieldRow('mfr_notes', T('dev_notes'), el('textarea', { id: 'mfr_notes', style: 'min-height:70px;', text: (existing && existing.notes) || '' })),
    ]);
    const status = el('div', { class: 'status' });
    form.appendChild(status);

    const saveBtn = el('button', { class: 'btn', type: 'button', text: T('save') });
    const m = modal({ title: existing ? existing.name : T('a_new_manufacturer'), body: form, footer: [saveBtn] });

    saveBtn.addEventListener('click', async () => {
      clearFieldErrors(form);
      saveBtn.disabled = true;
      const payload = {
        name: $('#mfr_name', form).value,
        service_email: $('#mfr_service_email', form).value,
        cc_email: $('#mfr_cc_email', form).value,
        aliases: $('#mfr_aliases', form).value,
        default_warranty_months: $('#mfr_default_warranty_months', form).value,
        warranty_notes: $('#mfr_warranty_notes', form).value,
        portal_url: $('#mfr_portal_url', form).value,
        phone: $('#mfr_phone', form).value,
        notes: $('#mfr_notes', form).value,
      };
      try {
        if (existing) await api.put('/api/admin/manufacturers/' + existing.id, payload);
        else await api.post('/api/admin/manufacturers', payload);
        m.close();
        await Promise.all([renderManufacturers(), refreshMeta()]);
      } catch (err) {
        if (!err.fields || !showFieldErrors(err.fields)) setStatus(status, 'fail', errorMessage(err));
        saveBtn.disabled = false;
      }
    });
  }

  // --- Email log -----------------------------------------------------------

  async function renderEmails() {
    const host = $('#emailTable');
    const data = await api.get('/api/admin/emails');
    clear(host);
    if (!data.emails.length) {
      host.appendChild(el('div', { class: 'empty', text: T('a_no_results') }));
      return;
    }
    host.appendChild(table(
      [T('claim_lodged'), T('a_forward_to'), T('a_forward_subject'), T('claim_status')],
      data.emails.map((e) => ({
        cells: [
          fmtDateTime(e.created_at),
          e.to_addr,
          e.subject,
          {
            node: el('span', {
              class: 'badge' + (e.status === 'sent' ? ' badge-ok' : e.status === 'failed' ? ' badge-bad' : ''),
              text: e.status,
            }),
          },
        ],
        onClick: async () => {
          const full = await api.get('/api/admin/emails/' + e.id);
          modal({
            title: full.email.subject,
            wide: true,
            body: el('div', {}, [
              el('dl', { class: 'dl' }, [
                el('dt', { text: T('a_forward_to') }), el('dd', { text: full.email.to_addr }),
                el('dt', { text: T('claim_status') }), el('dd', { text: full.email.status + (full.email.error ? ' — ' + full.email.error : '') }),
                el('dt', { text: T('claim_lodged') }), el('dd', { text: fmtDateTime(full.email.created_at) }),
              ]),
              el('pre', { class: 'mail-preview', text: full.email.body }),
            ]),
          });
        },
      }))
    ));
  }

  // --- Tabs ----------------------------------------------------------------

  const LOADERS = {
    dashboard: loadStats,
    invoices: loadInvoiceHistory,
    claims: loadClaims,
    customers: renderCustomers,
    devices: renderDevices,
    manufacturers: renderManufacturers,
    emails: renderEmails,
  };

  function switchTab(name) {
    if (!LOADERS[name]) name = 'dashboard';
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    Object.keys(LOADERS).forEach((n) => {
      const panel = document.getElementById('panel-' + n);
      if (panel) panel.hidden = n !== name;
    });
    LOADERS[name]().catch((err) => console.error(err));
  }

  function routeFromHash() {
    const hash = location.hash.replace('#', '');
    const claimMatch = hash.match(/^claim-(\d+)$/);
    if (claimMatch) {
      switchTab('claims');
      openClaim(Number(claimMatch[1])).catch(() => {});
      return;
    }
    switchTab(hash || 'dashboard');
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    location.hash = t.dataset.tab;
    switchTab(t.dataset.tab);
  }));

  let searchTimer;
  const debounce = (fn) => { clearTimeout(searchTimer); searchTimer = setTimeout(fn, 250); };
  $('#claimSearch').addEventListener('input', () => debounce(loadClaims));
  $('#claimFilter').addEventListener('change', loadClaims);
  $('#customerSearch').addEventListener('input', () => debounce(renderCustomers));
  $('#deviceSearch').addEventListener('input', () => debounce(renderDevices));
  $('#newCustomerBtn').addEventListener('click', () => openNewCustomer());
  $('#newDeviceBtn').addEventListener('click', openNewDevice);
  $('#newManufacturerBtn').addEventListener('click', () => openManufacturer(null));
  $('#signOut').addEventListener('click', async () => {
    await api.post('/api/auth/staff/logout', {}).catch(() => {});
    location.href = '/';
  });

  window.App.initLangToggle();
  document.addEventListener('langchange', () => {
    const active = $$('.tab').find((t) => t.classList.contains('active'));
    switchTab(active ? active.dataset.tab : 'dashboard');
  });

  boot().catch((err) => {
    console.error(err);
    document.querySelector('.page').prepend(el('div', { class: 'status show fail', text: errorMessage(err) }));
  });
})();
