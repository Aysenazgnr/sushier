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
}

function initAnimations() {
// GSAP scroll reveal
gsap.registerPlugin(ScrollTrigger);

gsap.to('.hero-content', {
  opacity: 1, y: 0, duration: 1.2, delay: 0.3, ease: 'power2.out'
});

gsap.to('.hero-bg', {
  scale: 1, duration: 2.5, ease: 'power2.out'
});

document.querySelectorAll('.reveal:not(.hero-content)').forEach(el => {
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

// Subtle parallax on hero background
gsap.to('.hero-bg', {
  yPercent: 15,
  ease: 'none',
  scrollTrigger: {
    trigger: '.hero',
    start: 'top top',
    end: 'bottom top',
    scrub: true
  }
});
}
