import { buildPrompt, boundedText, sanitizeAddress, sanitizeMarkup, STYLE_PROPERTIES } from './prompt.js';

const actionableSelector = 'button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[data-action]';
const privateSelector = 'input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),.success-details,.reference-box,#panel-requests';
const omitted = '[private or editable content omitted]';

// Keep the intercepted sequence latched through click, regardless of Alt release
// or a long mouse hold. Escape cancels copying while still swallowing that click.
export function primaryGesture(state, type, alt) {
  if (type === 'abandon') return { state: null, intercept: false, copy: false };
  if (type === 'cancel') return { state: state ? { cancelled: true } : null, intercept: false, copy: false };
  if (type === 'pointerdown') return { state: alt ? { cancelled: false } : null, intercept: alt, copy: false };
  if (type === 'mousedown' && alt && !state) state = { cancelled: false };
  const intercept = !!state || alt;
  return { state: type === 'click' ? null : state, intercept, copy: type === 'click' && intercept && !state?.cancelled };
}

export function rendererForView(markers) {
  if (markers.submission) return 'renderSubmission';
  if (markers.report) return 'renderReport';
  if (markers.portal) return 'renderPortal';
  if (markers.success) return 'renderSuccess';
  if (markers.requestDetail) return 'renderRequestDetail';
  return null;
}

function activeRenderer(container) {
  return rendererForView({
    submission: !!container?.querySelector('#submission-form'),
    report: !!container?.querySelector('.report-heading,.report-body'),
    portal: !!container?.querySelector('.portal-toolbar'),
    success: !!container?.querySelector('.success-icon'),
    requestDetail: !!container?.querySelector('.reference-box,.success-details')
  });
}

export function sourceHint(target, metadata) {
  const container = target.closest('#dialog-content');
  if (container && target !== container) {
    const renderer = activeRenderer(container);
    return metadata?.renderers?.[renderer]
      ? { ...metadata.renderers[renderer], note: 'Active view inferred from known DOM markers; function definition only. Copied HTML annotations are ignored.' }
      : { precision: 'unavailable', note: 'Dynamic child: renderer metadata unavailable; do not attribute it to the static dialog shell.' };
  }
  const file = target.getAttribute('data-an-dev-file');
  const line = Number(target.getAttribute('data-an-dev-line'));
  if (file && Number.isInteger(line) && line > 0) return { file, line, precision: 'original HTML opening-tag line', note: 'Served HTML annotation; re-find current source before editing.' };
  return { precision: 'unavailable', note: 'No verified original-source mapping is available for this element.' };
}

function privateContent(element) {
  if (element.closest(privateSelector)) return true;
  const container = element.closest('#dialog-content');
  // Request-detail headings and all other text in this view can include saved form data.
  return !!container && activeRenderer(container) === 'renderRequestDetail';
}

function safeText(element, limit = 360) {
  if (!element || privateContent(element)) return omitted;
  let text = '';
  let visited = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || privateContent(parent) || parent.closest('script,style,noscript,[data-an-dev-tool],[hidden],[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      return style.display === 'none' || style.visibility === 'hidden' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  while (text.length < limit && visited++ < 100) {
    const node = walker.nextNode();
    if (!node) break;
    text += node.textContent + ' ';
  }
  return boundedText(text.replace(/\s+/g, ' ').trim(), limit);
}

function accessibleLabel(element) {
  if (privateContent(element)) {
    // Inputs can still provide a static associated label, never their value.
    if (element.matches('input,textarea,select') && !element.closest('#panel-requests')) {
      return boundedText([...(element.labels || [])].map((label) => safeText(label, 100)).join(' '), 180) || omitted;
    }
    return omitted;
  }
  const references = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
  const referenced = references.map((id) => safeText(document.getElementById(id), 100)).join(' ').trim();
  return boundedText(element.getAttribute('aria-label') || referenced || element.getAttribute('alt') || element.getAttribute('title') || safeText(element, 180), 180);
}

function uniqueSelector(element) {
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1 && document.querySelector(selector) === element; }
    catch { return false; }
  };
  if (element.id && !privateContent(element)) {
    const id = '#' + CSS.escape(element.id);
    if (unique(id)) return { selector: id, selectorUniqueAtCapture: true };
  }
  const parts = [];
  for (let node = element; node && parts.length < 20; node = node.parentElement) {
    let part = CSS.escape(node.localName);
    const classes = [...node.classList].slice(0, 3);
    if (classes.length && !privateContent(node)) part += classes.map((name) => '.' + CSS.escape(name)).join('');
    const siblings = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.localName === node.localName) : [node];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    const selector = parts.join(' > ');
    if (selector.length <= 700 && unique(selector)) return { selector, selectorUniqueAtCapture: true };
  }
  return { selector: 'unavailable (no bounded unique selector)', selectorUniqueAtCapture: false };
}

