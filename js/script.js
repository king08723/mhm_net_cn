document.addEventListener('DOMContentLoaded', () => {
  // 1. Minimal Intersection Observer for Scroll Animations
  // Only observes elements once, then disconnects. High performance.
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        
        // Remove delay classes after animation to fix slow hover response
        // Wait for the entrance animation (0.8s) + max delay (0.5s) to finish
        setTimeout(() => {
          entry.target.classList.remove('delay-100', 'delay-200', 'delay-300', 'delay-400', 'delay-500');
          entry.target.style.transitionDelay = '0s';
        }, 1500);

        obs.unobserve(entry.target); // Stop watching after reveal
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.animate-on-scroll').forEach(el => {
    observer.observe(el);
  });

  // 2. Mobile Menu Toggle
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const mobileMenu = document.getElementById('mobile-menu');

  if (mobileMenuBtn && mobileMenu) {
    // Avoid duplicate binding
    if (mobileMenuBtn.dataset.hasListener) return;
    mobileMenuBtn.dataset.hasListener = 'true';

    // 检测 Font Awesome 是否真正生效；失败则启用文字兜底，避免按钮消失
    const ensureMenuButtonVisible = () => {
      const icon = mobileMenuBtn.querySelector('i');
      if (!icon) {
        mobileMenuBtn.classList.add('fa-missing');
        return;
      }
      const width = icon.getBoundingClientRect().width;
      const family = window.getComputedStyle(icon).fontFamily || '';
      const faOk = width > 4 && /awesome|Font Awesome/i.test(family);
      mobileMenuBtn.classList.toggle('fa-missing', !faOk);
      // 无兜底节点时补一个，兼容旧页面
      if (!faOk && !mobileMenuBtn.querySelector('.menu-btn-fallback')) {
        const span = document.createElement('span');
        span.className = 'menu-btn-fallback';
        span.setAttribute('aria-hidden', 'true');
        span.textContent = '菜单';
        mobileMenuBtn.appendChild(span);
      }
    };

    const syncMenuIcon = () => {
      const closed = mobileMenu.classList.contains('hidden');
      const icon = mobileMenuBtn.querySelector('i');
      if (icon) {
        icon.classList.toggle('fa-xmark', !closed);
        icon.classList.toggle('fa-bars', closed);
      }
      const fallback = mobileMenuBtn.querySelector('.menu-btn-fallback');
      if (fallback) fallback.textContent = closed ? '菜单' : '关闭';
      mobileMenuBtn.setAttribute('aria-expanded', closed ? 'false' : 'true');
      mobileMenuBtn.setAttribute('aria-label', closed ? '打开菜单' : '关闭菜单');
    };

    ensureMenuButtonVisible();
    // 图标字体可能晚于首帧加载，再测一次
    setTimeout(ensureMenuButtonVisible, 400);

    mobileMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mobileMenu.classList.toggle('hidden');
      syncMenuIcon();
    });

    // 点击链接后收起手机菜单
    mobileMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        mobileMenu.classList.add('hidden');
        syncMenuIcon();
      });
    });
  }
});
