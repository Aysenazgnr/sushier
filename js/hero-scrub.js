// Scroll-scrubbed hero video: scroll position maps to video playback time.
// Scroll down = forward, up = reverse, stop = freeze on that frame. The
// video never plays on its own and has no player chrome — it behaves like a
// single long photograph that scroll moves through.
//
// Isolated from main.js on purpose: a failure here (bad src, GSAP missing)
// must not break the rest of the page's animations, and vice versa.
(function () {
  const section = document.querySelector('.scrub-hero');
  if (!section) return;
  const video = section.querySelector('.hero-video');
  const content = section.querySelector('.hero-content');
  const scrollCue = section.querySelector('.scroll-cue');
  const loadingEl = section.querySelector('.scrub-loading');
  if (!video) return;

  if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
    gsap.registerPlugin(ScrollTrigger);
  }

  const DESKTOP_SRC = 'assets/hero-scrub.mp4';
  const MOBILE_SRC = 'assets/hero-scrub-mobile.mp4';
  const FPS = 24; // matches the ffmpeg -vf fps=24 encode
  const FRAME = 1 / FPS; // seek threshold quantized to one frame, not sub-frame
  const SEEK_LERP = 0.12;
  const DESKTOP_VH = 500;
  const MOBILE_VH = 320;

  const mobileQuery = window.matchMedia('(max-width:768px)');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let duration = 0;
  let current = 0;
  let targetProgress = 0;
  let ready = false;
  let scrollTriggerInstance = null;
  let tickerFn = null;
  let lastIsMobile = mobileQuery.matches;

  function markReady() {
    if (ready) return;
    ready = true;
    if (loadingEl) loadingEl.classList.add('is-ready');
    if (content) {
      content.classList.add('is-visible');
      content.style.opacity = ''; // hand steady-state back to CSS (.is-visible)
    }
  }

  // iOS Safari priming (non-negotiable): a muted <video> that has never had
  // play() called may silently refuse to decode/render programmatic
  // currentTime seeks — it just stays frozen, with no console error. Play it
  // silently once, right after it can, then immediately pause.
  function prime() {
    const p = video.play();
    if (p && typeof p.then === 'function') {
      p.then(() => video.pause()).catch(() => {});
    } else {
      video.pause();
    }
  }

  function armPriming() {
    if (video.readyState >= 1) {
      prime();
    } else {
      video.addEventListener('loadedmetadata', prime, { once: true });
    }
  }

  // "ready" trap: preload="auto" can start fetching the instant the element
  // exists, so a loadeddata/loadedmetadata event may fire before this script
  // attaches its listener. Always check readyState synchronously first.
  function armLoadedData(cb) {
    if (video.readyState >= 2) {
      cb();
    } else {
      video.addEventListener('loadeddata', cb, { once: true });
    }
  }

  function armMetadata(cb) {
    if (video.readyState >= 1 && video.duration) {
      cb();
    } else {
      video.addEventListener('loadedmetadata', cb, { once: true });
    }
  }

  function setHeight(vh) {
    section.style.setProperty('--scrub-h', vh + 'vh');
  }

  function pickSrc() {
    return mobileQuery.matches ? MOBILE_SRC : DESKTOP_SRC;
  }

  function teardownScrollTrigger() {
    if (scrollTriggerInstance) {
      scrollTriggerInstance.kill();
      scrollTriggerInstance = null;
    }
    if (tickerFn) {
      gsap.ticker.remove(tickerFn);
      tickerFn = null;
    }
  }

  // Reduced motion, or GSAP/ScrollTrigger unavailable: skip the scrub rig
  // entirely and show a single static frame. Section collapses to a normal
  // 100vh hero (set in setHeight, not left at the 500vh scrub reach).
  function setupStaticFrame() {
    setHeight(100);
    armPriming();
    armLoadedData(() => {
      try { video.currentTime = 0; } catch (e) {}
      markReady();
    });
  }

  function setupScrub() {
    setHeight(mobileQuery.matches ? MOBILE_VH : DESKTOP_VH);
    armPriming();
    armMetadata(() => { duration = video.duration || 0; });
    armLoadedData(markReady);

    scrollTriggerInstance = ScrollTrigger.create({
      trigger: section,
      start: 'top top',
      end: 'bottom bottom',
      invalidateOnRefresh: true,
      onUpdate(self) {
        // Cheap, non-seeking writes only — the actual video seek happens in
        // a separate gsap.ticker loop below, never here.
        targetProgress = self.progress;

        if (scrollCue) {
          scrollCue.style.opacity = self.progress > 0.04 ? '0' : '1';
        }

        if (content) {
          const p = self.progress;
          if (p > 0.85) {
            // Last ~15%: let the copy go gently as the section hands off to
            // whatever comes next.
            const fade = Math.max(0, 1 - (p - 0.85) / 0.15);
            content.style.opacity = ready ? String(fade) : '0';
          } else {
            content.style.opacity = ''; // defer to CSS (.is-visible => 1 / 0)
          }
        }
      }
    });

    tickerFn = function () {
      if (!duration || video.seeking) return;
      const maxTime = Math.max(0, duration - FRAME);
      const target = Math.min(targetProgress * duration, maxTime);
      current += (target - current) * SEEK_LERP;
      if (!video.paused) video.pause();
      if (Math.abs(video.currentTime - current) > FRAME) {
        video.currentTime = current;
      }
    };
    gsap.ticker.add(tickerFn);
  }

  function init() {
    teardownScrollTrigger();

    video.src = pickSrc();
    video.load();
    current = 0;
    targetProgress = 0;
    duration = 0;
    ready = false;
    if (loadingEl) loadingEl.classList.remove('is-ready');
    if (content) {
      content.classList.remove('is-visible');
      content.style.opacity = '';
    }

    const canScrub = !reducedMotionQuery.matches &&
      typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined';

    if (canScrub) {
      setupScrub();
    } else {
      setupStaticFrame();
    }

    if (typeof ScrollTrigger !== 'undefined') ScrollTrigger.refresh();
  }

  function handleResize() {
    const nowMobile = mobileQuery.matches;
    if (nowMobile !== lastIsMobile) {
      lastIsMobile = nowMobile;
      init(); // breakpoint crossed: swap source, rebuild the rig
    } else if (typeof ScrollTrigger !== 'undefined') {
      ScrollTrigger.refresh();
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResize, 200);
  });

  if (reducedMotionQuery.addEventListener) {
    reducedMotionQuery.addEventListener('change', init);
  } else if (reducedMotionQuery.addListener) {
    reducedMotionQuery.addListener(init); // Safari <14 fallback
  }

  try {
    init();
  } catch (err) {
    // Last-resort safety net: a bug here must never leave the hero blank.
    teardownScrollTrigger();
    if (content) { content.style.opacity = '1'; content.style.transform = 'none'; }
    if (loadingEl) loadingEl.classList.add('is-ready');
    section.style.setProperty('--scrub-h', '100vh');
  }
})();
