// Admin dashboard: Supabase Auth sign-in, then list/filter/act on
// reservations and manage closed dates. Loaded only on admin/index.html --
// no GSAP/Lenis/hero-scrub here, a data table has no scroll-scrub rig to
// support.
//
// The anon key below is public by design: with RLS enabled and zero
// policies granted to the `anon` role on any table, this key alone reaches
// nothing. It only becomes useful once paired with a staff member's own
// session from signInWithPassword.
const SUPABASE_URL = 'https://xbmnswonczalzeycmswz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibW5zd29uY3phbHpleWNtc3d6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2ODEyNzEsImV4cCI6MjEwODI1NzI3MX0.DQVWU9cLtnrDBixOIwHdBKBU5DwItdQ8KLogF0e4DC8';

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

const loginView = document.getElementById('loginView');
const dashboardView = document.getElementById('dashboardView');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginSubmit = document.getElementById('loginSubmit');
const loginStatus = document.getElementById('loginStatus');
const signOutBtn = document.getElementById('signOutBtn');

const filterDate = document.getElementById('filterDate');
const filterStatus = document.getElementById('filterStatus');
const quickButtons = document.querySelectorAll('.admin-quick-btn');
const listStatus = document.getElementById('listStatus');
const listSummary = document.getElementById('listSummary');
const reservationsBody = document.getElementById('reservationsBody');

const closeDateForm = document.getElementById('closeDateForm');
const closeDateInput = document.getElementById('closeDate');
const closeReasonInput = document.getElementById('closeReason');
const closeDateStatus = document.getElementById('closeDateStatus');
const closedDatesList = document.getElementById('closedDatesList');

let currentRange = 'upcoming'; // today | week | upcoming | past -- overridden by a specific filterDate

function istanbulToday() {
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

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function setStatus(el, message, kind) {
  el.textContent = message || '';
  el.classList.toggle('error', kind === 'error');
}

// ---------- View switching ----------

function showLogin() {
  loginView.hidden = false;
  dashboardView.hidden = true;
  signOutBtn.hidden = true;
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  signOutBtn.hidden = false;
  loadReservations();
  loadClosedDates();
}

// ---------- Auth ----------

function handleLogin(event) {
  event.preventDefault();
  setStatus(loginStatus, 'Signing in…');
  loginSubmit.disabled = true;

  client.auth.signInWithPassword({
    email: loginEmail.value.trim(),
    password: loginPassword.value
  }).then(({ error }) => {
    if (error) {
      // Deliberately generic: never distinguish "no such user" from
      // "wrong password".
      setStatus(loginStatus, 'Sign-in failed.', 'error');
      return;
    }
    loginPassword.value = '';
    setStatus(loginStatus, '');
  }).finally(() => {
    loginSubmit.disabled = false;
  });
}

function handleSignOut() {
  client.auth.signOut();
}

client.auth.onAuthStateChange((_event, session) => {
  if (session) {
    showDashboard();
  } else {
    showLogin();
  }
});

// ---------- Reservations list ----------

function buildReservationsQuery() {
  let query = client.from('reservations').select('*');

  if (filterStatus.value) {
    query = query.eq('status', filterStatus.value);
  }

  if (filterDate.value) {
    query = query.eq('service_date', filterDate.value);
    return query.order('starts_at', { ascending: true });
  }

  const today = istanbulToday();
  if (currentRange === 'today') {
    query = query.eq('service_date', today);
  } else if (currentRange === 'week') {
    query = query.gte('service_date', today).lte('service_date', addDays(today, 7));
  } else if (currentRange === 'past') {
    query = query.lt('service_date', today);
  } else {
    query = query.gte('service_date', today);
  }

  return query.order('starts_at', { ascending: currentRange !== 'past' });
}

function loadReservations() {
  setStatus(listStatus, 'Loading…');
  buildReservationsQuery().then(({ data, error }) => {
    if (error) {
      setStatus(listStatus, 'Could not load reservations.', 'error');
      return;
    }
    setStatus(listStatus, '');
    renderReservations(data || []);
  });
}

function renderReservations(rows) {
  if (!rows.length) {
    listSummary.textContent = 'No reservations found.';
    reservationsBody.replaceChildren();
    return;
  }

  const activeCount = rows.filter((r) => r.status !== 'cancelled').length;
  listSummary.textContent = rows.length + ' reservation' + (rows.length === 1 ? '' : 's') +
    ' (' + activeCount + ' active)';

  const trs = rows.map((row) => buildReservationRow(row));
  reservationsBody.replaceChildren(...trs);
}

// Guest-supplied fields (name, phone, email, notes) reach the DOM only
// through textContent, never innerHTML -- this is the actual defense
// against a guest putting markup in the notes field, not just a style
// preference.
function buildReservationRow(row) {
  const tr = document.createElement('tr');
  if (row.status === 'cancelled') tr.classList.add('is-cancelled');

  const cells = [
    row.service_date,
    minutesToTime(row.slot_minute),
    String(row.party_size),
    row.guest_name,
    row.guest_phone,
    row.guest_email || '—',
    row.notes || '—',
    row.reference,
    row.status
  ];

  cells.forEach((value, i) => {
    const td = document.createElement('td');
    if (i === 6) td.classList.add('notes-cell');
    td.textContent = value;
    tr.appendChild(td);
  });

  const actionsTd = document.createElement('td');
  actionsTd.className = 'admin-row-actions';
  actionsTd.appendChild(buildRowActions(row));
  tr.appendChild(actionsTd);

  return tr;
}

function buildRowActions(row) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-row-actions';

  function actionButton(label, onClick, danger) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-action-btn' + (danger ? ' danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return wrap.appendChild(btn);
  }

  if (row.status === 'booked') {
    actionButton('Seated', () => updateReservationStatus(row.id, 'seated'));
    actionButton('No-show', () => updateReservationStatus(row.id, 'no_show'));
    actionButton('Cancel', () => {
      const label = row.guest_name + ' at ' + minutesToTime(row.slot_minute) + ' on ' + row.service_date;
      if (window.confirm('Cancel the reservation for ' + label + '?')) {
        updateReservationStatus(row.id, 'cancelled');
      }
    }, true);
  } else if (row.status === 'cancelled') {
    // Reopening does not re-check capacity -- staff overriding capacity
    // is intentional, not a bug (see plan: the slot may have refilled,
    // and that failure is surfaced by the update itself only via RLS,
    // never silently blocked here).
    actionButton('Reopen', () => updateReservationStatus(row.id, 'booked'));
  } else {
    actionButton('Reopen', () => updateReservationStatus(row.id, 'booked'));
  }

  return wrap;
}

