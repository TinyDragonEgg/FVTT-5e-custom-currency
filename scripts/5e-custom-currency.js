/**
 * 5E Custom Currency — main module entry point.
 * Registers hooks and implements all sheet/system integrations.
 */

import { registerSettings }    from "./settings.js";
import {
    MODULE_ID,
    DEFAULT_CURRENCY_ICON,
    STANDARD_KEYS,
    getCustomCurrencies,
    getCpPerGp,
    patch_currencyNames,
    patch_currencyConversion,
} from "./shared.js";

// ─── Utilities ────────────────────────────────────────────────────────────────

/** ApplicationV2 (V13) passes HTMLElement; FormApplication passes jQuery. */
function normaliseHtml(html) {
    return html instanceof HTMLElement ? $(html) : html;
}

/** Resolve the Actor from a sheet regardless of Foundry version. */
function actorFromSheet(sheet) {
    return sheet.actor ?? sheet.document ?? sheet.object ?? null;
}

/** Convenience wrapper for reading module settings. */
function g(key) {
    try { return game.settings.get(MODULE_ID, key); } catch { return null; }
}

// ─── Standard-currency helpers ────────────────────────────────────────────────

/**
 * Rename denomination abbreviation labels on an already-rendered sheet.
 * Uses multi-class selectors (.denomination.pp) rather than the fragile
 * exact-attribute form so extra classes from themes don't break matching.
 */
function alterCharacterCurrency(html) {
    for (const key of STANDARD_KEYS) {
        const abrv = g(key + "AltAbrv");
        if (abrv) html.find(`.denomination.${key}`).text(abrv);
    }
}

/**
 * Hide standard denomination rows whose visibility setting is not satisfied.
 * "always" → always show  |  "owned" → only if > 0  |  "never" → always hide
 */
function applyStandardVisibility(html, actor) {
    for (const key of STANDARD_KEYS) {
        const vis    = g(key + "Visibility") ?? "always";
        if (vis === "always") continue;
        const amount = actor?.system?.currency?.[key] ?? 0;
        if (vis === "never" || (vis === "owned" && amount <= 0)) {
            html.find(`.currency-item.${key}, li.currency.${key}`).hide();
        }
    }
}

// ─── Custom-currency sheet injection ─────────────────────────────────────────

/**
 * Inject custom currency rows into the character sheet currency bar.
 *
 * Supports both the dnd5e V1 sheet  (ol.currency-list → li.currency-item)
 * and the V2 sheet                   (ul.currency      → li.currency).
 * Values come from actor flags; icons are per-currency user-configurable.
 */
function injectCustomCurrencies(html, actor) {
    const container = html.find("ol.currency-list, ul.currency").first();
    if (!container.length) return;

    const isV2 = container.is("ul");

    for (const curr of getCustomCurrencies()) {
        const vis    = curr.visibility ?? "always";
        const amount = actor?.getFlag(MODULE_ID, curr.id) ?? 0;

        if (vis === "never") continue;
        if (vis === "owned" && amount <= 0) continue;

        const imgSrc = curr.img || DEFAULT_CURRENCY_ICON;

        const li = isV2
            ? $(`<li class="currency ${curr.id} custom-currency" aria-label="${curr.name}">
                    <img  class="currency-custom-icon" src="${imgSrc}" title="${curr.name}">
                    <input class="uninput" type="number"
                           data-flag-currency="${curr.id}"
                           value="${amount}" placeholder="--">
                    <span class="denomination ${curr.id}" aria-hidden="true">${curr.abbreviation}</span>
                 </li>`)
            : $(`<li class="currency-item ${curr.id} custom-currency">
                    <img  class="currency-custom-icon" src="${imgSrc}" title="${curr.name}">
                    <input type="number"
                           data-flag-currency="${curr.id}"
                           value="${amount}" placeholder="0" min="0">
                    <span class="denomination ${curr.id}">${curr.abbreviation}</span>
                 </li>`);

        container.append(li);
    }
}

/**
 * Wire up change events on injected custom currency inputs so that editing
 * a value persists it to actor flags immediately.
 */
function bindCustomCurrencyInputs(html, actor) {
    html.find("[data-flag-currency]").on("change", function () {
        const key   = $(this).data("flag-currency");
        const value = parseInt($(this).val()) || 0;
        actor.setFlag(MODULE_ID, key, value);
    });
}

// ─── Wealth total ─────────────────────────────────────────────────────────────

/**
 * Append a small "Total wealth: X GP" line below the currency bar.
 * Includes custom currencies that have a non-zero exchange rate.
 */
