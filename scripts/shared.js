/**
 * Shared constants and pure utility functions used across all module files.
 * Kept separate to avoid circular ES-module imports.
 */

export const MODULE_ID = "5e-custom-currency";

export const DEFAULT_CURRENCY_ICON =
    "icons/commodities/currency/coin-embossed-crown-gold.webp";

export const MAX_CUSTOM_CURRENCIES = 5;

export const STANDARD_KEYS = ["cp", "sp", "ep", "gp", "pp"];

// ─── Currency data accessors ──────────────────────────────────────────────────

/** Return the live array of configured custom currencies (never null). */
export function getCustomCurrencies() {
    try {
        return game.settings.get(MODULE_ID, "customCurrencies") ?? [];
    } catch {
        return [];
    }
}

/**
 * Get the CP/GP ratio from the current exchange-rate settings.
 * Falls back to the standard D&D value (100) if settings are unavailable.
 */
export function getCpPerGp() {
    try {
        return (
            game.settings.get(MODULE_ID, "cp-sp") *
            game.settings.get(MODULE_ID, "sp-ep") *
            game.settings.get(MODULE_ID, "ep-gp")
        );
    } catch {
        return 100;
    }
}

// ─── CONFIG patches ───────────────────────────────────────────────────────────

/**
 * Patch CONFIG.DND5E.currencies with the current module settings.
 *
 * Standard currencies get their label/abbreviation updated.
 * Custom currencies are removed then re-added so stale slots are cleaned up.
 * Adding custom currencies to CONFIG means dnd5e item price denomination
 * dropdowns include them automatically.
 */
export function patch_currencyNames() {
    const g = (key) => {
        try { return game.settings.get(MODULE_ID, key); } catch { return null; }
    };

    // Standard currencies
    const map = [
        ["cp", "cpAlt", "cpAltAbrv"],
        ["sp", "spAlt", "spAltAbrv"],
        ["ep", "epAlt", "epAltAbrv"],
        ["gp", "gpAlt", "gpAltAbrv"],
        ["pp", "ppAlt", "ppAltAbrv"],
    ];
    for (const [key, labelKey, abrvKey] of map) {
        if (!CONFIG.DND5E.currencies[key]) continue;
        const label = g(labelKey);
        const abrv  = g(abrvKey);
        if (label) CONFIG.DND5E.currencies[key].label        = label;
        if (abrv)  CONFIG.DND5E.currencies[key].abbreviation = abrv;
    }

    // Remove stale custom entries then re-add active ones
    for (const key of Object.keys(CONFIG.DND5E.currencies)) {
        if (key.startsWith("custom")) delete CONFIG.DND5E.currencies[key];
    }
    for (const curr of getCustomCurrencies()) {
        CONFIG.DND5E.currencies[curr.id] = {
            label:        curr.name,
            abbreviation: curr.abbreviation,
            conversion:   curr.exchangeRate ?? 0,
        };
    }
}

/**
 * Patch the conversion chain for standard currencies.
 * dnd5e 3.x+ uses currencies[key].conversion = "how many of the next-lower
 * denomination equal 1 of this denomination" (cp is the base, conversion = null).
 */
export function patch_currencyConversion() {
    const g = (key) => {
        try { return game.settings.get(MODULE_ID, key); } catch { return null; }
    };
    if (CONFIG.DND5E.currencies.cp) CONFIG.DND5E.currencies.cp.conversion = null;
    if (CONFIG.DND5E.currencies.sp) CONFIG.DND5E.currencies.sp.conversion = g("cp-sp");
    if (CONFIG.DND5E.currencies.ep) CONFIG.DND5E.currencies.ep.conversion = g("sp-ep");
    if (CONFIG.DND5E.currencies.gp) CONFIG.DND5E.currencies.gp.conversion = g("ep-gp");
    if (CONFIG.DND5E.currencies.pp) CONFIG.DND5E.currencies.pp.conversion = g("gp-pp");
}

// ─── Sheet re-render ──────────────────────────────────────────────────────────

/** Re-render all currently open actor sheets so currency changes show live. */
export function rerenderSheets() {
    for (const app of Object.values(ui.windows ?? {})) {
        if (app?.document?.documentName === "Actor") {
            app.render(false);
        }
    }
}