// Routed through /api/reservation-status instead of writing to Supabase
// directly: the update still runs under this staff member's own session
// (their access token goes in Authorization, so RLS/is_staff() is exactly
// as before -- this route has no elevated access of its own), but routing
// through the server is what lets a cancellation trigger a Telegram
// notification, which no client-side code could do without shipping the
// bot token to the browser. cancelled_at is set server-side now, not here.
function updateReservationStatus(id, status) {
  setStatus(listStatus, 'Updating…');
  client.auth.getSession().then(({ data: sessionData }) => {
    const token = sessionData.session && sessionData.session.access_token;
    if (!token) {
      setStatus(listStatus, 'Your session expired. Please sign in again.', 'error');
      return;
    }
    fetch('/api/reservation-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ id, status })
    })
      .then((response) => response.json().then((body) => ({ httpStatus: response.status, body })))
      .then(({ httpStatus, body }) => {
        if (httpStatus !== 200 || !body.ok) {
          setStatus(listStatus, 'Could not update that reservation.', 'error');
          return;
        }
        setStatus(listStatus, '');
        loadReservations();
      })
      .catch(() => {
        setStatus(listStatus, 'Could not update that reservation.', 'error');
      });
  });
}

function setActiveQuickButton(range) {
  quickButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
}

// ---------- Closed dates ----------

function loadClosedDates() {
  client.from('closed_dates').select('*').order('service_date', { ascending: true }).then(({ data, error }) => {
    if (error) return;
    renderClosedDates(data || []);
  });
}

function renderClosedDates(rows) {
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No dates are currently closed.';
    closedDatesList.replaceChildren(li);
    return;
  }

  const items = rows.map((row) => {
    const li = document.createElement('li');

    const label = document.createElement('span');
    label.textContent = row.service_date;
    if (row.reason) {
      const reasonSpan = document.createElement('span');
      reasonSpan.className = 'closed-reason';
      reasonSpan.textContent = row.reason;
      label.appendChild(reasonSpan);
    }

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'admin-action-btn';
    reopenBtn.textContent = 'Reopen';
    reopenBtn.addEventListener('click', () => reopenDate(row.service_date));

    li.appendChild(label);
    li.appendChild(reopenBtn);
    return li;
  });

  closedDatesList.replaceChildren(...items);
}

function reopenDate(dateStr) {
  client.from('closed_dates').delete().eq('service_date', dateStr).then(({ error }) => {
    if (!error) loadClosedDates();
  });
}

function handleCloseDateSubmit(event) {
  event.preventDefault();
  const dateStr = closeDateInput.value;
  if (!dateStr) return;

  setStatus(closeDateStatus, 'Checking existing reservations…');

  // Closing a date never auto-cancels existing bookings on it -- silently
  // cancelling a guest's reservation would be the worst possible behavior
  // here. Staff are warned so they can call the affected guests themselves.
  client.from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('service_date', dateStr)
    .neq('status', 'cancelled')
    .then(({ count }) => {
      const warning = count ? ' ' + count + ' existing reservation' + (count === 1 ? '' : 's') +
        ' on this date will not be cancelled automatically.' : '';

      client.from('closed_dates').upsert({
        service_date: dateStr,
        reason: closeReasonInput.value.trim() || null
      }).then(({ error }) => {
        if (error) {
          setStatus(closeDateStatus, 'Could not close that date.', 'error');
          return;
        }
        setStatus(closeDateStatus, 'Date closed.' + warning);
        closeDateInput.value = '';
        closeReasonInput.value = '';
        loadClosedDates();
      });
    });
}

// ---------- Wiring ----------

loginForm.addEventListener('submit', handleLogin);
signOutBtn.addEventListener('click', handleSignOut);
filterDate.addEventListener('change', () => {
  if (filterDate.value) setActiveQuickButton(null);
  loadReservations();
});
filterStatus.addEventListener('change', loadReservations);
quickButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentRange = btn.dataset.range;
    filterDate.value = '';
    setActiveQuickButton(currentRange);
    loadReservations();
  });
});
closeDateForm.addEventListener('submit', handleCloseDateSubmit);

setActiveQuickButton(currentRange);

client.auth.getSession().then(({ data }) => {
  if (data.session) {
    showDashboard();
  } else {
    showLogin();
  }
});
