/**
 * 联系方式解码写入页脚/表单（轻度混淆，非安全加密）
 */
(function () {
  const p = 'MTgwMjg3MzE2NjQ=';
  const w = 'Y2FpcWluZ2NvbmcxOA==';
  const e1 = 'eGlvMTAwODZAaWNsb3VkLmNvbQ==';
  const e2 = 'a2lucDY1OTBAZ21haWwuY29t';

  function d(s) {
    try { return atob(s); } catch (_) { return ''; }
  }

  function setContent(id, val) {
    document.querySelectorAll('#' + id).forEach((el) => { el.textContent = val; });
  }

  function setLink(cls, val) {
    document.querySelectorAll('.' + cls).forEach((el) => {
      if (el.tagName === 'FORM') {
        el.setAttribute('data-mailto', val);
        el.action = 'mailto:' + val;
      } else {
        el.href = 'mailto:' + val;
      }
    });
  }

  function apply() {
    setContent('contact-phone', d(p));
    setContent('contact-wechat', d(w));
    setContent('contact-email-main', d(e1));
    setContent('contact-email-gmail', d(e2));
    setLink('email-link-main', d(e1));
    setLink('email-link-gmail', d(e2));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
