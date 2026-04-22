/**
 * Currency Manager — FormApplication dialog for adding, editing, and
 * removing custom currency slots.
 */

import {
    MODULE_ID,
    DEFAULT_CURRENCY_ICON,
    MAX_CUSTOM_CURRENCIES,
    getCustomCurrencies,
    patch_currencyNames,
    patch_currencyConversion,
    rerenderSheets,
} from "./shared.js";

// Imported lazily at call-sites to avoid circular deps with 5e-custom-currency.js
async function syncItemPilesIfActive() {
    try {
        const { syncItemPiles } = await import("./5e-custom-currency.js");
        await syncItemPiles();
    } catch { /* Item Piles not active or sync failed silently */ }
}

// ─── Application ─────────────────────────────────────────────────────────────

export class CurrencyManagerApp extends FormApplication {

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id:             "5e-custom-currency-manager",
            title:          "Custom Currency Manager",
            template:       `modules/${MODULE_ID}/templates/currency-manager.hbs`,
            width:          740,
            height:         "auto",
            resizable:      true,
            closeOnSubmit:  true,
            submitOnChange: false,
        });
    }

    // ── Data ──────────────────────────────────────────────────────────────────

    getData() {
        const raw = getCustomCurrencies();
        const currencies = raw.map(c => ({
            ...c,
            img:      c.img || DEFAULT_CURRENCY_ICON,
            visAlways: c.visibility === "always",
            visOwned:  c.visibility === "owned",
            visNever:  c.visibility === "never",
        }));
        return {
            currencies,
            canAdd:  currencies.length < MAX_CUSTOM_CURRENCIES,
            maxSlots: MAX_CUSTOM_CURRENCIES,
        };
    }

    // ── Listeners ─────────────────────────────────────────────────────────────

    activateListeners(html) {
        super.activateListeners(html);
        html.find(".currency-add-btn").on("click",    this._onAdd.bind(this));
        html.find(".currency-remove-btn").on("click", this._onRemove.bind(this));
        html.find(".currency-icon-img").on("click",   this._onPickIcon.bind(this));
    }

    // ── Add ───────────────────────────────────────────────────────────────────

    async _onAdd(event) {
        event.preventDefault();
        const currencies = foundry.utils.deepClone(getCustomCurrencies());
        if (currencies.length >= MAX_CUSTOM_CURRENCIES) return;

        // Assign the first unused slot id (custom1 … custom5)
        const used = new Set(currencies.map(c => c.id));
        let nextId;
        for (let i = 1; i <= MAX_CUSTOM_CURRENCIES; i++) {
            if (!used.has(`custom${i}`)) { nextId = `custom${i}`; break; }
        }
        if (!nextId) return;

        currencies.push({
            id:                nextId,
            name:              "New Currency",
            abbreviation:      "CC",
            exchangeRate:      0,
            img:               DEFAULT_CURRENCY_ICON,
            visibility:        "always",
            participateConvert: false,
        });

        await game.settings.set(MODULE_ID, "customCurrencies", currencies);
        this.render();
    }

    // ── Remove ────────────────────────────────────────────────────────────────

    async _onRemove(event) {
        event.preventDefault();
        const id = event.currentTarget.dataset.id;
        const confirmed = await Dialog.confirm({
            title:   "Remove Currency",
            content: `<p>Remove the <strong>${id}</strong> slot? Actors will keep their stored values in flags, but the currency will no longer appear on sheets.</p>`,
        });
        if (!confirmed) return;

        const currencies = getCustomCurrencies().filter(c => c.id !== id);
        await game.settings.set(MODULE_ID, "customCurrencies", currencies);
        patch_currencyNames();
        rerenderSheets();
        await syncItemPilesIfActive();
        this.render();
    }

    // ── Icon picker ───────────────────────────────────────────────────────────

    _onPickIcon(event) {
        event.preventDefault();
        const imgEl   = event.currentTarget;
        const inputEl = imgEl.closest(".currency-icon-cell").querySelector("input[type=hidden]");

        new FilePicker({
            type:     "image",
            current:  imgEl.src,
            callback: (path) => {
                imgEl.src     = path;
                inputEl.value = path;
            },
        }).browse();
    }

    // ── Save ──────────────────────────────────────────────────────────────────

    async _updateObject(event, formData) {
        const existing  = getCustomCurrencies();
        const expanded  = foundry.utils.expandObject(formData);

        const updated = existing.map(curr => {
            const d = expanded[curr.id] ?? {};
            return {
                id:                curr.id,
                name:              String(d.name              ?? curr.name),
                abbreviation:      String(d.abbreviation      ?? curr.abbreviation),
                exchangeRate:      Number(d.exchangeRate      ?? curr.exchangeRate) || 0,
                img:               String(d.img ?? curr.img ?? DEFAULT_CURRENCY_ICON),
                visibility:        String(d.visibility        ?? curr.visibility),
                participateConvert: d.participateConvert === true
                                 || d.participateConvert === "true"
                                 || d.participateConvert === "on",
            };
        });

        await game.settings.set(MODULE_ID, "customCurrencies", updated);

        patch_currencyNames();
        try {
            if (game.settings.get(MODULE_ID, "depCur")) patch_currencyConversion();
        } catch { /* exchange rate settings may not exist yet */ }

        rerenderSheets();
        await syncItemPilesIfActive();
        ui.notifications.info("5e-custom-currency | Custom currencies saved.");
    }
}
