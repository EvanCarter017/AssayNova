import { SERVICE_NAMES } from './data.js';
import { REQUEST_DRAFT_KEY, SAMPLE_FORMS, IMAGE_CHOICES, IMAGE_STYLES, newSample, newSubmission, duplicateSubmissionSample, validateSubmissionState, submissionTotals, effectiveReportRecipient, createRequestRecord, parseRequestRecord, requestStateFromRecord, decodeRequestList, prepareRequestSave } from './submission.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const optionList = (choices, value) => Object.entries(choices).map(([key, label]) => `<option value="${key}"${key === value ? ' selected' : ''}>${escape(label)}</option>`).join('');
const titles = ['Testing & samples', 'Contact & report', 'Review your request'];

export function createRequestPage(root, { storage = { getItem: key => globalThis.localStorage.getItem(key), setItem: (key, value) => globalThis.localStorage.setItem(key, value) }, makeId = () => crypto.randomUUID(), now = () => new Date().toISOString(), objectURLs = URL, openSavedDrafts = () => {}, onSaved = () => {} } = {}) {
  const nextSampleId = () => 's-' + makeId().slice(0, 60);
  let state = newSubmission(nextSampleId());
  let step = 1;
  let pristine = true;
  let identity = null;
  let saved = false;
  let notice = '';
  let pendingPreset;
  let errors = {};
  let saveError = '';
  let destroyed = false;
  const previews = new Map();
  const fileErrors = new Map();
  const fieldId = key => 'rq-' + key.replaceAll(':', '-');
  const find = id => root.querySelector('#' + id);
  const focus = id => { const target = find(id); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: id === 'request-step-heading' || id.startsWith('rq-heading-') ? 'start' : 'center', behavior: 'instant' }); };
  const getValue = key => {
    if (!key.startsWith('sample:')) return state[key];
    const [, id, name] = key.split(':');
    return state.samples.find(sample => sample.id === id)?.[name];
  };
  const revoke = id => { const item = previews.get(id); if (item) { objectURLs.revokeObjectURL(item.url); previews.delete(id); } fileErrors.delete(id); };
  const revokeAll = () => { for (const id of previews.keys()) revoke(id); fileErrors.clear(); };
  const changed = () => { pristine = false; saved = false; saveError = ''; notice = ''; pendingPreset = undefined; const message = find('rq-notice'); if (message) message.textContent = ''; root.querySelector('.rq-fresh')?.remove(); };

  function input(key, label, { type = 'text', maximum, required = false, autocomplete, helper = '', placeholder = '', choices, textarea = false, min, max } = {}) {
    const id = fieldId(key);
    const value = getValue(key);
    const invalid = errors[key];
    const described = `${helper ? id + '-help ' : ''}${id}-error`;
    const attrs = `id="${id}" name="${escape(key)}" data-rq-field="${escape(key)}" aria-describedby="${described}"${required ? ' required' : ''}${maximum ? ` maxlength="${maximum}"` : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''}${placeholder ? ` placeholder="${escape(placeholder)}"` : ''}${invalid ? ' aria-invalid="true"' : ''}`;
    let control = choices ? `<select ${attrs}>${optionList(choices, value)}</select>` : textarea ? `<textarea ${attrs}></textarea>` : `<input ${attrs} type="${type}"${min !== undefined ? ` min="${min}" max="${max}" step="1"` : ''}>`;
    return `<div class="rq-field"><label for="${id}">${label}${required ? '' : ' <span>Optional</span>'}</label>${control}${helper ? `<p class="rq-helper" id="${id}-help">${helper}</p>` : ''}<p class="rq-field-error" id="${id}-error">${escape(invalid || '')}</p></div>`;
  }

  function samplesMarkup() {
    return `<div class="rq-samples">${state.samples.map((sample, index) => {
      const key = name => `sample:${sample.id}:${name}`;
      return `<fieldset class="rq-sample"><legend><span id="rq-heading-${sample.id}" tabindex="-1" data-request-private>Sample ${index + 1}${sample.name ? ' · ' + escape(sample.name) : ''}</span></legend><div class="rq-fields">
        ${input(key('name'), 'Sample or project name', { maximum: 160, required: true, placeholder: 'A name you will recognize' })}
        ${input(key('service'), 'Testing service', { required: true, choices: SERVICE_NAMES })}
        ${input(key('quantity'), 'Quantity planned (units)', { type: 'number', required: true, min: 1, max: 100, helper: 'Number of units you plan to send.' })}
        ${input(key('form'), 'Sample form', { required: true, choices: SAMPLE_FORMS })}
        </div><div class="rq-sample-actions"><button type="button" data-rq-action="duplicate" data-rq-id="${sample.id}"${state.samples.length >= 10 ? ' disabled' : ''}>Duplicate</button><button type="button" data-rq-action="remove" data-rq-id="${sample.id}"${state.samples.length === 1 ? ' disabled' : ''}>Remove</button></div></fieldset>`;
    }).join('')}</div><div class="rq-add-row"><button class="button button-outline" type="button" id="rq-add-sample" data-rq-action="add"${state.samples.length >= 10 ? ' disabled' : ''}>+ Add sample</button><p>Up to 10 sample entries. At least one entry is required.</p></div>`;
  }

  function imageMarkup(sample, index) {
    const key = name => `sample:${sample.id}:${name}`;
    const preview = previews.get(sample.id);
    return `<fieldset class="rq-photo"><legend data-request-private>Sample ${index + 1} · ${escape(sample.name || 'Unnamed sample')}</legend><div class="rq-fields">${input(key('image'), 'Product image on the COA', { required: true, choices: IMAGE_CHOICES })}${sample.image === 'include' ? input(key('imageStyle'), 'Image style', { required: true, choices: IMAGE_STYLES }) : ''}</div>${sample.image === 'include' ? `<div class="rq-field rq-file"><label for="rq-file-${sample.id}">Reference image <span>Optional</span></label><input type="file" id="rq-file-${sample.id}" data-rq-file="${sample.id}"${fileErrors.has(sample.id) ? ' aria-invalid="true"' : ''} accept="image/jpeg,image/png,image/webp" aria-describedby="rq-file-${sample.id}-help rq-file-${sample.id}-error"><p class="rq-helper" id="rq-file-${sample.id}-help">Local preview only. Image files are not retained with saved drafts. JPEG, PNG or WebP, up to 5 MiB.${identity && !preview ? ' Reselect an optional reference image if needed.' : ''}</p><p class="rq-field-error" id="rq-file-${sample.id}-error">${escape(fileErrors.get(sample.id) || '')}</p></div>${preview ? `<div class="rq-preview" data-request-private><img src="${escape(preview.url)}" alt="Local reference image preview"><button type="button" data-rq-action="remove-image" data-rq-id="${sample.id}">Remove reference image</button></div>` : ''}` : ''}</fieldset>`;
  }

  function contactMarkup() {
    return `<fieldset class="rq-contact"><legend>Your details</legend><div class="rq-fields">${input('name', 'Your name', { required: true, maximum: 100, autocomplete: 'name' })}${input('email', 'Contact email', { required: true, type: 'email', maximum: 160, autocomplete: 'email', helper: 'Use the contact address you want associated with this request.' })}${input('reportRecipient', 'Report recipient name', { maximum: 160, helper: 'If left blank, your contact name will be used.' })}</div>${input('notes', 'What would you like to understand?', { textarea: true, maximum: 1200, placeholder: 'Add context, questions, or specific testing needs.' })}</fieldset><div class="rq-photo-list">${state.samples.map(imageMarkup).join('')}</div>`;
  }

  function reviewMarkup() {
    return `<section class="rq-review"><div class="rq-review-heading"><h3>Samples & analysis</h3><button type="button" data-rq-step="1">Edit samples</button></div><div data-request-private>${state.samples.map((sample, index) => `<article><h4>Sample ${index + 1} · ${escape(sample.name)}</h4><dl><div><dt>Analysis</dt><dd>${escape(SERVICE_NAMES[sample.service])}</dd></div><div><dt>Planned units</dt><dd>${escape(sample.quantity)}</dd></div><div><dt>Form</dt><dd>${escape(SAMPLE_FORMS[sample.form])}</dd></div><div><dt>Product image</dt><dd>${escape(IMAGE_CHOICES[sample.image])}${sample.image === 'include' ? ' · ' + escape(IMAGE_STYLES[sample.imageStyle]) : ''}</dd></div></dl>${previews.has(sample.id) ? `<img class="rq-review-preview" src="${escape(previews.get(sample.id).url)}" alt="Local reference image preview">` : ''}</article>`).join('')}</div><div class="rq-review-heading"><h3>Contact & report</h3><button type="button" data-rq-step="2">Edit contact details</button></div><dl data-request-private><div><dt>Contact</dt><dd>${escape(state.name)}</dd></div><div><dt>Email</dt><dd>${escape(state.email)}</dd></div><div><dt>Report recipient</dt><dd>${escape(effectiveReportRecipient(state))}</dd></div><div><dt>Context</dt><dd>${escape(state.notes || 'No additional notes')}</dd></div></dl></section>`;
  }

  function summaryMarkup() {
    const totals = submissionTotals(state);
    return `<div data-request-private><dl class="rq-totals"><div><dt>Sample entries</dt><dd>${totals.entries}</dd></div><div><dt>Planned units</dt><dd>${totals.units}</dd></div></dl><ol>${state.samples.map((sample, index) => `<li><strong>${escape(sample.name || 'Sample ' + (index + 1))}</strong><span>${escape(SERVICE_NAMES[sample.service] || 'Choose an analysis')}</span><span>${Number.isInteger(Number(sample.quantity)) && Number(sample.quantity) >= 1 && Number(sample.quantity) <= 100 ? escape(sample.quantity) : '—'} ${Number(sample.quantity) === 1 ? 'planned unit' : 'planned units'}</span></li>`).join('')}</ol></div><div class="rq-summary-facts"><p><span>Typical turnaround</span><strong>~1 Week</strong></p><p><span>Pricing</span><strong>By quotation</strong></p></div><p class="rq-helper">Timing, pricing and sample requirements are confirmed by the laboratory.</p>`;
  }

  function updateSummary() { const container = find('rq-summary-content'); if (container) container.innerHTML = summaryMarkup(); }
  function render(focusHeading = false) {
    if (destroyed) return;
    root.innerHTML = `<nav class="rq-progress" aria-label="Request progress"><ol>${titles.map((title, index) => `<li><button type="button" data-rq-step="${index + 1}"${step === index + 1 ? ' aria-current="step"' : ''}${index + 1 > step && (Object.keys(validateSubmissionState(state, 1)).length || index === 2 && Object.keys(validateSubmissionState(state, 2)).length) ? ' disabled' : ''}><span>${index + 1}</span>${title}</button></li>`).join('')}</ol></nav><div class="rq-layout"><div class="rq-main"><p id="rq-notice" class="rq-notice" role="status">${escape(notice)}</p>${notice ? '<button class="rq-fresh" type="button" data-rq-action="fresh">Start a new request</button>' : ''}<form id="request-step-form" novalidate><div class="rq-step-heading"><p>STEP ${step} OF 3</p><h2 id="request-step-heading" tabindex="-1">${titles[step - 1]}</h2></div><p class="rq-error-summary" id="rq-errors" role="alert" tabindex="-1">${escape(saveError || (Object.keys(errors).length ? 'Check the highlighted details before continuing.' : ''))}</p>${step === 1 ? samplesMarkup() : step === 2 ? contactMarkup() : reviewMarkup()}${step === 3 ? '<div class="rq-local-notice"><p><strong>Request draft</strong><span>On this device</span></p><p>Saving does not send your request or email. Saved drafts stay on this device until you clear this site’s browser data. Image files are not retained.</p></div>' : ''}<div class="rq-step-actions">${step > 1 ? '<button class="button button-outline" type="button" data-rq-action="back">Back</button>' : '<a class="rq-back-link" href="/testing-methods">Back to Our Testing</a>'}<button class="button button-teal" type="submit">${step === 3 ? 'Save request' : 'Continue'} <span aria-hidden="true">→</span></button></div></form>${saved ? `<section class="rq-saved" aria-labelledby="rq-saved-title"><p class="rq-saved-state">Draft · Not sent</p><h3 id="rq-saved-title" tabindex="-1">Saved on this device.</h3><p class="rq-saved-reference" data-request-private>${escape(identity.id)}</p><p>No email is sent when a draft is saved.</p><div><button type="button" class="button button-outline" data-rq-action="saved">Saved drafts</button><button type="button" class="text-button" data-rq-action="fresh">Start a new request</button></div></section>` : ''}</div><aside class="rq-summary" aria-labelledby="rq-summary-title"><h2 id="rq-summary-title">Your request</h2><div id="rq-summary-content">${summaryMarkup()}</div></aside></div>`;
    for (const field of root.querySelectorAll('[data-rq-field]')) field.value = getValue(field.dataset.rqField) ?? '';
    if (focusHeading) focus('request-step-heading');
  }

  function validate(targetStep) {
    errors = validateSubmissionState(state, targetStep);
    if (!Object.keys(errors).length) return true;
    if (targetStep === 0) step = Object.keys(validateSubmissionState(state, 1)).length ? 1 : 2;
    render();
    const first = Object.keys(errors)[0];
    if (first === 'samples') focus('request-step-heading');
    else focus(fieldId(first));
    return false;
  }

  function go(target) {
    if (!Number.isInteger(target) || target < 1 || target > 3) return;
    if (target > step && (!validate(1) || target === 3 && !validate(2))) return;
    errors = {}; saveError = ''; step = target; render(true);
  }

  function fresh(service) {
    revokeAll(); state = newSubmission(nextSampleId(), service); step = 1; pristine = true; identity = null; saved = false; errors = {}; saveError = ''; notice = ''; pendingPreset = undefined; render(true);
  }

  function save() {
    if (!validate(0)) return;
    try {
      const raw = storage.getItem(REQUEST_DRAFT_KEY);
      const existing = decodeRequestList(raw);
      if (!existing) throw new Error('Stored drafts cannot be read');
      let nextIdentity = identity;
      if (!nextIdentity) {
        let id;
        for (let attempt = 0; attempt < 8; attempt++) { id = 'AN-REQ-' + makeId().toUpperCase().slice(0, 64); if (!existing.some(item => item?.id === id)) break; id = null; }
        if (!id) throw new Error('A unique local reference could not be created');
        nextIdentity = { id, createdAt: now() };
      }
      const record = createRequestRecord(state, nextIdentity);
      const serialized = prepareRequestSave(raw, record);
      storage.setItem(REQUEST_DRAFT_KEY, serialized);
      if (storage.getItem(REQUEST_DRAFT_KEY) !== serialized) throw new Error('Draft was not persisted');
      identity = nextIdentity; saved = true; pristine = false; saveError = ''; errors = {}; onSaved(record); render(); focus('rq-saved-title');
    } catch { saved = false; saveError = 'We could not save this draft on your device. Your details are still here. Nothing has been sent.'; render(); focus('rq-errors'); }
  }

  function onSubmit(event) {
    if (event.target.id !== 'request-step-form') return;
    event.preventDefault();
    if (step === 3) save();
    else if (validate(step)) { step++; errors = {}; render(true); }
  }

  function onField(event) {
    const field = event.target;
    if (field.dataset.rqFile) {
      if (event.type !== 'change') return;
      const id = field.dataset.rqFile;
      const file = field.files?.[0];
      if (!file || !state.samples.some(sample => sample.id === id)) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size <= 0) { fileErrors.set(id, 'Choose a JPEG, PNG or WebP image up to 5 MiB.'); render(); focus('rq-file-' + id); return; }
      try { const url = objectURLs.createObjectURL(file); revoke(id); previews.set(id, { url }); changed(); render(); focus('rq-file-' + id); }
      catch { fileErrors.set(id, 'This image could not be previewed. Choose another local image.'); render(); focus('rq-file-' + id); }
      return;
    }
    const key = field.dataset.rqField;
    if (!key) return;
    let sample;
    if (key.startsWith('sample:')) { const [, id, name] = key.split(':'); sample = state.samples.find(item => item.id === id); if (!sample) return; sample[name] = field.value; if (name === 'image' && field.value === 'none') revoke(id); }
    else if (['name', 'email', 'company', 'notes', 'reportRecipient'].includes(key)) state[key] = field.value;
    else return;
    changed(); delete errors[key]; field.removeAttribute('aria-invalid'); const fieldError = find(fieldId(key) + '-error'); if (fieldError) fieldError.textContent = '';
    const summary = find('rq-errors'); if (summary) summary.textContent = '';
    if (key.endsWith(':image')) { render(); focus(fieldId(key)); }
    else { updateSummary(); const success = root.querySelector('.rq-saved'); if (success) success.remove(); }
  }

  function onClick(event) {
    const button = event.target.closest('[data-rq-action],[data-rq-step]');
    if (!button || button.disabled) return;
    if (button.dataset.rqStep) { go(Number(button.dataset.rqStep)); return; }
    const action = button.dataset.rqAction;
    const id = button.dataset.rqId;
    if (action === 'back') { step = Math.max(1, step - 1); errors = {}; saveError = ''; render(true); return; }
    if (action === 'fresh') { fresh(pendingPreset); return; }
    if (action === 'saved') { openSavedDrafts(); return; }
    if (action === 'remove-image') { revoke(id); changed(); render(); focus('rq-file-' + id); return; }
    if (action === 'add' && state.samples.length < 10) { state.samples.push(newSample(nextSampleId())); changed(); errors = {}; render(); focus('rq-heading-' + state.samples.at(-1).id); }
    if (action === 'duplicate' && state.samples.length < 10) { const newId = nextSampleId(); state = duplicateSubmissionSample(state, id, newId); changed(); errors = {}; render(); focus('rq-heading-' + newId); }
    if (action === 'remove' && state.samples.length > 1) { const index = state.samples.findIndex(sample => sample.id === id); if (index < 0) return; revoke(id); state.samples.splice(index, 1); changed(); errors = {}; render(); focus('rq-heading-' + state.samples[Math.min(index, state.samples.length - 1)].id); }
  }

  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onField);
  root.addEventListener('change', onField);
  root.addEventListener('click', onClick);
  return Object.freeze({
    activate({ service, reset = false } = {}) {
      if (destroyed) return;
      if (reset) { fresh(service); return; }
      if (Object.hasOwn(SERVICE_NAMES, service)) {
        if (pristine) state.samples[0].service = service;
        else if (state.samples[0].service !== service) { notice = 'Your unfinished request has been kept. The selected service preset was not applied. Start a new request to use a different preset.'; pendingPreset = service; }
      }
      render();
    },
    resume(record) { const parsed = parseRequestRecord(record); if (!parsed) return false; revokeAll(); state = requestStateFromRecord(parsed); identity = { id: parsed.id, createdAt: parsed.createdAt }; step = 1; pristine = false; saved = false; errors = {}; saveError = ''; notice = 'Saved draft opened for editing. Reselect any optional reference images; image files are not saved.'; render(); return true; },
    destroy() { revokeAll(); destroyed = true; root.removeEventListener('submit', onSubmit); root.removeEventListener('input', onField); root.removeEventListener('change', onField); root.removeEventListener('click', onClick); }
  });
}
