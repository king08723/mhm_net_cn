/**
 * 联系页：校验 + 组装 mailto 正文（无后端）
 */
(function () {
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(() => {
    const form = document.getElementById('site-contact-form');
    if (!form) return;

    const statusEl = document.getElementById('form-status');
    const submitBtn = document.getElementById('btn-contact-submit');

    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.classList.remove('is-error', 'is-ok');
      if (kind) statusEl.classList.add(kind);
    }

    function validPhone(v) {
      return /^1\d{10}$/.test(String(v || '').trim()) || /^[\d+\-\s()]{6,20}$/.test(String(v || '').trim());
    }

    function validEmail(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = (document.getElementById('name') || {}).value || '';
      const phone = (document.getElementById('phone') || {}).value || '';
      const type = (document.getElementById('type') || {}).value || '';
      const budget = (document.getElementById('budget') || {}).value || '';
      const email = (document.getElementById('email') || {}).value || '';
      const message = (document.getElementById('message') || {}).value || '';

      if (!name.trim()) { setStatus('请填写姓名', 'is-error'); return; }
      if (!validPhone(phone)) { setStatus('请填写有效手机号', 'is-error'); return; }
      if (!validEmail(email)) { setStatus('请填写有效邮箱', 'is-error'); return; }

      let to = (form.getAttribute('data-mailto') || '').trim();
      if (!to && /^mailto:/i.test(form.action || '')) {
        to = form.action.replace(/^mailto:/i, '').split('?')[0].trim();
      }
      if (!to || to === '#') {
        setStatus('邮箱尚未就绪，请稍后刷新重试，或直接使用页面上的联系方式', 'is-error');
        return;
      }

      const body = [
        `姓名：${name.trim()}`,
        `电话：${phone.trim()}`,
        `邮箱：${email.trim()}`,
        `需求类型：${type}`,
        `预算范围：${budget}`,
        '',
        '留言：',
        message.trim() || '（无）',
      ].join('\n');

      const subject = encodeURIComponent(`[网站咨询] ${type || '合作咨询'} - ${name.trim()}`);
      const href = `mailto:${to}?subject=${subject}&body=${encodeURIComponent(body)}`;

      if (submitBtn) {
        submitBtn.setAttribute('aria-busy', 'true');
        submitBtn.disabled = true;
      }
      setStatus('将打开邮件客户端发送，请确认收件人与正文…', 'is-ok');

      window.location.href = href;

      setTimeout(() => {
        if (submitBtn) {
          submitBtn.setAttribute('aria-busy', 'false');
          submitBtn.disabled = false;
        }
      }, 1200);
    });
  });
})();