function describe(element) {
  const privateRegion = privateContent(element);
  return {
    tag: element.localName, id: privateRegion ? '' : element.id,
    classes: privateRegion ? [] : [...element.classList].slice(0, 8),
    role: element.getAttribute('role') || '', accessibleLabel: accessibleLabel(element),
    ...uniqueSelector(element)
  };
}

function htmlExcerpt(target) {
  let count = 0;
  const escapeText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const walk = (node, depth = 0) => {
    if (++count > 40 || depth > 3) return '[subtree omitted]';
    if (node.nodeType === Node.TEXT_NODE) return privateContent(node.parentElement) ? omitted : escapeText(boundedText(node.textContent, 180));
    if (!(node instanceof Element) || node.matches('script,style,noscript,[data-an-dev-tool]')) return '';
    const tag = node.localName;
    const isPrivate = privateContent(node);
    const allowed = isPrivate ? ['role', 'type'] : ['id', 'class', 'role', 'aria-label', 'aria-hidden', 'type', 'name', 'alt', 'title', 'href', 'src', 'width', 'height', 'viewBox', 'd', 'data-action', 'data-tab'];
    const attrs = allowed.filter((name) => node.hasAttribute(name)).map((name) => {
      let value = node.getAttribute(name);
      if (name === 'href' || name === 'src') value = sanitizeAddress(value);
      return ` ${name}="${escapeText(boundedText(value, 180)).replaceAll('"', '&quot;')}"`;
    }).join('');
    const content = isPrivate ? omitted : ['html', 'body', 'main'].includes(tag) ? '[broad container subtree omitted]' : [...node.childNodes].slice(0, 20).map((child) => walk(child, depth + 1)).join('');
    return `<${tag}${attrs}>${content}</${tag}>`;
  };
  return sanitizeMarkup(walk(target));
}

function matchingStyles(target) {
  const rules = [];
  let inaccessible = 0;
  let scanned = 0;
  const inspect = (list, stylesheetPath) => {
    for (const rule of list) {
      if (++scanned > 2000) return;
      if (rule.type === CSSRule.STYLE_RULE) {
        try {
          if (target.matches(rule.selectorText)) {
            const declarations = STYLE_PROPERTIES.filter((name) => rule.style.getPropertyValue(name)).map((name) => `${name}: ${rule.style.getPropertyValue(name)}${rule.style.getPropertyPriority(name) ? ' !important' : ''}`).join('; ');
            if (declarations) rules.push({ path: stylesheetPath, selector: rule.selectorText, declarations });
          }
        } catch { /* Pseudo-elements and unsupported selectors are not exact matches. */ }
      } else if (rule.type === CSSRule.MEDIA_RULE && !matchMedia(rule.conditionText).matches) continue;
      else if (rule.type === CSSRule.SUPPORTS_RULE && !CSS.supports(rule.conditionText)) continue;
      else if (rule.type === CSSRule.IMPORT_RULE) {
        try {
          if (!rule.media.mediaText || matchMedia(rule.media.mediaText).matches) inspect(rule.styleSheet.cssRules, sanitizeAddress(rule.href));
        } catch { inaccessible++; }
      }
      if (rule.cssRules) inspect(rule.cssRules, stylesheetPath);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      if (!sheet.disabled && (!sheet.media.mediaText || matchMedia(sheet.media.mediaText).matches)) inspect(sheet.cssRules, sheet.href ? sanitizeAddress(sheet.href) : '[inline stylesheet]');
    } catch { inaccessible++; }
    if (scanned > 2000) break;
  }
  return { matchingCSS: rules.slice(-8), cssNote: `Matched selectors may be overridden by the cascade; media/supports conditions checked. Scanned at most 2000 rules; inaccessible sheets: ${inaccessible}. Container/scope/layer effects require source review.` };
}

