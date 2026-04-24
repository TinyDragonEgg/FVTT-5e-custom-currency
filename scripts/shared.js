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
            // dnd5e generates CSS `background-image: url("${icon}")` from this field.
            // Keep img as an alias in case any older code path reads it.
            icon:         curr.img || DEFAULT_CURRENCY_ICON,
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

// ─── Dynamic icon CSS ─────────────────────────────────────────────────────────

/**
 * Inject (or replace) a <style> block that fixes dnd5e 5.x's generated CSS for
 * custom currency <i> elements:
 *   - Removes the dark background dnd5e applies to coin icon slots
 *   - Applies the user-configured hue-rotate tint filter
 *
 * dnd5e generates `.currency.{key} { background-image: url("...") }` from
 * CONFIG at the setup hook.  We run AFTER that and override/extend it here.
 */
export function injectCurrencyIconCSS() {
    const STYLE_ID = `${MODULE_ID}-icon-styles`;
    document.getElementById(STYLE_ID)?.remove();

    const customs = getCustomCurrencies();
    if (!customs.length) return;

    const rules = customs.map(curr => {
        const filter = tintColorToFilter(curr.tintColor);
        // mix-blend-mode: screen dissolves dark/black backgrounds — black pixels
        // become transparent against dnd5e's dark UI, leaving only the coin visible.
        // Combine drop-shadow (matching dnd5e's own coin style) with any tint filter.
        const filterVal = [
            "drop-shadow(0 0 1px black)",
            ...(filter ? [filter] : []),
        ].join(" ");
        return `
.dnd5e2 i.currency.${curr.id} {
    background-color: transparent !important;
    background-size: contain;
    background-repeat: no-repeat;
    background-position: center;
    mix-blend-mode: screen;
    filter: ${filterVal};
}`;
    }).join("\n");

    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = rules;
    document.head.appendChild(el);
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
