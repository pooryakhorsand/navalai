/**
 * nav.js — Dropdown + active route system
 * Handles hover for desktop and click/touch for mobile devices.
 */

document.addEventListener("DOMContentLoaded", () => {
  const dropdown = document.querySelector(".dropdown");
  const menu     = document.querySelector(".dropdown-menu");
  const trigger  = document.querySelector(".dropdown-trigger");

  // =========================
  // TOGGLE DROPDOWN (Click / Touch)
  // =========================
  if (trigger && menu) {
    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = menu.classList.contains("show");

      // بستن تمام حالت‌ها قبل از تغییر وضعیت جدید
      menu.classList.toggle("show", !isOpen);
      trigger.classList.toggle("active", !isOpen);
    });
  }

  // =========================
  // CLOSE ON OUTSIDE CLICK
  // =========================
  document.addEventListener("click", (e) => {
    if (dropdown && dropdown.contains(e.target)) return;
    if (menu) menu.classList.remove("show");
    if (trigger) trigger.classList.remove("active");
  });

  // جلوگیری از بسته شدن منو هنگام کلیک روی لینک‌های داخل آن
  if (menu) {
    menu.addEventListener("click", (e) => e.stopPropagation());
  }

  // حذف کلاس‌های شو هنگام خروج طبیعی ماوس در دسکتاپ
  if (dropdown) {
    dropdown.addEventListener("mouseleave", () => {
      if (menu) menu.classList.remove("show");
      if (trigger) trigger.classList.remove("active");
    });
  }

  // =========================
  // ACTIVE LINK HIGHLIGHTING
  // =========================
  const currentPath = window.location.pathname;

  // هایلایت کردن لینک‌های فعال منوی اصلی و دراپ‌داون بر اساس آدرس مرورگر
  document.querySelectorAll(".dropdown-menu a, .nav-links > a").forEach((link) => {
    const href = link.getAttribute("href");
    if (href && href !== "#" && href !== "" && currentPath.includes(href)) {
      link.classList.add("active");

      // اگر لینک درون دراپ‌داون بود، خودِ تریگر اصلی هم روشن شود
      if (link.closest('.dropdown-menu') && trigger) {
        trigger.classList.add("active");
      }
    }
  });
});