export function collectContext(target, metadata) {
  const style = getComputedStyle(target);
  const bounds = target.getBoundingClientRect();
  const actionable = target.closest(actionableSelector);
  const ancestors = [];
  for (let node = target; node && ancestors.length < 6; node = node.parentElement) {
    ancestors.unshift(privateContent(node) ? node.localName + ' [content omitted]' : boundedText(node.localName + (node.id ? '#' + node.id : '') + [...node.classList].slice(0, 2).map((name) => '.' + name).join(''), 100));
  }
  const section = target.closest('section,article,dialog,header,footer,main');
  const heading = section?.querySelector('h1,h2,h3,h4,h5,h6');
  return {
    address: location.href, projectRoot: metadata?.projectRoot || 'unavailable (metadata not ready)',
    element: describe(target), actionableAncestor: actionable ? describe(actionable) : null,
    breadcrumbs: ancestors, sectionHeading: heading ? safeText(heading, 180) : 'unavailable',
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY },
    targetRect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    source: sourceHint(target, metadata), visibleText: safeText(target), htmlExcerpt: htmlExcerpt(target),
    computedStyle: Object.fromEntries(STYLE_PROPERTIES.map((name) => [name, style.getPropertyValue(name)])),
    ...matchingStyles(target)
  };
}

