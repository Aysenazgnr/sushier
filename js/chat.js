// Floating chat widget: talks to /api/chat, which is stateless -- this
// file is the only place the conversation exists. Nothing is written to
// localStorage/sessionStorage either, by design: closing the tab or
// reloading the page loses the chat, same as it would for any visitor
// walking up to the host desk and starting over.
//
// Follows js/reservation.js's conventions (flat top-level code, defer, no
// IIFE), gated the same way behind `if (widget) { ... }` so a missing
// element (markup removed, or this script loaded on a page without the
// widget) just does nothing instead of throwing.
const chatWidget = document.getElementById('chatWidget');

if (chatWidget) {
  const chatToggle = document.getElementById('chatToggle');
  const chatPanel = document.getElementById('chatPanel');
  const chatClose = document.getElementById('chatClose');
  const chatPanelTitle = document.getElementById('chatPanelTitle');
  const chatLog = document.getElementById('chatLog');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const chatInputLabel = document.getElementById('chatInputLabel');
  const chatSend = document.getElementById('chatSend');

  const MAX_HISTORY = 20;

  // Only the widget's own labels and fallback copy -- never what the
  // model replies with. The visitor's own language always decides that
  // (see api/_lib/chat-knowledge.js's system prompt), this just picks a
  // sensible starting point for a visitor who hasn't typed anything yet,
  // the same signal js/reservation.js's browser-native date picker already
  // renders in via the OS locale.
  const lang = (navigator.language || 'en').toLowerCase().startsWith('tr') ? 'tr' : 'en';

  const STRINGS = {
    tr: {
      title: 'Sushier',
      openLabel: 'Sohbeti aç',
      closeLabel: 'Sohbeti kapat',
      inputLabel: 'Mesaj',
      placeholder: 'Bir şey sorun…',
      sendLabel: 'Gönder',
      greeting: 'Merhaba! Çalışma saatleri, menü veya rezervasyon hakkında bana soru sorabilirsiniz.',
      thinking: 'Yazıyor…',
      unavailable: 'Şu an canlı yazışma kapalı. Bize +90 000 000 00 00 numarasından ulaşabilir veya rezervasyon formunu kullanabilirsiniz.',
      network: 'Bağlanılamadı. Lütfen tekrar deneyin veya bizi arayın.',
      error: 'Bir şeyler ters gitti. Lütfen tekrar deneyin veya bizi arayın.',
      tooLong: 'Bu sohbet çok uzadı -- lütfen sayfayı yenileyip yeniden başlayın, ya da bizi arayın.'
    },
    en: {
      title: 'Sushier',
      openLabel: 'Open chat',
      closeLabel: 'Close chat',
      inputLabel: 'Message',
      placeholder: 'Ask us something…',
      sendLabel: 'Send',
      greeting: "Hi! Ask me about hours, the menu, or booking a table.",
      thinking: 'Typing…',
      unavailable: 'Live chat is unavailable right now. You can reach us at +90 000 000 00 00 or use the reservation form.',
      network: "Couldn't connect. Please try again, or call us.",
      error: 'Something went wrong. Please try again, or call us.',
      tooLong: "This conversation got too long -- please refresh the page to start over, or call us."
    }
  };
  const copy = STRINGS[lang];

  chatPanelTitle.textContent = copy.title;
  chatToggle.setAttribute('aria-label', copy.openLabel);
  chatClose.setAttribute('aria-label', copy.closeLabel);
  chatInputLabel.textContent = copy.inputLabel;
  chatInput.placeholder = copy.placeholder;
  chatSend.setAttribute('aria-label', copy.sendLabel);

  let history = [];
  let requestController = null;
  let greeted = false;

  function appendBubble(role, text) {
    const bubble = document.createElement('p');
    bubble.className = 'chat-bubble ' + (role === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot');
    bubble.textContent = text;
    chatLog.appendChild(bubble);
    chatLog.scrollTop = chatLog.scrollHeight;
    return bubble;
  }

  function setOpen(open) {
    chatPanel.hidden = !open;
    chatToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!greeted) {
        appendBubble('bot', copy.greeting);
        greeted = true;
      }
      chatInput.focus();
    } else {
      chatToggle.focus();
    }
  }

  function sendMessage(text) {
    if (requestController) requestController.abort();
    requestController = new AbortController();

    history.push({ role: 'user', content: text });
    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }

    const thinkingBubble = appendBubble('bot', copy.thinking);
    chatSend.disabled = true;

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, lang }),
      signal: requestController.signal
    })
      .then((response) => response.json().then((body) => ({ status: response.status, body })))
      .then(({ status, body }) => {
        thinkingBubble.remove();

        if (status === 503) {
          appendBubble('bot', copy.unavailable);
          return;
        }
        if (status === 400 && body && body.code === 'conversation_too_long') {
          appendBubble('bot', copy.tooLong);
          return;
        }
        if (status !== 200 || !body || !body.ok) {
          appendBubble('bot', copy.error);
          return;
        }

        appendBubble('bot', body.reply);
        history.push({ role: 'assistant', content: body.reply });

        if (body.action && body.action.type === 'prefill' && window.__sushierBooking) {
          setOpen(false);
          window.__sushierBooking.prefill(body.action.date, body.action.partySize, body.action.slotMinute);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        thinkingBubble.remove();
        appendBubble('bot', copy.network);
      })
      .finally(() => {
        chatSend.disabled = false;
      });
  }

  chatToggle.addEventListener('click', () => {
    setOpen(chatPanel.hidden);
  });

  chatClose.addEventListener('click', () => setOpen(false));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !chatPanel.hidden) {
      setOpen(false);
    }
  });

  // Simple focus trap: the panel only ever has two focusable controls
  // besides the close button (the textarea and the send button), so a
  // two-element loop is enough -- no need for a generic trap helper.
  chatPanel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [chatClose, chatInput, chatSend];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    appendBubble('user', text);
    chatInput.value = '';
    sendMessage(text);
  });

  // Enter sends, Shift+Enter inserts a newline -- textarea's default
  // Enter behavior (newline) would otherwise never submit the form.
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  chatWidget.hidden = false;
}
