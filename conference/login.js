import { createAdminI18n } from './admin-i18n.mjs';
const form = document.getElementById('admin-login-form');
const input = document.getElementById('admin-password');
const button = document.getElementById('unlock');
const status = document.getElementById('login-status');
const mode = document.querySelector('meta[name="admin-auth-mode"]').content;
const csrf = document.querySelector('meta[name="admin-auth-csrf"]').content;
const language = createAdminI18n({ browserLanguage: 'en' });
const keys = mode === 'setup' ? ['setupTitle','setupIntro','setupTitle'] : mode === 'login' ? ['loginTitle','loginIntro','unlock'] : ['unavailableTitle','unavailableIntro','unavailable'];
let feedback = mode === 'unavailable' ? { message:'Administrator credential storage is unavailable.' } : null;
function applyLanguage() {
  language.apply(document, keys[0]);
  document.querySelector('.brand span').textContent = language.t('admin');
  document.getElementById('login-title').textContent = language.t(keys[0]);
  document.getElementById('login-intro').textContent = language.t(keys[1]);
  button.textContent = language.t(keys[2]);
  status.textContent = feedback ? feedback.key ? language.t(feedback.key) : language.error(feedback.message,'authFallback') : '';
}
function showFeedback(value) { feedback = value; applyLanguage(); }
applyLanguage();
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!['setup', 'login'].includes(mode) || button.disabled) return;
  button.disabled = true; input.disabled = true; showFeedback({ key:'unlocking' });
  try {
    const response = await fetch('/admin/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: input.value }) });
    const value = await response.json(); input.value = '';
    if (!response.ok) throw new Error(value.error || '');
    location.replace('/admin');
  } catch (error) { showFeedback({ message:error.message }); status.focus(); }
  finally { button.disabled = false; input.disabled = false; input.focus(); }
});
