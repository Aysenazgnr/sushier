// Click-to-load Google Maps embed (avoids setting third-party
// cookies / loading Maps JS until the visitor actually asks for it)
const mapLoadBtn = document.getElementById('mapLoadBtn');
if (mapLoadBtn) {
  mapLoadBtn.addEventListener('click', () => {
    const iframe = document.createElement('iframe');
    iframe.src = 'https://www.google.com/maps?q=Istanbul%2C+Turkey&output=embed';
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.border = '0';
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.title = 'Sushier location map';
    document.getElementById('footerMap').replaceChildren(iframe);
  });
}

// Sticky header background on scroll
const header = document.getElementById('siteHeader');
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 40);
});

// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const mobileNav = document.getElementById('mobileNav');
function setMobileNavOpen(open) {
  mobileNav.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  mobileNav.setAttribute('aria-hidden', String(!open));
}
navToggle.addEventListener('click', () => {
  setMobileNavOpen(!mobileNav.classList.contains('open'));
});
mobileNav.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => setMobileNavOpen(false));
});

// If GSAP failed to load (CDN blocked/offline) or the user prefers reduced
// motion, skip all animation and make sure content is visible.
const reducedMotion = document.documentElement.classList.contains('reduced-motion');
if (typeof gsap === 'undefined' || reducedMotion) {
  document.querySelectorAll('.reveal').forEach(el => {
    el.style.opacity = '1';
    el.style.transform = 'none';
  });
} else {
  initAnimations();
  initSmoothScroll();
}

function initAnimations() {
// GSAP scroll reveal (hero copy is handled separately by hero-scrub.js,
// in step with the scrub rig rather than a fixed delay)
gsap.registerPlugin(ScrollTrigger);

document.querySelectorAll('.reveal').forEach(el => {
  gsap.to(el, {
    opacity: 1,
    y: 0,
    duration: 1,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: el,
      start: 'top 85%'
    }
  });
});
}

// Single shared clock: Lenis is driven off the GSAP ticker instead of its own
// rAF loop, so every scroll-linked animation (ScrollTrigger, hero-scrub.js)
// reads a consistent scroll position with no double-rAF drift.
function initSmoothScroll() {
  if (typeof Lenis === 'undefined') return;

  const lenis = new Lenis({ lerp: 0.075, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => { lenis.raf(time * 1000); });
  gsap.ticker.lagSmoothing(0);
  window.__lenis = lenis;

  // Route in-page nav anchors through Lenis so header/mobile-nav links keep
  // the same smooth feel as wheel scrolling.
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target);
    });
  });
}
