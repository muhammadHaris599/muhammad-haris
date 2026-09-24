/**
 * Ecom Product Grid – quick-view popup and add to cart.
 * Vanilla JavaScript, no dependencies.
 *
 * Flow:
 *   1. A hotspot is clicked → read that tile's inline product JSON.
 *   2. Render title, price, description, image and one picker per product option
 *      (colour options → button row, everything else → dropdown).
 *   3. Each pick updates the selected variant (price, image, availability).
 *   4. "Add to cart" posts to the Ajax Cart API. If the variant contains every
 *      trigger value (default: Black + Medium), the bonus product
 *      (Soft Winter Jacket) is added in the same request.
 *   5. The header cart count is refreshed with the Section Rendering API.
 */
(() => {
  'use strict';

  // Avoid re-defining when the theme editor reloads the section.
  if (customElements.get('ecom-product-grid')) return;

  /** Option names shown as a colour button row. Anything else becomes a dropdown. */
  const COLOR_OPTION_NAMES = ['color', 'colour'];

  /**
   * Swatch colours from the Figma design, used when a value has no Shopify
   * swatch colour set (Products → Options → Color → swatch).
   */
  const FIGMA_SWATCHES = {
    red: '#b20f36',
    grey: '#afafb7',
    gray: '#afafb7',
    blue: '#0d499f',
    black: '#000000',
    white: '#ffffff',
  };

  /** Section id of Dawn's cart count bubble, refreshed after adding to cart. */
  const CART_BUBBLE_SECTION = 'cart-icon-bubble';

  const TEXT = {
    addToCart: 'Add to cart',
    adding: 'Adding…',
    added: 'Added to cart',
    soldOut: 'Sold out',
    unavailable: 'This combination is not available.',
    choose: (name) => `Choose your ${name.toLowerCase()}`,
    missing: (name) => `Please choose a ${name.toLowerCase()}.`,
    genericError: 'Could not add to cart. Please try again.',
  };

  const CHEVRON_SVG =
    '<svg width="14" height="8" viewBox="0 0 14 8" fill="none" aria-hidden="true" focusable="false">' +
    '<path d="M1 1l6 6 6-6" stroke="currentColor" stroke-width="1.2"/></svg>';

  /* ------------------------------------------------------------------------
     Helpers
     ------------------------------------------------------------------------ */

  /** Escapes a string for safe use inside HTML text or attributes. */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  /** True for option names that should render as a colour button row. */
  function isColorOption(name) {
    return COLOR_OPTION_NAMES.includes(name.toLowerCase());
  }

  /** Turns product description HTML into plain text (DOMParser never runs scripts). */
  function stripHtml(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  }

  /**
   * Formats a price in cents with the shop's money format,
   * e.g. "{{amount_with_comma_separator}}€" → "980,00€".
   */
  function formatMoney(cents, format) {
    const build = (decimals, thousands, decimal) => {
      const [whole, fraction] = (cents / 100).toFixed(decimals).split('.');
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return fraction ? `${grouped}${decimal}${fraction}` : grouped;
    };
    const formatters = {
      amount: () => build(2, ',', '.'),
      amount_no_decimals: () => build(0, ',', '.'),
      amount_with_comma_separator: () => build(2, '.', ','),
      amount_no_decimals_with_comma_separator: () => build(0, '.', ','),
      amount_with_apostrophe_separator: () => build(2, "'", '.'),
      amount_with_space_separator: () => build(2, ' ', ','),
    };
    return format.replace(/\{\{\s*(\w+)\s*\}\}/, (_, key) => (formatters[key] || formatters.amount)());
  }

  /* ------------------------------------------------------------------------
     Custom element
     ------------------------------------------------------------------------ */

  class EcomProductGrid extends HTMLElement {
    connectedCallback() {
      this.popup = this.querySelector('[data-popup]');
      this.dialog = this.querySelector('[data-popup-dialog]');
      this.els = {
        image: this.querySelector('[data-popup-image]'),
        title: this.querySelector('[data-popup-title]'),
        price: this.querySelector('[data-popup-price]'),
        description: this.querySelector('[data-popup-description]'),
        options: this.querySelector('[data-popup-options]'),
        error: this.querySelector('[data-popup-error]'),
        atc: this.querySelector('[data-add-to-cart]'),
        atcLabel: this.querySelector('[data-atc-label]'),
      };

      this.moneyFormat = this.dataset.moneyFormat || '{{amount}}';
      this.bonusVariantId = Number(this.dataset.bonusVariantId) || null;
      this.triggerValues = (this.dataset.triggerValues || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);

      this.product = null; // product currently shown in the popup
      this.selected = [];  // selected value per option index (null = not chosen)
      this.opener = null;  // element to return focus to when the popup closes

      this.onClick = this.onClick.bind(this);
      this.onKeydown = this.onKeydown.bind(this);
      this.onDocumentClick = this.onDocumentClick.bind(this);
      this.addEventListener('click', this.onClick);
    }

    disconnectedCallback() {
      this.removeEventListener('click', this.onClick);
      document.removeEventListener('keydown', this.onKeydown);
      document.removeEventListener('click', this.onDocumentClick);
      document.documentElement.classList.remove('ecom-popup-open');
    }

    /* ---------------------------- Events -------------------------------- */

    /** One delegated listener handles every click inside the section. */
    onClick(event) {
      const target = event.target;

      const hotspot = target.closest('[data-open-popup]');
      if (hotspot) return this.open(hotspot);

      if (target.closest('[data-close-popup]')) return this.close();

      const valueButton = target.closest('[data-option-value]');
      if (valueButton) {
        return this.selectValue(Number(valueButton.dataset.optionIndex), valueButton.dataset.optionValue);
      }

      const dropdownToggle = target.closest('[data-dropdown-toggle]');
      if (dropdownToggle) return this.toggleDropdown(dropdownToggle.closest('[data-dropdown]'));

      if (target.closest('[data-add-to-cart]')) return this.addToCart();

      // Any other click inside the popup closes an open dropdown.
      this.closeDropdowns();
    }

    /**
     * While the popup is open, a click anywhere outside the dialog closes it
     * (overlay, header, other tiles…). The hotspot that opened it is ignored.
     */
    onDocumentClick(event) {
      if (this.dialog.contains(event.target)) return;
      if (event.target.closest('[data-open-popup]')) return;
      this.close();
    }

    onKeydown(event) {
      if (event.key === 'Escape') {
        // First Escape closes an open dropdown, the next one closes the popup.
        if (this.querySelector('[data-dropdown].is-open')) this.closeDropdowns(true);
        else this.close();
        return;
      }
      if (event.key === 'Tab') this.trapFocus(event);
    }

    /** Keeps keyboard focus inside the dialog while it is open. */
    trapFocus(event) {
      const focusable = [...this.dialog.querySelectorAll('button:not([disabled]), [href]')]
        .filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    /* ------------------------- Open / close ----------------------------- */

    open(hotspot) {
      const json = hotspot.closest('.ecom-grid__item').querySelector('[data-product-json]');
      if (!json) return;

      this.product = JSON.parse(json.textContent);
      // Options with a single value (e.g. only one size) are pre-selected.
      this.selected = this.product.options.map((_, index) => {
        const values = this.getOptionValues(index);
        return values.length === 1 ? values[0] : null;
      });

      this.renderProduct();
      this.renderOptions();
      this.hideError();
      this.update();

      this.opener = hotspot;
      this.popup.hidden = false;
      document.documentElement.classList.add('ecom-popup-open');
      document.addEventListener('keydown', this.onKeydown);
      document.addEventListener('click', this.onDocumentClick);
      this.dialog.focus();
    }

    close() {
      if (this.popup.hidden) return;
      this.popup.hidden = true;
      document.documentElement.classList.remove('ecom-popup-open');
      document.removeEventListener('keydown', this.onKeydown);
      document.removeEventListener('click', this.onDocumentClick);
      if (this.opener) this.opener.focus();
    }

    /* --------------------------- Rendering ------------------------------ */

    renderProduct() {
      const { title, description } = this.product;
      this.els.title.textContent = title;
      this.els.description.textContent = stripHtml(description);
      this.els.image.alt = title;
      this.setImage(this.product.image);
    }

    setImage(src) {
      const { image } = this.els;
      image.hidden = !src;
      if (src) {
        image.src = src; // already sized to 240px (2× display width) in Liquid
      } else {
        image.removeAttribute('src');
      }
    }

    /** Builds one picker per option straight from the product data. */
    renderOptions() {
      const sectionId = this.dataset.sectionId;

      // Design order: colour picker first, then the other options.
      // Indexes are kept so every picker still maps to the right variant option.
      const ordered = this.product.options
        .map((name, index) => ({ name, index, isColor: isColorOption(name) }))
        .sort((a, b) => Number(b.isColor) - Number(a.isColor));

      this.els.options.innerHTML = ordered.map(({ name, index, isColor }) => {
        const values = this.getOptionValues(index);
        // Products without variants have a single hidden "Default Title" option.
        if (values.length === 1 && values[0] === 'Default Title') return '';

        const labelId = `EcomOption-${sectionId}-${index}`;
        const picker = isColor
          ? this.colorTemplate(index, values, labelId)
          : this.dropdownTemplate(index, name, values, labelId);

        return `
          <div class="ecom-option">
            <p class="ecom-option__label" id="${labelId}">${escapeHtml(name)}</p>
            ${picker}
          </div>`;
      }).join('');

      // Reflect any pre-selected single-value options in the UI.
      this.selected.forEach((value, index) => {
        if (value !== null) this.syncOptionUI(index);
      });
    }

    colorTemplate(index, values, labelId) {
      const buttons = values.map((value) => `
        <button
          type="button"
          class="ecom-swatches__item"
          role="radio"
          aria-checked="false"
          data-option-index="${index}"
          data-option-value="${escapeHtml(value)}"
          style="--swatch: ${escapeHtml(this.getSwatchColor(value))}"
        >${escapeHtml(value)}</button>`).join('');

      return `<div class="ecom-swatches" role="radiogroup" aria-labelledby="${labelId}">${buttons}</div>`;
    }

    dropdownTemplate(index, name, values, labelId) {
      const options = values.map((value) => `
        <li role="none">
          <button
            type="button"
            class="ecom-dropdown__option"
            role="option"
            aria-selected="false"
            data-option-index="${index}"
            data-option-value="${escapeHtml(value)}"
          >${escapeHtml(value)}</button>
        </li>`).join('');

      return `
        <div class="ecom-dropdown" data-dropdown data-dropdown-index="${index}">
          <button
            type="button"
            class="ecom-dropdown__toggle"
            data-dropdown-toggle
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-labelledby="${labelId} ${labelId}-value"
          >
            <span class="ecom-dropdown__value" id="${labelId}-value" data-dropdown-value>${escapeHtml(TEXT.choose(name))}</span>
            <span class="ecom-dropdown__icon">${CHEVRON_SVG}</span>
          </button>
          <ul class="ecom-dropdown__list" role="listbox" aria-labelledby="${labelId}" hidden>${options}</ul>
        </div>`;
    }

    /* --------------------------- Dropdowns ------------------------------ */

    toggleDropdown(dropdown) {
      const willOpen = !dropdown.classList.contains('is-open');
      this.closeDropdowns();
      if (!willOpen) return;

      dropdown.classList.add('is-open');
      dropdown.querySelector('[data-dropdown-toggle]').setAttribute('aria-expanded', 'true');
      const list = dropdown.querySelector('[role="listbox"]');
      list.hidden = false;
      (list.querySelector('.is-selected') || list.querySelector('button')).focus();
    }

    /** Closes every open dropdown. Optionally returns focus to its toggle. */
    closeDropdowns(returnFocus = false) {
      this.querySelectorAll('[data-dropdown].is-open').forEach((dropdown) => {
        const toggle = dropdown.querySelector('[data-dropdown-toggle]');
        dropdown.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        dropdown.querySelector('[role="listbox"]').hidden = true;
        if (returnFocus) toggle.focus();
      });
    }

    /* --------------------------- Selection ------------------------------ */

    selectValue(index, value) {
      const dropdownWasOpen = Boolean(this.querySelector(`[data-dropdown-index="${index}"].is-open`));
      this.selected[index] = value;
      this.syncOptionUI(index);
      this.closeDropdowns(dropdownWasOpen);
      this.hideError();
      this.update();
    }

    /** Marks the chosen value as selected in the picker for one option. */
    syncOptionUI(index) {
      const value = this.selected[index];

      this.els.options.querySelectorAll(`[data-option-index="${index}"]`).forEach((el) => {
        const isSelected = el.dataset.optionValue === value;
        const ariaAttr = el.getAttribute('role') === 'radio' ? 'aria-checked' : 'aria-selected';
        el.classList.toggle('is-selected', isSelected);
        el.setAttribute(ariaAttr, String(isSelected));
      });

      const dropdownValue = this.els.options.querySelector(
        `[data-dropdown-index="${index}"] [data-dropdown-value]`
      );
      if (dropdownValue) dropdownValue.textContent = value;
    }

    /**
     * Swatch colour for an option value, in order of preference:
     * Shopify swatch set on the product → Figma palette → the value as a CSS colour name.
     */
    getSwatchColor(value) {
      const key = value.toLowerCase();
      return (this.product.swatches || {})[value]
        || FIGMA_SWATCHES[key]
        || key.replace(/\s+/g, '');
    }

    /** Unique values of one option, in the order Shopify lists the variants. */
    getOptionValues(index) {
      return [...new Set(this.product.variants.map((variant) => variant.options[index]))];
    }

    /** The variant matching every selected value, or null if something is missing. */
    getSelectedVariant() {
      if (this.selected.includes(null)) return null;
      return this.product.variants.find((variant) =>
        variant.options.every((value, index) => value === this.selected[index])
      ) || null;
    }

    /** Refreshes price, image and button state for the current selection. */
    update() {
      const variant = this.getSelectedVariant();
      const price = variant ? variant.price : this.product.price;
      this.els.price.textContent = formatMoney(price, this.moneyFormat);

      if (variant && variant.image) this.setImage(variant.image);

      const soldOut = variant ? !variant.available : !this.product.available;
      this.els.atc.disabled = soldOut;
      this.els.atcLabel.textContent = soldOut ? TEXT.soldOut : TEXT.addToCart;
    }

    /* -------------------------- Add to cart ----------------------------- */

    /** True when the variant contains every trigger value (e.g. Black + Medium). */
    shouldAddBonus(variant) {
      if (!this.bonusVariantId || !this.triggerValues.length) return false;
      if (variant.id === this.bonusVariantId) return false; // never add the jacket to itself
      const values = variant.options.map((value) => value.toLowerCase());
      return this.triggerValues.every((trigger) => values.includes(trigger));
    }

    async addToCart() {
      const missingIndex = this.selected.indexOf(null);
      if (missingIndex !== -1) {
        return this.showError(TEXT.missing(this.product.options[missingIndex]));
      }

      const variant = this.getSelectedVariant();
      if (!variant || !variant.available) return this.showError(TEXT.unavailable);

      const items = [{ id: variant.id, quantity: 1 }];
      if (this.shouldAddBonus(variant)) items.push({ id: this.bonusVariantId, quantity: 1 });

      this.setLoading(true);
      try {
        const response = await fetch(this.dataset.cartAddUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            items,
            sections: CART_BUBBLE_SECTION,
            sections_url: window.location.pathname,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.description || data.message || TEXT.genericError);

        this.updateCartBubble(data.sections);
        this.dispatchEvent(new CustomEvent('ecom:cart-added', { bubbles: true, detail: { items } }));
        this.setLoading(false, TEXT.added);
        setTimeout(() => this.close(), 900);
      } catch (error) {
        this.setLoading(false);
        this.showError(error.message || TEXT.genericError);
      }
    }

    /** Replaces the header cart count with fresh HTML from the add response. */
    updateCartBubble(sections) {
      const bubble = document.getElementById(CART_BUBBLE_SECTION);
      const html = sections && sections[CART_BUBBLE_SECTION];
      if (!bubble || !html) return;

      const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('.shopify-section');
      if (fresh) bubble.innerHTML = fresh.innerHTML;
    }

    setLoading(isLoading, label) {
      const { atc, atcLabel } = this.els;
      atc.disabled = isLoading;
      atc.classList.toggle('is-loading', isLoading);
      atc.setAttribute('aria-busy', String(isLoading));
      atcLabel.textContent = label || (isLoading ? TEXT.adding : TEXT.addToCart);
    }

    showError(message) {
      this.els.error.textContent = message;
      this.els.error.hidden = false;
    }

    hideError() {
      this.els.error.textContent = '';
      this.els.error.hidden = true;
    }
  }

  customElements.define('ecom-product-grid', EcomProductGrid);
})();