function injectWealthTotal(html, actor) {
    if (!actor) return;

    let totalGp = 0;

    // Standard currencies (only if depCur is true)
    if (g("depCur")) {
        const cpPerGp = getCpPerGp();
        const cur = actor.system?.currency ?? {};
        totalGp += (cur.pp ?? 0) * (g("gp-pp")  ?? 10);
        totalGp += (cur.gp ?? 0);
        totalGp += (cur.ep ?? 0) / (g("ep-gp")  ?? 2);
        totalGp += (cur.sp ?? 0) / ((g("sp-ep") ?? 5) * (g("ep-gp") ?? 2));
        totalGp += (cur.cp ?? 0) / cpPerGp;
    }

    // Custom currencies with an exchange rate
    for (const curr of getCustomCurrencies()) {
        if (!curr.exchangeRate) continue;
        const amount = actor.getFlag(MODULE_ID, curr.id) ?? 0;
        totalGp += amount * curr.exchangeRate;
    }

    if (totalGp <= 0) return;

    const gpLabel = g("gpAlt") ?? "GP";
    const line    = $(`<div class="currency-wealth-total">
        Total wealth: ${totalGp.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${gpLabel}
    </div>`);

    html.find("ol.currency-list, ul.currency").first().after(line);
}

// ─── Convert currency override ────────────────────────────────────────────────

/**
 * Override Actor5e.convertCurrency to fold participating custom currencies
 * into the CP pool before the standard chain runs.
 *
 * Conversion: custom amount × exchangeRate (GP/coin) × cpPerGp = CP value.
 * This lets the standard chain (cp→sp→ep→gp→pp) handle rounding naturally.
 */
export function patchConvertCurrency() {
    const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
    if (!ActorClass?.prototype?.convertCurrency) return;

    const original = ActorClass.prototype.convertCurrency;

    ActorClass.prototype.convertCurrency = async function () {
        // Skip custom-currency folding when currencies are independent
        if (!game.settings.get(MODULE_ID, "depCur")) {
            return original.call(this);
        }

        const customs = getCustomCurrencies().filter(
            c => c.participateConvert && c.exchangeRate > 0
        );
        if (customs.length === 0) return original.call(this);

        const cpPerGp  = getCpPerGp();
        const updates  = {};

        for (const curr of customs) {
            const amount = this.getFlag(MODULE_ID, curr.id) ?? 0;
            if (amount <= 0) continue;

            // Convert to CP and add to the CP pool; the standard chain takes it from there
            const cpGain = Math.round(amount * curr.exchangeRate * cpPerGp);
            updates[`flags.${MODULE_ID}.${curr.id}`] = 0;
            updates["system.currency.cp"] =
                (updates["system.currency.cp"] ?? this.system?.currency?.cp ?? 0) + cpGain;
        }

        if (Object.keys(updates).length > 0) await this.update(updates);

        return original.call(this);
    };

    console.log("5e-custom-currency | Patched convertCurrency");
}

// ─── Item Piles optional sync ─────────────────────────────────────────────────

/**
 * Sync our custom currencies into Item Piles' currency list.
 * Called only when Item Piles is active and the current user is GM.
 * We add/update our entries and leave all other Item Piles currencies intact.
 */
export async function syncItemPiles() {
    if (!game.modules.get("item-piles")?.active) return;
    if (!game.user?.isGM) return;
    if (!game.itempiles?.API?.setCurrencies) return;

    const customs = getCustomCurrencies();

    // Strip previously injected entries so we can replace them cleanly
    const existing = game.itempiles.API.CURRENCIES.filter(
        c => !c.data?.path?.startsWith(`flags.${MODULE_ID}`)
    );

    const entries = customs.map(curr => ({
        type:         "attribute",
        name:         curr.name,
        img:          curr.img || DEFAULT_CURRENCY_ICON,
        abbreviation: `{#}${curr.abbreviation}`,
        data:         { path: `flags.${MODULE_ID}.${curr.id}` },
        primary:      false,
        exchangeRate: curr.exchangeRate ?? 0,
    }));

    try {
        await game.itempiles.API.setCurrencies([...existing, ...entries]);
        console.log("5e-custom-currency | Synced custom currencies to Item Piles");
    } catch (err) {
        console.warn("5e-custom-currency | Item Piles sync failed:", err);
    }
}

// ─── Shared character-sheet handler ──────────────────────────────────────────

function handleCharacterSheet(sheet, html) {
    html = normaliseHtml(html);
    const actor = actorFromSheet(sheet);

    if (!g("depCur")) removeConvertCurrency(html);

    alterCharacterCurrency(html);

    if (actor) {
        applyStandardVisibility(html, actor);
        injectCustomCurrencies(html, actor);
        bindCustomCurrencyInputs(html, actor);
        injectWealthTotal(html, actor);
    }
}

function removeConvertCurrency(html) {
    html.find('[class="currency-item convert"]').remove();
    html.find('[data-action="convertCurrency"]').remove();
    html.find('[title="Convert Currency"]').remove();
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
    console.log("5e-custom-currency | Init");
    registerSettings();
    // Pre-load the manager template so it opens without delay
    loadTemplates([`modules/${MODULE_ID}/templates/currency-manager.hbs`]);
});

