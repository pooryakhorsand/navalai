// mobile-nav.js
// مدیریت کامل منوی موبایل: دکمه همبرگری، پنل کشویی، overlay، و دراپ‌داون‌های داخل منو

document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.getElementById('hamburger-btn');
  const navLinks = document.getElementById('nav-links');
  const overlay = document.getElementById('nav-overlay');
  const closeBtn = document.getElementById('mobile-nav-close');

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function openMobileNav() {
    navLinks.classList.add('open');
    overlay.classList.add('open');
    hamburger.classList.add('open');
    hamburger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeMobileNav() {
    navLinks.classList.remove('open');
    overlay.classList.remove('open');
    hamburger.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';

    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
    document.querySelectorAll('.dropdown-trigger.active').forEach(t => t.classList.remove('active'));
  }

  window.closeMobileNav = closeMobileNav;

  if (hamburger) {
    hamburger.addEventListener('click', () => {
      const isOpen = navLinks.classList.contains('open');
      if (isOpen) {
        closeMobileNav();
      } else {
        openMobileNav();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closeMobileNav);
  }

  if (overlay) {
    overlay.addEventListener('click', closeMobileNav);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileNav();
  });

  window.addEventListener('resize', () => {
    if (!isMobile()) closeMobileNav();
  });

  document.querySelectorAll('.dropdown-trigger').forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      if (!isMobile()) return;

      e.preventDefault();
      const dropdown = trigger.closest('.dropdown');
      const menu = dropdown?.querySelector('.dropdown-menu');
      if (!menu) return;

      const isOpen = menu.classList.contains('show');

      document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      document.querySelectorAll('.dropdown-trigger.active').forEach(t => t.classList.remove('active'));

      if (!isOpen) {
        menu.classList.add('show');
        trigger.classList.add('active');
      }
    });
  });
});
