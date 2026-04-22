/**
 * Settings registration.
 * Imports only from shared.js to avoid circular ES-module dependencies.
 */

import {
    MODULE_ID,
    patch_currencyNames,
    patch_currencyConversion,
    rerenderSheets,
} from "./shared.js";

// ─── Visibility choices (used by standard-currency visibility settings) ───────

export const VISIBILITY_CHOICES = {
    always: "Always Visible",
    owned:  "Visible if Non-Zero",
    never:  "Never Visible",
};

// ─── Main registration ────────────────────────────────────────────────────────

export function registerSettings() {
    // ── Custom currency list (managed via the Currency Manager dialog) ────────
    game.settings.register(MODULE_ID, "customCurrencies", {
        scope:   "world",
        config:  false,   // not shown in standard config UI
        default: [],
        type:    Array,
    });

    // ── Settings menu button ──────────────────────────────────────────────────
    // Lazy-import so currency-manager.js is only evaluated after Foundry init.
    game.settings.registerMenu(MODULE_ID, "currencyManager", {
        name:       "5ecc.Manager.MenuName",
        label:      "5ecc.Manager.MenuLabel",
        hint:       "5ecc.Manager.MenuHint",
        icon:       "fas fa-coins",
        type:       class LazyManagerProxy {
            // Foundry instantiates this when the button is clicked.
            // We open the real app instead and immediately close this stub.
            constructor() {
                import("./currency-manager.js").then(({ CurrencyManagerApp }) => {
                    new CurrencyManagerApp().render(true);
                });
            }
            render() {}
        },
        restricted: true,
    });

    // ── Standard currency rename settings ─────────────────────────────────────
    const stdCurrencies = [
        ["cp", "Copper",   "CP"],
        ["sp", "Silver",   "SP"],
        ["ep", "Electrum", "EP"],
        ["gp", "Gold",     "GP"],
        ["pp", "Platinum", "PP"],
    ];
    for (const [key, defaultName, defaultAbrv] of stdCurrencies) {
        game.settings.register(MODULE_ID, key + "Alt", {
            name:    defaultName + " Name",
            scope:   "world",
            config:  true,
            default: defaultName,
            type:    String,
            onChange: () => { patch_currencyNames(); rerenderSheets(); },
        });
        game.settings.register(MODULE_ID, key + "AltAbrv", {
            name:    defaultName + " Abbreviation",
            scope:   "world",
            config:  true,
            default: defaultAbrv,
            type:    String,
            onChange: () => { patch_currencyNames(); rerenderSheets(); },
        });
    }

    // ── Visibility settings for standard currencies ───────────────────────────
    for (const [key, label] of [
        ["cp", "Copper"], ["sp", "Silver"], ["ep", "Electrum"],
        ["gp", "Gold"],   ["pp", "Platinum"],
    ]) {
        game.settings.register(MODULE_ID, key + "Visibility", {
            name:    label + " Visibility",
            hint:    "Control when this denomination row appears on character sheets.",
            scope:   "world",
            config:  true,
            default: "always",
            type:    String,
            choices: VISIBILITY_CHOICES,
            onChange: () => rerenderSheets(),
        });
    }

    // ── Dependent / independent toggle ────────────────────────────────────────
    game.settings.register(MODULE_ID, "depCur", {
        name:  "Dependent Currencies",
        hint:  "When enabled, currencies convert into each other at the configured exchange rates.",
        scope: "world",
        config: true,
        default: true,
        type:  Boolean,
        onChange: () => {
            patch_currencyConversion();
            window.location.reload();
        },
    });

    // ── Exchange-rate settings (only relevant when depCur = true) ─────────────
    _registerExchangeRates();

    console.log("5e-custom-currency | Settings registered");
}

function _registerExchangeRates() {
    // Names are read lazily inside onChange because the alt-name settings are
    // registered just above; the default label is shown at registration time.
    const pairs = [
        ["cp-sp", "Copper → Silver",   10],
        ["sp-ep", "Silver → Electrum",  5],
        ["ep-gp", "Electrum → Gold",    2],
        ["gp-pp", "Gold → Platinum",   10],
    ];
    for (const [key, label, def] of pairs) {
        game.settings.register(MODULE_ID, key, {
            name:    label + " Rate",
            hint:    "How many of the lower denomination equal one of the higher.",
            scope:   "world",
            config:  true,
            default: def,
            type:    Number,
            onChange: () => { patch_currencyConversion(); rerenderSheets(); },
        });
    }
}
