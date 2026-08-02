document.addEventListener('DOMContentLoaded', () => {
  // 滚动入场动效（一次性观察）
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        setTimeout(() => {
          entry.target.classList.remove('delay-100', 'delay-200', 'delay-300', 'delay-400', 'delay-500');
          entry.target.style.transitionDelay = '0s';
        }, 1500);
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.animate-on-scroll').forEach((el) => {
    observer.observe(el);
  });

  // 案例图加载失败时用站内抽象封面，避免破图
  document.querySelectorAll('img[src^="images/portfolio-"]').forEach((img) => {
    img.addEventListener('error', () => {
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = '1';
      const div = document.createElement('div');
      div.className = 'case-cover';
      const span = document.createElement('span');
      span.textContent = img.alt || '案例';
      div.appendChild(span);
      img.replaceWith(div);
    });
  });

  // 手机菜单（页眉已内联 SVG 开关图标）
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const mobileMenu = document.getElementById('mobile-menu');

  if (mobileMenuBtn && mobileMenu) {
    if (mobileMenuBtn.dataset.hasListener) return;
    mobileMenuBtn.dataset.hasListener = 'true';

    const iconOpen = mobileMenuBtn.querySelector('.menu-icon-open');
    const iconClose = mobileMenuBtn.querySelector('.menu-icon-close');

    const syncMenuIcon = () => {
      const closed = mobileMenu.classList.contains('hidden');
      if (iconOpen && iconClose) {
        iconOpen.classList.toggle('hidden', !closed);
        iconClose.classList.toggle('hidden', closed);
      }
      mobileMenuBtn.setAttribute('aria-expanded', closed ? 'false' : 'true');
      mobileMenuBtn.setAttribute('aria-label', closed ? '打开菜单' : '关闭菜单');
    };

    mobileMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mobileMenu.classList.toggle('hidden');
      syncMenuIcon();
    });

    mobileMenu.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        mobileMenu.classList.add('hidden');
        syncMenuIcon();
      });
    });

    syncMenuIcon();
  }
});
