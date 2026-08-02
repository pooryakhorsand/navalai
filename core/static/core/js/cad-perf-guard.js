/**
 * cad-perf-guard.js
 *
 * وظیفه: وقتی هیرو (باکس CAD) از دید کاربر خارج می‌شه — مثلاً موقع
 * اسکرول به سمت بالا که نوار sticky دوباره وارد صفحه می‌شه — رندر
 * لوپ‌های three.js رو موقتاً متوقف می‌کنه تا فشار روی GPU/compositor
 * کم بشه و لگ از بین بره.
 *
 * نکته مهم: این فایل باید قبل از فایل‌های CAD (yacht_cad.js, b_cad.js,
 * cylinder_code.js, holtrop_cad.js, turning_cad.js) لود بشه، چون
 * window.requestAnimationFrame رو wrap می‌کنه و باید wrap شده باشه
 * قبل از این که اون فایل‌ها اولین requestAnimationFrame خودشون رو صدا بزنن.
 */
(function () {
  'use strict';

  window.__cadPaused = false;

  // --- Wrap کردن requestAnimationFrame به صورت global ---
  // هر کدی که در ادامه (یاختی/پروانه/سیلندر/هولتروپ/ترنینگ) صدا بزنه
  // window.requestAnimationFrame(loop)، از این نسخه‌ی patch‌شده استفاده می‌کنه.
  const nativeRAF = window.requestAnimationFrame.bind(window);

  window.requestAnimationFrame = function (callback) {
    return nativeRAF(function (time) {
      if (window.__cadPaused) {
        // فریم رو کامل skip می‌کنیم، ولی خود لوپ رو دوباره زمان‌بندی
        // می‌کنیم تا وقتی paused تموم شد، بدون نیاز به ری‌استارت دستی
        // خودش ادامه بده.
        window.requestAnimationFrame(callback);
        return;
      }
      callback(time);
    });
  };

  // --- IntersectionObserver: تشخیص دید/عدم دید باکس CAD ---
  function initObserver() {
    const heroBox = document.getElementById('cad-master-box');
    if (!heroBox) {
      // اگه هنوز DOM آماده نیست، یه بار دیگه تو فریم بعدی امتحان کن
      nativeRAF(initObserver);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          window.__cadPaused = !entry.isIntersecting;
        });
      },
      {
        root: null,
        threshold: 0, // حتی ۱ پیکسل از باکس هم دیده بشه کافیه که فعال بمونه
        // حاشیه امن تا توقف/شروع لحظه‌ای و سرهم (flicker) پیش نیاد
        rootMargin: '100px 0px 100px 0px',
      }
    );

    observer.observe(heroBox);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
})();