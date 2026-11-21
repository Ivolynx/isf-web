/**
 * ISF Public Pages — main.js
 * Handles: sticky header, mobile nav toggle, accordion FAQ,
 *          scroll-reveal, global theme toggle.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Global Theme Toggle — single key shared with dashboard/portal
  // ---------------------------------------------------------------------------
  var THEME_KEY = 'isf-theme';

  function getStoredTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch(e) { return null; }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) {}
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // Apply immediately (anti-flash script in <head> already ran, this is a safety net)
  var stored = getStoredTheme();
  if (!stored) {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
    } else {
      applyTheme('light');
    }
  }

  // Wire theme toggle buttons
  // NOTE: main.js is loaded with `defer`, so DOM is already ready when this runs.
  // We wire up immediately, not via DOMContentLoaded (which has already fired).
  function wireToggles() {
    var toggles = document.querySelectorAll('.theme-toggle, [data-theme-toggle]');
    toggles.forEach(function (btn) {
      btn.addEventListener('click', toggleTheme);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireToggles);
  } else {
    wireToggles();
  }

  // Cross-tab sync
  try {
    window.addEventListener('storage', function (e) {
      if (e.key === THEME_KEY && (e.newValue === 'dark' || e.newValue === 'light')) {
        document.documentElement.setAttribute('data-theme', e.newValue);
      }
    });
  } catch(e) {}

  // ---------------------------------------------------------------------------
  // Sticky header
  // ---------------------------------------------------------------------------
  var header = document.querySelector('[data-header]');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---------------------------------------------------------------------------
  // Mobile nav toggle — supports multiple nav IDs (site-nav, blog-nav, camp-nav)
  // ---------------------------------------------------------------------------
  var navToggle = document.querySelector('[data-nav-toggle]');
  var siteNav = document.getElementById('site-nav') ||
                document.getElementById('blog-nav') ||
                document.getElementById('camp-nav');
  var navOverlay = document.getElementById('nav-overlay');

  function openNav() {
    if (!navToggle || !siteNav) return;
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Tutup menu');
    siteNav.classList.add('is-open');
    // Dropdown nav — no body scroll-lock needed
  }

  function closeNav() {
    if (!navToggle || !siteNav) return;
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Buka menu');
    siteNav.classList.remove('is-open');
  }

  if (navToggle && siteNav) {
    navToggle.addEventListener('click', function () {
      var expanded = navToggle.getAttribute('aria-expanded') === 'true';
      expanded ? closeNav() : openNav();
    });

    // Close when clicking a nav link
    siteNav.addEventListener('click', function (e) {
      if (e.target.closest('a')) { closeNav(); }
    });

    // Close dropdown when clicking outside header/nav area
    document.addEventListener('click', function (e) {
      if (!siteNav.classList.contains('is-open')) return;
      var header = document.querySelector('[data-header]');
      if (header && !header.contains(e.target)) { closeNav(); }
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && siteNav.classList.contains('is-open')) {
        closeNav();
        navToggle.focus();
      }
    });

    // Trap focus inside nav when open
    siteNav.addEventListener('keydown', function (e) {
      if (!siteNav.classList.contains('is-open')) return;
      var focusable = siteNav.querySelectorAll('a, button');
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); navToggle.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); navToggle.focus();
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Accordion (FAQ)
  // ---------------------------------------------------------------------------
  var accordion = document.querySelector('[data-accordion]');
  if (accordion) {
    accordion.addEventListener('click', function (e) {
      var trigger = e.target.closest('.accordion__trigger');
      if (!trigger) return;

      var expanded = trigger.getAttribute('aria-expanded') === 'true';
      var panelId = trigger.getAttribute('aria-controls');
      var panel = panelId ? document.getElementById(panelId) : null;

      // Close all other panels first
      accordion.querySelectorAll('.accordion__trigger').forEach(function (t) {
        var pid = t.getAttribute('aria-controls');
        var p = pid ? document.getElementById(pid) : null;
        t.setAttribute('aria-expanded', 'false');
        if (p) p.hidden = true;
      });

      // Toggle the clicked one
      if (!expanded) {
        trigger.setAttribute('aria-expanded', 'true');
        if (panel) panel.hidden = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Scroll-reveal (IntersectionObserver)
  // ---------------------------------------------------------------------------
  var revealEls = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && revealEls.length > 0) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -60px 0px', threshold: 0.1 }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('is-visible'); });
  }
})();