Hooks.on("ready", () => {
    console.log("5e-custom-currency | Ready");

    patch_currencyNames();

    if (g("depCur")) {
        patch_currencyConversion();
    } else {
        // Stub out convertCurrency for the base Actor class path only
        const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
        if (ActorClass?.prototype) {
            ActorClass.prototype.convertCurrency = async function () {};
        }
    }

    patchConvertCurrency();

    // Item Piles — optional, non-blocking
    if (game.modules.get("item-piles")?.active) {
        if (game.itempiles) {
            syncItemPiles();
        } else {
            Hooks.once("item-piles-ready", syncItemPiles);
        }
    }
});

// Character sheet — dnd5e V1 (FormApplication)
Hooks.on("renderActorSheet5eCharacter",  handleCharacterSheet);
// Character sheet — dnd5e V2 (ApplicationV2, default since dnd5e 3.2 / sole sheet in 4.x)
Hooks.on("renderActorSheet5eCharacter2", handleCharacterSheet);

// ─── Compatibility: Tidy5E NPC sheet ─────────────────────────────────────────

Hooks.on("renderActorSheet5eNPC", (sheet, html) => {
    html = normaliseHtml(html);
    if (game.modules.get("tidy5e-sheet")?.active && sheet.constructor.name === "Tidy5eNPC") {
        alterCharacterCurrency(html);
    }
});

// ─── Compatibility: Let's Trade 5E ───────────────────────────────────────────

Hooks.on("renderTradeWindow", (sheet, html) => {
    html = normaliseHtml(html);
    _alterTradeWindowCurrency(html);
});

Hooks.on("renderDialog", (sheet, html) => {
    html = normaliseHtml(html);
    if (game.modules.get(MODULE_ID)?.active && sheet.title === "Incoming Trade Request") {
        _alterTradeDialogCurrency(html);
    }
});

function _alterTradeDialogCurrency(html) {
    const content = html.find(".dialog-content p");
    const match   = content.text().match(/.+ is sending you [0-9]+((pp|gp|ep|sp|cp) \.).+/);
    if (!match) return;
    const altName = g(match[2] + "Alt");
    if (altName) content.text(content.text().replace(match[1], " " + altName + "."));
}

function _alterTradeWindowCurrency(html) {
    for (const key of STANDARD_KEYS) {
        const container = html.find(`[data-coin="${key}"]`).parent();
        if (!container.length) continue;
        for (const [, n] of Object.entries(container.contents())) {
            if (n.nodeType === Node.TEXT_NODE) n.remove();
        }
        container.append(" " + (g(key + "AltAbrv") ?? key.toUpperCase()));
        container.attr("title", g(key + "Alt") ?? key);
    }
}

// ─── Compatibility: Party Overview ───────────────────────────────────────────

Hooks.on("renderPartyOverviewApp", (sheet, html) => {
    html = normaliseHtml(html);
    _alterPartyOverviewCurrency(html, sheet);
});

function _alterPartyOverviewCurrency(html, sheet) {
    // Rename standard currency headers
    const headers = html.find('div[data-tab="currencies"] div.table-row.header div.text.icon');
    const labels  = ["ppAlt","gpAlt","epAlt","spAlt","cpAlt"].map(k => g(k));
    labels.forEach((label, i) => { if (label && headers[i]) $(headers[i]).text(label); });
    if (labels[1] && headers[5]) {
        $(headers[5]).text(`${labels[1]} (${game.i18n.localize("party-overview.TOTAL")})`);
    }

    // Inject custom currency totals below the standard table
    const customs = getCustomCurrencies().filter(c => c.visibility !== "never");
    if (!customs.length) return;

    const currencyTab = html.find('div[data-tab="currencies"]');
    if (!currencyTab.length) return;

    // Collect party members' flag values
    const members = sheet.object?.system?.members
        ?? sheet.document?.system?.members
        ?? [];
    const actors  = members
        .map(m => game.actors.get(m.actor?.id ?? m.id))
        .filter(Boolean);

    if (!actors.length) return;

    const rows = customs.map(curr => {
        const total = actors.reduce(
            (sum, a) => sum + (a.getFlag(MODULE_ID, curr.id) ?? 0), 0
        );
        return `<div class="table-row custom-currency-total flexrow">
            <img src="${curr.img || DEFAULT_CURRENCY_ICON}"
                 style="width:14px;height:14px;object-fit:contain;margin-right:4px;">
            <span style="flex:1">${curr.name}</span>
            <span>${total.toLocaleString()}</span>
        </div>`;
    }).join("");

    currencyTab.append(`
        <div class="custom-currency-party-totals" style="margin-top:8px;border-top:1px solid #ccc;padding-top:6px;">
            <strong style="font-size:0.85em;">Custom Currencies</strong>
            ${rows}
        </div>
    `);
}
