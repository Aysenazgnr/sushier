// Sticky header background on scroll
const header = document.getElementById('siteHeader');
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 40);
});

// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const mobileNav = document.getElementById('mobileNav');
navToggle.addEventListener('click', () => {
  mobileNav.classList.toggle('open');
});
mobileNav.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => mobileNav.classList.remove('open'));
});

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
