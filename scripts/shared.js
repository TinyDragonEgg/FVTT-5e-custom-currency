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
            // conversion: null = base denomination, not part of the standard chain.
            // (The standard chain cp→sp→ep→gp→pp uses numeric conversion values.)
            conversion:   null,
            // img is read by dnd5e 4.x's sheet to render the coin icon.
            img:          curr.img || DEFAULT_CURRENCY_ICON,
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

// ─── Icon tint helper ────────────────────────────────────────────────────────

/**
 * Convert a hex tint color to a CSS filter string using hue-rotate.
 * The default gold coin icon has a hue of ~38 degrees; we rotate from there.
 * Returns "" when no tint is set or the color is effectively neutral.
 */
export function tintColorToFilter(hexColor) {
    if (!hexColor) return "";
    const r = parseInt(hexColor.slice(1, 3), 16) / 255;
    const g = parseInt(hexColor.slice(3, 5), 16) / 255;
    const b = parseInt(hexColor.slice(5, 7), 16) / 255;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "";

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    if (max !== min) {
        const d = max - min;
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
            case g: h = ((b - r) / d + 2) * 60; break;
            case b: h = ((r - g) / d + 4) * 60; break;
        }
    }
    const BASE_HUE = 38; // approximate hue of the default gold coin icon
    const rotate = Math.round(((h - BASE_HUE) + 360) % 360);
    return rotate === 0 ? "" : `hue-rotate(${rotate}deg)`;
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