export function installLocator() {
  const abort = new AbortController();
  let metadata;
  // Preload once. Capture/copy never waits for this request.
  fetch('/__dev/context', { signal: abort.signal, cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('Metadata unavailable');
    return response.json();
  }).then((value) => { metadata = value; }).catch(() => {});

  const host = document.createElement('div');
  host.setAttribute('data-an-dev-tool', '');
  host.setAttribute('popover', 'manual');
  host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;pointer-events:none;overflow:visible;z-index:2147483647;color-scheme:light;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{font:13px/1.5 system-ui,sans-serif;color:#f8fafc}*{box-sizing:border-box}
    [hidden]{display:none!important}.outline{position:fixed;border:2px solid #14b8a6;background:#14b8a615;pointer-events:none}
    .label{position:fixed;max-width:min(460px,94vw);padding:5px 9px;border-radius:5px;background:#0f2638;color:white;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .panel{position:fixed;right:16px;bottom:16px;width:min(620px,calc(100vw - 32px));max-height:85vh;overflow:auto;background:#0f2638;color:#f8fafc;border:1px solid #4b6976;border-radius:10px;padding:16px;box-shadow:0 10px 40px #0005;pointer-events:auto}
    .title{font-weight:700;margin-bottom:8px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}button{font:inherit;cursor:pointer;padding:7px 12px;border-radius:5px;border:1px solid #91b9bf;color:#fff;background:#214657}button:focus-visible,textarea:focus-visible{outline:3px solid #52ddd2;outline-offset:2px}
    textarea{display:block;width:100%;height:min(360px,50vh);resize:vertical;background:white;color:#102735;font:12px/1.5 ui-monospace,monospace;padding:10px;border:1px solid #aac2cb;border-radius:5px}
  </style><div class="outline" hidden></div><div class="label" hidden></div><div class="panel" role="region" aria-label="开发元素选取" hidden><div class="title" role="status" aria-live="polite"></div><textarea readonly aria-label="完整修改提示词" hidden></textarea><div class="actions"><button type="button" class="copy" hidden>复制提示词</button><button type="button" class="select" hidden>全选文本</button><button type="button" class="close">关闭</button></div></div>`;
  const outline = shadow.querySelector('.outline');
  const label = shadow.querySelector('.label');
  const panel = shadow.querySelector('.panel');
  const title = shadow.querySelector('.title');
  const textarea = shadow.querySelector('textarea');
  const copyButton = shadow.querySelector('.copy');
  const selectButton = shadow.querySelector('.select');
  let armed = false;
  let hovered;
  let lastPointer;
  let gesture;
  let prompt = '';
  let frame;
  let feedbackTimer;
  let previousFocus;
  let disposed = false;

  const mount = () => {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const parent = dialogs.at(-1) || document.body;
    if (host.parentElement !== parent) {
      if (host.matches(':popover-open')) host.hidePopover();
      parent.append(host);
    }
    if ((armed || !panel.hidden) && !host.matches(':popover-open')) {
      try { host.showPopover(); } catch { /* z-index fallback remains inside the active modal. */ }
    }
  };
  const hideIfIdle = () => {
    if (!armed && panel.hidden && host.matches(':popover-open')) host.hidePopover();
  };
  const clearHover = () => {
    armed = false;
    hovered = null;
    outline.hidden = true;
    label.hidden = true;
    hideIfIdle();
  };
  const closeFeedback = () => {
    clearTimeout(feedbackTimer);
    panel.hidden = true;
    textarea.value = '';
    prompt = '';
    hideIfIdle();
    if (previousFocus?.isConnected && shadow.activeElement) previousFocus.focus({ preventScroll: true });
  };
  const draw = () => {
    frame = undefined;
    if (!armed || !hovered?.isConnected) { outline.hidden = true; label.hidden = true; return; }
    mount();
    const rect = hovered.getBoundingClientRect();
    outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    outline.hidden = false;
    label.textContent = `${hovered.localName}${privateContent(hovered) ? '' : hovered.id ? '#' + boundedText(hovered.id, 60) : ''} · Alt + 左键复制修改提示词 · Esc 取消`;
    label.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - 360))}px`;
    label.style.top = `${Math.max(4, Math.min(rect.top - 32, innerHeight - 32))}px`;
    label.hidden = false;
  };
  const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };
  const feedback = (message, manual = false) => {
    if (disposed) return;
    clearTimeout(feedbackTimer);
    title.textContent = message;
    panel.hidden = false;
    textarea.hidden = copyButton.hidden = selectButton.hidden = !manual;
    textarea.value = manual ? prompt : '';
    mount();
    if (manual) {
      previousFocus = document.activeElement;
      textarea.focus({ preventScroll: true });
      textarea.select();
    } else feedbackTimer = setTimeout(closeFeedback, 3000);
  };
  const copy = () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // Called directly in a trusted click; there is no await before writeText.
      const pendingCopy = navigator.clipboard.writeText(prompt);
      Promise.resolve(pendingCopy).then(() => feedback('已复制。粘贴到 Codex 后，只需填写希望修改的内容。'))
        .catch(() => feedback('自动复制失败。请全选并手动复制下面的完整提示词。', true));
    } catch { feedback('当前浏览器无法自动复制。请全选并手动复制下面的完整提示词。', true); }
  };
  const toolEvent = (event) => event.composedPath().includes(host);
  const altGesture = (event) => event.altKey && !event.ctrlKey && !event.metaKey && !event.getModifierState?.('AltGraph');
  const on = (target, type, listener, options = {}) => target.addEventListener(type, listener, { ...options, signal: abort.signal });

  on(window, 'keydown', (event) => {
    if (event.key === 'Escape' && (armed || gesture || !panel.hidden)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearHover();
      closeFeedback();
      gesture = primaryGesture(gesture, 'cancel', false).state;
    } else if (event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.getModifierState('AltGraph')) {
      event.preventDefault();
      armed = true;
      if (lastPointer) {
        const target = document.elementFromPoint(lastPointer.x, lastPointer.y);
        if (target && !host.contains(target)) hovered = target;
      }
      mount();
      redraw();
    } else if (event.ctrlKey || event.metaKey || (event.altKey && event.key !== 'Alt')) clearHover();
  }, { capture: true });
  on(window, 'keyup', (event) => {
    if (event.key === 'Alt') {
      if (armed || gesture) event.preventDefault();
      clearHover();
      // A previously intercepted primary gesture stays latched through click.
    }
  }, { capture: true });
  on(window, 'pointermove', (event) => {
    if (toolEvent(event)) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!altGesture(event)) { clearHover(); return; }
    armed = true;
    const target = event.composedPath()[0];
    if (target instanceof Element) { hovered = target; redraw(); }
  }, { capture: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
    on(window, type, (event) => {
      if (toolEvent(event) || event.button !== 0) return;
      const decision = primaryGesture(gesture, type, altGesture(event));
      gesture = decision.state;
      if (!decision.intercept) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!decision.copy) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element)) return;
      try { prompt = buildPrompt(collectContext(target, metadata)); copy(); }
      catch { feedback('暂时无法读取这个元素，请选择其他元素或刷新开发预览。'); }
      clearHover();
    }, { capture: true });
  }
  on(window, 'blur', () => { clearHover(); gesture = null; });
  on(window, 'pointercancel', () => { clearHover(); gesture = null; }, { capture: true });
  on(window, 'scroll', redraw, { capture: true, passive: true });
  on(window, 'resize', redraw, { passive: true });
  on(copyButton, 'click', copy);
  on(selectButton, 'click', () => { textarea.focus(); textarea.select(); title.textContent = '文本已全选，请使用 Ctrl+C 或系统复制菜单。'; });
  on(shadow.querySelector('.close'), 'click', closeFeedback);
  const observer = new MutationObserver(() => {
    if (armed || !panel.hidden) mount();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  mount();
  return () => {
    disposed = true;
    abort.abort();
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(feedbackTimer);
    host.remove();
  };
}
