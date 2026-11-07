import { POLICY, DRAFT_KEY, SUPPORT_DRAFT_KEY, CONTACT_DRAFT_KEY, CATALOG, validateCatalog, readPreferenceCookie, gpcRestricted, createServiceGate, createPreferenceSyncGuard, createConsentActionAdapter } from './policy.js';

// History navigation never creates a second controller. No application draft data is read here.
if (!window.assayNovaPrivacy) window.assayNovaPrivacy = boot();

function boot() {
  const catalog = validateCatalog(CATALOG);
  const synchronization = createPreferenceSyncGuard(catalog);
  let vendor;
  let signal = null;
  let signalError = false;
  let savedError = false;
  let lifecycleError = false;
  let ready = false;
  let initializing = false;
  let attempt = 0;
  let previousFocus;
  let channel;
  let lastCookie;
  let hadReceipt = false;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'an-privacy-settings';
  button.className = 'an-privacy-settings';
  button.textContent = 'Privacy & cookie settings';
  const status = document.createElement('p');
  status.id = 'an-privacy-status';
  status.className = 'an-privacy-status';
  status.setAttribute('role', 'status');
  const footer = document.querySelector('.site-footer') || document.body.appendChild(document.createElement('footer'));
  const controls = document.createElement('div');
  controls.className = 'an-privacy-controls';
  controls.append(button, status);
  footer.append(controls);

  const fallback = document.createElement('dialog');
  fallback.className = 'an-privacy-fallback';
  fallback.setAttribute('aria-labelledby', 'an-privacy-fallback-title');
  fallback.innerHTML = '<h2 id="an-privacy-fallback-title">Privacy & cookie settings</h2><p>Only necessary storage is used. Analytics and advertising are not enabled.</p><p>The preference cookie, <code>assaynova_privacy</code>, remembers a choice for 180 days. Older request, recovery and contact values may remain in <code>assaynova.prototype.requests.v1</code>, <code>' + SUPPORT_DRAFT_KEY + '</code> and <code>' + CONTACT_DRAFT_KEY + '</code>. These legacy browser values are no longer read, written or uploaded by request forms. They remain until browser site-data clearing. Privacy choices do not read or delete them.</p><p>Requested account features use two necessary cookies, <code>an_customer_[port]</code> for sign-in and <code>an_customer_csrf_[port]</code> for account-form security, scoped to <code>/api/account</code>. Sign-in expires after 24 hours of inactivity or 7 days in total. The sign-in-form challenge lasts 10 minutes; an authenticated security cookie lasts up to 7 days. Testing, contact and report recovery requests are stored on the server only when you explicitly submit while signed in, until you delete them from My requests. Legacy browser values are never uploaded automatically.</p><p data-privacy-feedback role="status"></p><div class="an-privacy-actions"><button type="button" data-privacy-retry>Retry privacy settings</button><button type="button" data-privacy-close>Close</button></div>';
  document.body.append(fallback);
  fallback.querySelector('[data-privacy-close]').addEventListener('click', () => fallback.close());
  fallback.addEventListener('close', () => previousFocus?.isConnected && previousFocus.focus());
  fallback.querySelector('[data-privacy-retry]').addEventListener('click', async () => {
    await initialize();
    if (ready) { fallback.close(); vendor.showPreferences(); }
  });

  const gate = createServiceGate(catalog, {
    removeCookie: ({ name, path }) => { document.cookie = `${name}=; Path=${path}; Max-Age=0; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; },
    removeStorage: ({ type, key }) => window[type].removeItem(key),
    onError: () => { lifecycleError = true; updateStatus(); }
  });
  const actions = createConsentActionAdapter(catalog, synchronization, {
    readStored: storedReceipt,
    readVendor: () => vendor.getCookie(),
    writeReceipt: (receipt) => vendor.setCookieData({ value: receipt }),
    onResult: (result) => {
      savedError = !result.saved;
      refresh();
      updateStatus(savedError ? undefined : 'Preference saved for 180 days. You can reopen these settings at any time.');
      try { channel?.postMessage(result.message); } catch { /* Focus/poll checks remain available. */ }
    }
  });

  function cookieValue() {
    try { return document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${POLICY.cookie}=`))?.slice(POLICY.cookie.length + 1) || ''; }
    catch { return ''; }
  }

  function storedReceipt() {
    return readPreferenceCookie(cookieValue(), catalog);
  }

  function updateStatus(message) {
    const normal = signal === true ? 'Global Privacy Control is on. Sale, sharing and marketing remain off.' : 'Analytics and advertising are not enabled.';
    const feedback = lifecycleError ? 'An optional service could not be stopped completely. Reload this page before continuing.' : message || (savedError ? 'Your preference could not be saved. Optional services remain off. Check your cookie settings and retry.' : synchronization.blocked && catalog.services.length ? 'A privacy choice changed in another tab. Optional services remain off here until you review settings and save a new choice.' : signalError ? 'Your browser privacy signal could not be checked. Optional services remain off. Reopen settings to retry.' : normal);
    status.textContent = feedback;
    fallback.querySelector('[data-privacy-feedback]').textContent = feedback;
    for (const item of document.querySelectorAll('#cc-main [data-an-privacy-feedback]')) item.textContent = feedback;
  }

  function refresh() {
    const receipt = storedReceipt();
    lastCookie = cookieValue();
    hadReceipt = !!receipt;
    void gate.update(ready && !savedError && !lifecycleError ? synchronization.receipt(receipt) : null, signal);
    return receipt;
  }

  async function fetchSignal() {
    // Navigator and header signals are ORed; an unavailable endpoint never implies permission.
    signal = navigator.globalPrivacyControl === true ? true : null;
    signalError = false;
    refresh();
    try {
      const response = await fetch('/privacy/signals', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (!response.ok || Object.keys(data).length !== 1 || typeof data.gpc !== 'boolean') throw new Error('Invalid privacy signal');
      signal = navigator.globalPrivacyControl === true || data.gpc;
    } catch { signalError = true; }
    refresh();
    updateStatus();
  }

  function applySignalToUI(resetBlocked = false) {
    for (const purpose of catalog.purposes) {
      const blockedByGpc = signal === true && gpcRestricted(purpose);
      // CookieConsent's respectGpc alone permits older grants. The gate always overrides them.
      for (const input of document.querySelectorAll(`#cc-main input[name="cc-${purpose.id}"], #cc-main input[data-category="${purpose.id}"]`)) {
        if (blockedByGpc || (resetBlocked && synchronization.blocked)) {
          input.checked = false;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        input.disabled = blockedByGpc;
        if (blockedByGpc) input.setAttribute('aria-label', `${purpose.label}: off because Global Privacy Control is on`);
        else input.removeAttribute('aria-label');
      }
    }
  }

  function configuration() {
    const optional = catalog.services.length > 0;
    const categories = { necessary: { enabled: true, readOnly: true } };
    for (const purpose of catalog.purposes) categories[purpose.id] = {
      enabled: false,
      services: Object.fromEntries(catalog.services.filter((service) => service.purpose === purpose.id).map((service) => [service.id, { label: escape(service.label) }]))
    };
    const signalText = signal === true ? 'Global Privacy Control is on. Sale, sharing and marketing stay off, including previously granted choices.' : 'Optional services, if offered, require your explicit choice. An unavailable privacy signal keeps optional services off.';
    return {
      root: document.body, mode: 'opt-in', revision: POLICY.revision, hideFromBots: false,
      autoShow: true, disablePageInteraction: false, manageScriptTags: false, autoClearCookies: false, respectGpc: false,
      cookie: { name: POLICY.cookie, domain: '', path: '/', secure: true, sameSite: 'Lax', expiresAfterDays: POLICY.days, useLocalStorage: false },
      categories,
      guiOptions: { consentModal: { layout: 'bar inline', position: 'bottom', equalWeightButtons: true }, preferencesModal: { layout: 'box', equalWeightButtons: true } },
      onFirstConsent: actions.onVendorChoice, onChange: actions.onVendorChoice,
      onConsent: () => { refresh(); updateStatus(); },
      onModalShow: () => { applySignalToUI(true); updateStatus(); },
      onModalReady: () => { applySignalToUI(true); },
      onModalHide: ({ modalName }) => { if (modalName === 'preferencesModal') previousFocus?.isConnected && previousFocus.focus({ preventScroll: true }); },
      language: { default: 'en', translations: { en: {
        consentModal: {
          title: 'Cookies & privacy',
          description: optional ? 'Essential storage stays active with either choice. Choose whether to allow the optional services listed in Customize. You can browse and use COA lookup without optional services.' : 'Essential storage stays active with either choice. Analytics and advertising are currently disabled. Customize explains the storage we use. You can keep browsing before choosing.',
          acceptAllBtn: 'Accept All', acceptNecessaryBtn: 'Reject All', showPreferencesBtn: 'Customize'
        },
        preferencesModal: {
          title: 'Privacy & cookie settings', closeIconLabel: 'Close privacy settings',
          acceptAllBtn: 'Accept All', acceptNecessaryBtn: 'Reject All', savePreferencesBtn: 'Save preferences',
          sections: [
            { title: 'Storage on this device', description: 'These settings explain necessary account cookies and legacy browser storage. Requests are stored on the server only by explicit signed-in submission and can be deleted from My requests. Older browser values are retained without new reads, writes or automatic uploads. Privacy choices do not read or delete them; browser site-data controls can clear them.' },
            { title: 'Necessary storage — always available', linkedCategory: 'necessary', description: 'Used to remember your privacy choice and provide requested account access. Legacy request, recovery and contact browser values may remain but request forms no longer read or write them. Optional consent is never required to browse or use COA lookup.', cookieTable: { caption: 'Current storage inventory', headers: { name: 'Name', purpose: 'Purpose', retention: 'Retention' }, body: [
              { name: POLICY.cookie, purpose: 'Host-only preference cookie: choices, policy/catalog version, timestamps and a randomly generated receipt ID. No analytics use.', retention: '180 days after a choice; the same period for acceptance and rejection.' },
              { name: 'an_customer_[port]', purpose: 'Necessary requested customer sign-in, scoped to /api/account. HttpOnly; separate from administrator access.', retention: '24 hours idle / 7 days absolute; revoked on sign out or account security changes.' },
              { name: 'an_customer_csrf_[port]', purpose: 'Necessary browser-bound account-form security check, scoped to /api/account.', retention: '10 minutes before sign-in; up to 7 days when authenticated; rotated or cleared with sign-in state.' },
              { name: DRAFT_KEY, purpose: 'Legacy testing request values. Retained without active form reads, writes or automatic upload. Image files are not retained.', retention: 'Until you clear this site’s data in your browser. No automatic time-based expiry.' },
              { name: SUPPORT_DRAFT_KEY, purpose: 'Legacy report recovery value. Retained without active form reads, writes or automatic upload.', retention: 'Until browser site-data clearing. No automatic time-based expiry.' },
              { name: CONTACT_DRAFT_KEY, purpose: 'Legacy contact enquiry value. Retained without active form reads, writes or automatic upload.', retention: 'Until browser site-data clearing. No automatic time-based expiry.' }
            ] } },
            ...catalog.purposes.map((purpose) => ({ title: escape(purpose.label), linkedCategory: purpose.id, description: `${escape(purpose.description)}${signal === true && gpcRestricted(purpose) ? ' Off while Global Privacy Control is on.' : ''}<ul>${catalog.services.filter((service) => service.purpose === purpose.id).map((service) => `<li>${escape(service.label)}: ${escape(service.description)} Retention: ${escape(service.retention)}</li>`).join('')}</ul>` })),
            ...(!optional ? [{ title: 'Analytics & advertising', description: 'No analytics, advertising, third-party fonts, embeds or tracking SDKs are enabled. There are no optional services to switch on.' }] : []),
            { title: 'Browser privacy signals & changing choices', description: `${signalText} Reopen “Privacy & cookie settings” in the footer at any time${optional ? ' to change your choices or reject optional services' : ''}. Closing settings, scrolling and navigation do not grant optional permission. <span data-an-privacy-feedback role="status"></span>` }
          ]
        }
      } } }
    };
  }

  async function initialize() {
    if (initializing) return;
    initializing = true;
    ready = false;
    updateStatus('Loading privacy settings. Optional services remain off.');
    await gate.update(null, null);
    try {
      await fetchSignal();
      if (!vendor) vendor = await timed(import(`../vendor/cookieconsent-3.2.1/cookieconsent.esm.js${attempt++ ? `?retry=${attempt}` : ''}`));
      else vendor.reset(false);
      // Reject legacy, corrupt and changed-catalog preferences before the UI can load them.
      if (cookieValue() && !storedReceipt()) document.cookie = `${POLICY.cookie}=; Path=/; Max-Age=0; SameSite=Lax`;
      await timed(vendor.run(configuration()));
      ready = true;
      refresh();
      updateStatus();
    } catch {
      try { vendor?.reset(false); } catch { /* Fallback remains independent of the vendor. */ }
      ready = false;
      await gate.update(null, signal);
      updateStatus('Privacy settings are temporarily unavailable. Only necessary storage is used. Reopen settings to retry.');
    } finally { initializing = false; }
  }

  button.addEventListener('click', async () => {
    previousFocus = button;
    if (ready) { vendor.showPreferences(); void fetchSignal().then(applySignalToUI); }
    else { fallback.showModal(); }
  });
  document.addEventListener('click', (event) => {
    const target = event.target.closest?.('#cc-main button[data-role]');
    if (!ready || !target || !['all', 'necessary', 'save'].includes(target.dataset.role)) return;
    actions.begin();
  }, true);
  // The vendor's target handler writes categories/services before this bubble
  // listener. This also persists unchanged choices for which no callback fires.
  document.addEventListener('click', () => actions.afterDispatch());
  try {
    channel = new BroadcastChannel('assaynova-privacy');
    channel.onmessage = (event) => {
      if (!synchronization.receive(event.data)) return;
      refresh();
      updateStatus();
      void initialize();
    };
  } catch { /* Storage-disabled browsers can still browse and open settings. */ }
  const check = () => {
    if (navigator.globalPrivacyControl === true) signal = true;
    if (ready && (cookieValue() !== lastCookie || (hadReceipt && !storedReceipt()))) { refresh(); void initialize(); return; }
    refresh();
    applySignalToUI();
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, 5000); // Expiry and cross-tab removal fail closed even without BroadcastChannel.
  void initialize();
  return Object.freeze({ open: () => button.click() });
}

async function timed(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Privacy settings timed out')), 6000); })]); }
  finally { clearTimeout(timer); }
}
