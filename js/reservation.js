// Reservation form: date -> fetch availability -> pick a time slot -> submit.
//
// Follows js/main.js's conventions (flat top-level code, defer, no IIFE) --
// unlike js/hero-scrub.js, this isn't a self-contained risky rig, it's a
// regular page feature like the nav or the map loader. It gets its own
// file only because the logic is too long for main.js.
const bookingForm = document.getElementById('bookingForm');

if (bookingForm) {
  const bookingFallback = document.getElementById('bookingFallback');
  const dateInput = document.getElementById('bkDate');
  const partySelect = document.getElementById('bkParty');
  const slotsField = document.getElementById('bkSlotsField');
  const slotsEl = document.getElementById('bkSlots');
  const slotInput = document.getElementById('bkSlot');
  const nameInput = document.getElementById('bkName');
  const phoneInput = document.getElementById('bkPhone');
  const emailInput = document.getElementById('bkEmail');
  const notesInput = document.getElementById('bkNotes');
  const companyInput = document.getElementById('bkCompany');
  const submitBtn = document.getElementById('bkSubmit');
  const statusEl = document.getElementById('bkStatus');
  const successEl = document.getElementById('bkSuccess');
  const successTitle = document.getElementById('bkSuccessTitle');
  const refEl = document.getElementById('bkRef');
  const recapEl = document.getElementById('bkRecap');

  const MIN_DWELL_MS = 2500;
  const MAX_ADVANCE_DAYS = 30;

  const ERROR_COPY = {
    party_size_out_of_range: 'Please choose a party size between 1 and 6. For larger groups, call us directly.',
    invalid_slot: 'That time is no longer valid. Please pick another.',
    invalid_date: 'Please choose a valid date.',
    date_closed: 'We are closed on that date. Please choose another.',
    too_far_ahead: 'Please choose a date within the next 30 days.',
    slot_in_past: 'That time is too soon. Please choose a later time.',
    slot_full: 'That time just filled up. Please choose another.',
    rate_limited: 'Too many requests from this connection. Please try again later, or call us.',
    invalid_name: 'Please enter your name.',
    invalid_phone: 'Please enter a valid phone number.',
    invalid_email: 'Please enter a valid email address.',
    invalid_notes: 'Your note is too long.',
    network: "We couldn't reach the reservation system. Please check your connection and try again, or call us.",
    server_error: 'Something went wrong on our end. Please try again, or call us.'
  };

  const formShownAt = Date.now();
  let availabilityController = null;
  let selectedSlotMinute = null;

  // Lenis is only present when GSAP loaded and reduced-motion is off (see
  // js/main.js). Both this and ScrollTrigger must degrade to plain DOM
  // behavior, never assume either is defined.
  function scrollToEl(el) {
    if (window.__lenis) {
      window.__lenis.scrollTo(el, { offset: -80 });
    } else {
      el.scrollIntoView({ block: 'center' });
    }
  }

  function refreshScrollTrigger() {
    if (typeof ScrollTrigger !== 'undefined') ScrollTrigger.refresh();
  }

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('error', kind === 'error');
  }

  function istanbulToday() {
    // Intl gives us the Istanbul wall-clock date without needing to know
    // the visitor's own timezone or offset math.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const lookup = {};
    parts.forEach((p) => { lookup[p.type] = p.value; });
    return lookup.year + '-' + lookup.month + '-' + lookup.day;
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function initDateBounds() {
    const today = istanbulToday();
    dateInput.min = today;
    dateInput.max = addDays(today, MAX_ADVANCE_DAYS);
  }

  function renderSlotsMessage(text) {
    const p = document.createElement('p');
    p.className = 'slots-message';
    p.textContent = text;
    slotsEl.replaceChildren(p);
  }

  function clearSelectedSlot() {
    selectedSlotMinute = null;
    slotInput.value = '';
  }

  function renderSlots(slots) {
    clearSelectedSlot();

    if (!slots.length) {
      renderSlotsMessage('No times available on this date.');
      return;
    }

    const pills = slots.map((slot) => {
      // Always a <button>, never <a href="#...">: js/main.js's Lenis setup
      // binds every a[href^="#"] at page load and would otherwise hijack
      // this click into a scroll-to-top. type="button" is required too --
      // a bare <button> inside a <form> defaults to submit.
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'slot';
      pill.textContent = slot.time;
      pill.setAttribute('aria-pressed', 'false');
      if (!slot.bookable) {
        pill.disabled = true;
        pill.setAttribute('aria-label', slot.time + ', fully booked');
      } else {
        pill.setAttribute('aria-label', slot.time + ', ' + slot.remaining + ' tables left');
        // Bound here, per-pill, at creation time -- matching the
        // no-delegation convention in js/main.js. Deliberately not given
        // class="reveal": that class is only ever animated into view for
        // elements main.js's one-time querySelectorAll('.reveal') saw at
        // load, so anything injected later with that class would stay
        // invisible forever.
        pill.addEventListener('click', () => {
          slotsEl.querySelectorAll('.slot').forEach((el) => el.setAttribute('aria-pressed', 'false'));
          pill.setAttribute('aria-pressed', 'true');
          selectedSlotMinute = slot.slotMinute;
          slotInput.value = String(slot.slotMinute);
        });
      }
      return pill;
    });

    slotsEl.replaceChildren(...pills);
  }

  function loadAvailability(dateStr) {
    if (availabilityController) availabilityController.abort();
    availabilityController = new AbortController();

    clearSelectedSlot();
    renderSlotsMessage('Checking availability…');
    setStatus('');

    fetch('/api/availability?date=' + encodeURIComponent(dateStr), { signal: availabilityController.signal })
      .then((response) => response.json().then((body) => ({ status: response.status, body })))
      .then(({ status, body }) => {
        if (status !== 200 || !body.ok) {
          renderSlotsMessage("We couldn't load times just now.");
          return;
        }
        if (body.closed) {
          const reasons = {
            weekly: "We're closed on that day of the week.",
            holiday: "We're closed on that date.",
            past: 'Please choose a future date.',
            too_far: 'Please choose a date within the next 30 days.'
          };
          renderSlotsMessage(reasons[body.reason] || "We're closed on that date.");
          return;
        }
        if (!body.slots.some((s) => s.bookable)) {
          renderSlotsMessage('Fully booked on this date. Try another evening.');
          return;
        }
        renderSlots(body.slots);
        refreshScrollTrigger();
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        renderSlotsMessage("We couldn't load times just now.");
      });
  }

  function showForm() {
    if (bookingFallback) bookingFallback.hidden = true;
    bookingForm.hidden = false;
  }

  function handleSubmit(event) {
    event.preventDefault();
    setStatus('');

    if (!selectedSlotMinute) {
      setStatus('Please choose a time.', 'error');
      scrollToEl(slotsField);
      return;
    }

    const payload = {
      date: dateInput.value,
      slotMinute: selectedSlotMinute,
      partySize: Number(partySelect.value),
      name: nameInput.value,
      phone: phoneInput.value,
      email: emailInput.value,
      notes: notesInput.value,
      company: companyInput.value,
      elapsedMs: Date.now() - formShownAt
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Reserving…';
    setStatus('Submitting your reservation…');

    fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then((response) => response.json().then((body) => ({ status: response.status, body })))
      .then(({ status, body }) => {
        if (status === 201 && body.ok) {
          showSuccess(body);
          return;
        }
        const message = ERROR_COPY[body.code] || ERROR_COPY.server_error;
        setStatus(message, 'error');
        // The slot this guest picked may have just been taken by someone
        // else -- that race is exactly what capacity checking exists for.
        // Re-fetching lets the taken pill grey out immediately instead of
        // leaving a stale, clickable button on screen.
        if (body.code === 'slot_full' || body.code === 'date_closed') {
          loadAvailability(dateInput.value);
        }
      })
      .catch(() => {
        setStatus(ERROR_COPY.network, 'error');
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request Table';
      });
  }

  function showSuccess(result) {
    bookingForm.hidden = true;
    setStatus('');
    refEl.textContent = result.reference;
    recapEl.textContent = result.date + ' at ' + result.time + ', party of ' + result.partySize + '.';
    successEl.hidden = false;
    successTitle.focus({ preventScroll: true });
    scrollToEl(successEl);
    refreshScrollTrigger();
  }

  initDateBounds();
  showForm();

  dateInput.addEventListener('change', () => {
    if (dateInput.value) loadAvailability(dateInput.value);
  });

  bookingForm.addEventListener('submit', handleSubmit);

  // Deliberate departure from the rest of the codebase's swallow-and-
  // degrade error handling: a guest who clicks "Reserve" and sees nothing
  // happen is worse than a broken animation, so every failure path above
  // ends by writing into the #bkStatus live region instead of staying
  // silent.
}
