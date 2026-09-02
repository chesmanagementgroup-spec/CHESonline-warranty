(function () {
  'use strict';
  const { api, $, setStatus, hideStatus, errorMessage } = window.App;
  const T = (k, v) => window.I18N.t(k, v);
  let pendingEmail = '';

  // Already signed in? Go straight through.
  api.get('/api/auth/session').then((s) => {
    if (s.customer) location.href = '/portal';
    else if (s.staff) location.href = '/admin';
  }).catch(() => {});

  function showCodeStep(email) {
    pendingEmail = email;
    $('#stepEmail').hidden = true;
    $('#stepCode').hidden = false;
    $('#codeLead').textContent = T('signin_code_lead', { email });
    $('#code').focus();
  }

  async function requestCode(email, statusNode, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '…';
    hideStatus(statusNode);
    try {
      const res = await api.post('/api/auth/request-code', { email });
      showCodeStep(email);
      if (res.dev_code) {
        setStatus($('#codeStatus'), 'info', 'Development mode — your code is ' + res.dev_code);
      }
    } catch (err) {
      if (err.status === 429) setStatus(statusNode, 'fail', T('signin_throttled'));
      else if (err.status === 400) setStatus(statusNode, 'fail', T('signin_unknown'));
      else setStatus(statusNode, 'fail', errorMessage(err));
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  $('#emailForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    if (!email) return;
    requestCode(email, $('#emailStatus'), $('#sendBtn'));
  });

  $('#resendBtn').addEventListener('click', () => {
    if (pendingEmail) requestCode(pendingEmail, $('#codeStatus'), $('#resendBtn'));
  });

  $('#backBtn').addEventListener('click', () => {
    $('#stepCode').hidden = true;
    $('#stepEmail').hidden = false;
    hideStatus($('#codeStatus'));
    hideStatus($('#emailStatus'));
    $('#email').focus();
  });

  $('#code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  $('#codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#verifyBtn');
    button.disabled = true;
    hideStatus($('#codeStatus'));
    try {
      await api.post('/api/auth/verify-code', { email: pendingEmail, code: $('#code').value.trim() });
      location.href = '/portal';
    } catch (err) {
      setStatus($('#codeStatus'), 'fail', err.status === 401 ? T('signin_bad_code') : errorMessage(err));
      button.disabled = false;
    }
  });

  $('#staffForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#staffBtn');
    button.disabled = true;
    hideStatus($('#staffStatus'));
    try {
      await api.post('/api/auth/staff/login', {
        email: $('#staffEmail').value.trim(),
        password: $('#staffPassword').value,
      });
      location.href = '/admin';
    } catch (err) {
      setStatus($('#staffStatus'), 'fail', err.status === 401 ? 'Email or password is incorrect.' : errorMessage(err));
      button.disabled = false;
    }
  });

  window.App.initLangToggle();
  document.addEventListener('langchange', () => {
    if (pendingEmail) $('#codeLead').textContent = T('signin_code_lead', { email: pendingEmail });
  });
})();
