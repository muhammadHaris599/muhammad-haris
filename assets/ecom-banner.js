/**
 * Ecom Banner – mobile top bar menu.
 * Vanilla JavaScript, no dependencies.
 *
 * On mobile the hamburger opens a panel with the top bar message and
 * "Choose gift" button; the icon switches to a close (×) icon.
 * On desktop the toggle is hidden by CSS and the panel is always shown inline.
 */
(() => {
  'use strict';

  // Avoid re-defining when the theme editor reloads the section.
  if (customElements.get('ecom-topbar')) return;

  class EcomTopbar extends HTMLElement {
    connectedCallback() {
      this.toggle = this.querySelector('[data-menu-toggle]');
      if (!this.toggle) return;

      this.onToggle = this.onToggle.bind(this);
      this.onKeydown = this.onKeydown.bind(this);
      this.toggle.addEventListener('click', this.onToggle);
      this.addEventListener('keydown', this.onKeydown);
    }

    disconnectedCallback() {
      if (!this.toggle) return;
      this.toggle.removeEventListener('click', this.onToggle);
      this.removeEventListener('keydown', this.onKeydown);
    }

    onToggle() {
      this.setOpen(!this.classList.contains('is-open'));
    }

    /** Escape closes the panel and returns focus to the toggle. */
    onKeydown(event) {
      if (event.key !== 'Escape' || !this.classList.contains('is-open')) return;
      this.setOpen(false);
      this.toggle.focus();
    }

    setOpen(isOpen) {
      this.classList.toggle('is-open', isOpen);
      this.toggle.setAttribute('aria-expanded', String(isOpen));
      this.toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    }
  }

  customElements.define('ecom-topbar', EcomTopbar);
})();
