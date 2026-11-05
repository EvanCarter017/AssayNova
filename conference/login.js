const form = document.getElementById('admin-login-form');
const input = document.getElementById('admin-password');
const button = document.getElementById('unlock');
const status = document.getElementById('login-status');
const mode = document.querySelector('meta[name="admin-auth-mode"]').content;
const csrf = document.querySelector('meta[name="admin-auth-csrf"]').content;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!['setup', 'login'].includes(mode) || button.disabled) return;
  button.disabled = true; input.disabled = true; status.textContent = 'Unlocking administration…';
  try {
    const response = await fetch('/admin/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: input.value }) });
    const value = await response.json();
    input.value = '';
    if (!response.ok) throw new Error(value.error || 'Administration could not be unlocked.');
    location.replace('/admin');
  } catch (error) { status.textContent = error.message; status.focus(); }
  finally { button.disabled = false; input.disabled = false; input.focus(); }
});
