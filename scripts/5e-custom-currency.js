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
    tintColorToFilter,
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
    // dnd5e V1 sheet: ol.currency-list  (li.currency-item)
    // dnd5e V2 sheet: ul.currency       (li.currency)       [dnd5e ≤3.x]
    // dnd5e V2 sheet: ul.currency-list  (li.currency)       [dnd5e 4.x]
    const container = html.find("ol.currency-list, ul.currency-list, ul.currency").first();
    if (!container.length) return;

    const isV1 = container.is("ol");

    for (const curr of getCustomCurrencies()) {
        const vis    = curr.visibility ?? "always";
        const amount = actor?.getFlag(MODULE_ID, curr.id) ?? 0;

        if (vis === "never") continue;
        if (vis === "owned" && amount <= 0) continue;

        const imgSrc    = curr.img || DEFAULT_CURRENCY_ICON;
        const filter    = tintColorToFilter(curr.tintColor);
        const imgStyle  = filter ? ` style="filter:${filter}"` : "";

        const liClass   = isV1
            ? `currency-item ${curr.id} custom-currency`
            : `currency ${curr.id} custom-currency`;

        const li = $(`<li class="${liClass}" data-denomination="${curr.id}" aria-label="${curr.name}">
                    <img class="currency-custom-icon" src="${imgSrc}" title="${curr.name}"${imgStyle} alt="${curr.name}">
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
 * Override Actor5e.convertCurrency to handle custom-currency chains.
 *
 * Each custom currency has a `convertsTo` field:
 *   "none"     → skip (not converted)
 *   "standard" → fold into CP pool (standard chain handles the rest)
 *   "customX"  → fold into another custom currency at convertRate:1
 *
 * Chains are resolved with up to MAX_CUSTOM_CURRENCIES passes so that
 * e.g. FrogCoins→SpiritCoins→(none) all converts in one click.
 */
export function patchConvertCurrency() {
    const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
    if (!ActorClass?.prototype?.convertCurrency) return;

    const original = ActorClass.prototype.convertCurrency;

    ActorClass.prototype.convertCurrency = async function () {
        const customs = getCustomCurrencies().filter(
            c => c.convertsTo && c.convertsTo !== "none"
        );

        // Migration: also pick up old-style participateConvert if convertsTo absent
        const legacyCustoms = getCustomCurrencies().filter(
            c => (!c.convertsTo || c.convertsTo === "none") && c.participateConvert && c.exchangeRate > 0
        );

        if (customs.length === 0 && legacyCustoms.length === 0) {
            return original.call(this);
        }

        // ── Snapshot current amounts ──────────────────────────────────────────
        const amounts = {};
        for (const c of getCustomCurrencies()) {
            amounts[c.id] = this.getFlag(MODULE_ID, c.id) ?? 0;
        }
        amounts["__cp__"] = this.system?.currency?.cp ?? 0;

        // ── Legacy participateConvert path ────────────────────────────────────
        if (legacyCustoms.length > 0) {
            const cpPerGp = getCpPerGp();
            for (const curr of legacyCustoms) {
                if (amounts[curr.id] <= 0) continue;
                amounts["__cp__"] += Math.round(amounts[curr.id] * curr.exchangeRate * cpPerGp);
                amounts[curr.id]   = 0;
            }
        }

        // ── Chain resolution (up to N passes for chains up to N deep) ─────────
        const MAX_PASSES = getCustomCurrencies().length + 1;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            let changed = false;
            for (const curr of customs) {
                const rate   = Math.max(1, curr.convertRate ?? 1);
                const amount = amounts[curr.id] ?? 0;
                if (amount < rate) continue;

                const whole     = Math.floor(amount / rate);
                amounts[curr.id] = amount % rate;
                changed          = true;

                if (curr.convertsTo === "standard") {
                    // 1 whole unit = 1 CP
                    amounts["__cp__"] += whole;
                } else {
                    amounts[curr.convertsTo] = (amounts[curr.convertsTo] ?? 0) + whole;
                }
            }
            if (!changed) break;
        }

        // ── Build update payload ──────────────────────────────────────────────
        const updates = {};
        for (const c of getCustomCurrencies()) {
            const orig = this.getFlag(MODULE_ID, c.id) ?? 0;
            if (amounts[c.id] !== orig) {
                updates[`flags.${MODULE_ID}.${c.id}`] = amounts[c.id];
            }
        }
        const origCp = this.system?.currency?.cp ?? 0;
        if (amounts["__cp__"] !== origCp) {
            updates["system.currency.cp"] = amounts["__cp__"];
        }

        if (Object.keys(updates).length > 0) await this.update(updates);

        // Run the standard chain (cp→sp→ep→gp→pp) only when depCur is on
        if (game.settings.get(MODULE_ID, "depCur")) {
            return original.call(this);
        }
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

    const entries = customs.map(curr => {
        // exchangeRate > 0 required for Item Piles to show prices in the
        // merchant price column; fall back to tiny non-zero when not set.
        const exchangeRate = (curr.exchangeRate > 0) ? curr.exchangeRate : 0.0001;

        // Item Piles' Svelte UI needs an absolute path for icons to resolve.
        const rawImg = curr.img || DEFAULT_CURRENCY_ICON;
        const img = rawImg.startsWith("http") || rawImg.startsWith("/")
            ? rawImg
            : `/${rawImg}`;

        return {
            type:         "attribute",
            name:         curr.name,
            img,
            abbreviation: `{#}${curr.abbreviation}`,
            // NO custom id field — Item Piles matches currencies by path;
            // adding a non-standard id key broke abbreviation lookups.
            data:         { path: `flags.${MODULE_ID}.${curr.id}` },
            primary:      false,
            exchangeRate,
        };
    });

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
