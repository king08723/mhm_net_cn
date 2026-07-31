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

    mobileMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mobileMenu.classList.toggle('hidden');
      
      const icon = mobileMenuBtn.querySelector('i');
      if (icon) {
        if (mobileMenu.classList.contains('hidden')) {
          icon.classList.remove('fa-xmark');
          icon.classList.add('fa-bars');
        } else {
          icon.classList.remove('fa-bars');
          icon.classList.add('fa-xmark');
        }
      }
    });

    // Close mobile menu when a link is clicked
    mobileMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        mobileMenu.classList.add('hidden');
        const icon = mobileMenuBtn.querySelector('i');
        if (icon) {
          icon.classList.remove('fa-xmark');
          icon.classList.add('fa-bars');
        }
      });
    });
  }
});
