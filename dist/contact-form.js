import { createContactForm } from './contact.js';

const form = document.querySelector('#contact-form');
if (form) createContactForm(form, {
  storage: {
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: key => window.localStorage.removeItem(key)
  },
  clipboard: { writeText: value => navigator.clipboard.writeText(value) }
});
