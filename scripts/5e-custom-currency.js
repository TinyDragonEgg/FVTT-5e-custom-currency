/**
 * 5E Custom Currency — main module entry point.
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

function normaliseHtml(html) {
    return html instanceof HTMLElement ? $(html) : html;
}

function actorFromSheet(sheet) {
    return sheet.actor ?? sheet.document ?? sheet.object ?? null;
}

function g(key) {
    try { return game.settings.get(MODULE_ID, key); } catch { return null; }
}

// ─── Standard-currency helpers ────────────────────────────────────────────────

function alterCharacterCurrency(html) {
    for (const key of STANDARD_KEYS) {
        const abrv = g(key + "AltAbrv");
        if (abrv) html.find(`.denomination.${key}`).text(abrv);
    }
}

function applyStandardVisibility(html, actor) {
    for (const key of STANDARD_KEYS) {
        const vis = g(key + "Visibility") ?? "always";
        if (vis === "always") continue;
        const amount = actor?.system?.currency?.[key] ?? 0;
        if (vis === "never" || (vis === "owned" && amount <= 0)) {
            // dnd5e 5.x: each currency is a <label> containing <i class="currency {key}">
            // older dnd5e: <li class="{key}"> or <li data-denomination="{key}">
            html.find(`i.currency.${key}`).closest("label, li").hide();
            html.find(`.currency-item.${key}, li[data-denomination="${key}"]`).hide();
        }
    }
}

// ─── Custom-currency icon helpers ────────────────────────────────────────────

/**
 * Build a plain <img> element string for a custom currency icon.
 * We use <img> instead of <dnd5e-icon> because we need to control the src,
 * and dnd5e-icon is a web component whose internal img can't be changed
 * via jQuery .attr() after it has mounted.
 */
function currencyImgTag(curr) {
    const src    = curr.img || DEFAULT_CURRENCY_ICON;
    const filter = tintColorToFilter(curr.tintColor);
    const style  = filter ? ` style="filter:${filter}"` : "";
    return `<img class="currency-custom-icon" src="${src}" alt="${curr.name}"${style}>`;
}

/**
 * Safety-net: replace any leftover <dnd5e-icon> for a custom currency with a
 * plain <img>.  In dnd5e 5.x the currency bar uses <i> styled via a generated
 * CSS rule (background-image from CONFIG.DND5E.currencies[id].icon), so this
 * function is mostly a fallback for older sheets or edge cases.
 */
function fixDnd5eIcons(html) {
    const customs = getCustomCurrencies();
    if (!customs.length) return;

    html.find("dnd5e-icon").each((_, el) => {
        const src = el.getAttribute("src") ?? "";
        const curr = customs.find(c =>
            src.includes(c.id) ||
            (c.img && src === c.img)
        );
        if (!curr) return;
        $(el).replaceWith(currencyImgTag(curr));
    });
}

// ─── Custom-currency sheet injection ─────────────────────────────────────────

/**
 * Ensure every custom currency has a visible row in the currency bar and
 * that its icon is correctly displayed.
 *
 * dnd5e 4.x iterates CONFIG.DND5E.currencies when building the currency bar,
 * so our currencies are rendered natively (input bound to system.currency.[id]).
 * We still need to:
 *  - Replace the broken dnd5e-icon with our actual image (fixDnd5eIcons covers
 *    this, but we also handle it here for fallback rows)
 *  - Apply visibility rules
 *  - Inject a full fallback row if dnd5e didn't render ours (older version or
 *    CONFIG patched too late)
 */
function injectCustomCurrencies(html, actor) {
    // dnd5e 5.x: <section class="currency"> containing <label> per coin
    // older dnd5e: <ol/ul class="currency-list"> or <ul class="currency">
    const container = html.find(
        "section.currency, ol.currency-list, ul.currency-list, ul.currency"
    ).first();
    if (!container.length) return;

    for (const curr of getCustomCurrencies()) {
        const vis    = curr.visibility ?? "always";
        const amount = actor?.system?.currency?.[curr.id] ?? 0;

        // ── Find native element rendered by dnd5e ─────────────────────────
        // dnd5e 5.x: <label> wrapping <i class="currency {id}">
        // older dnd5e: <li class="{id}"> or <li data-denomination="{id}">
        let row = container.find(`i.currency.${curr.id}`).closest("label, li").first();
        if (!row.length) {
            row = container.find(`li.${curr.id}, li[data-denomination="${curr.id}"]`).first();
        }

        if (row.length) {
            row.addClass("custom-currency");
            // Remove any stale <img> injected by an older version of this module;
            // dnd5e 5.x uses <i> + CSS background-image (set via CONFIG icon field).
            row.find("img.currency-custom-icon").remove();
        } else {
            // Fallback: dnd5e didn't render it — inject a label row matching
            // dnd5e 5.x's structure so it blends in visually.
            row = $(`<label class="custom-currency" aria-label="${curr.name}">
                       <i class="currency ${curr.id}" data-tooltip="${curr.name}"></i>
                       <input type="text" inputmode="numeric" pattern="^[+=\\-]?\\d*"
                              class="uninput always-interactive"
                              name="system.currency.${curr.id}"
                              value="${amount}" placeholder="0">
                     </label>`);
            container.append(row);

            row.find("input").on("change", function () {
                actor.update({
                    [`system.currency.${curr.id}`]: parseInt(this.value) || 0,
                });
            });
        }

        // ── Visibility ────────────────────────────────────────────────────
        if (vis === "never" || (vis === "owned" && amount <= 0)) {
            row.hide();
        } else {
            row.show();
        }
    }
}

// ─── Wealth total ─────────────────────────────────────────────────────────────

function injectWealthTotal(html, actor) {
    if (!actor) return;

    let totalGp = 0;

    if (g("depCur")) {
        const cpPerGp = getCpPerGp();
        const cur = actor.system?.currency ?? {};
        totalGp += (cur.pp ?? 0) * (g("gp-pp")  ?? 10);
        totalGp += (cur.gp ?? 0);
        totalGp += (cur.ep ?? 0) / (g("ep-gp")  ?? 2);
        totalGp += (cur.sp ?? 0) / ((g("sp-ep") ?? 5) * (g("ep-gp") ?? 2));
        totalGp += (cur.cp ?? 0) / cpPerGp;
    }

    for (const curr of getCustomCurrencies()) {
        if (!curr.exchangeRate) continue;
        // Values now live in system.currency, not flags
        const amount = actor.system?.currency?.[curr.id] ?? 0;
        totalGp += amount * curr.exchangeRate;
    }

    if (totalGp <= 0) return;

    const gpLabel = g("gpAlt") ?? "GP";
    const line    = $(`<div class="currency-wealth-total">
        Total wealth: ${totalGp.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${gpLabel}
    </div>`);

    html.find("section.currency, ol.currency-list, ul.currency-list, ul.currency").first().after(line);
}

// ─── Convert currency override ────────────────────────────────────────────────

export function patchConvertCurrency() {
    const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
    if (!ActorClass?.prototype?.convertCurrency) return;

    const original = ActorClass.prototype.convertCurrency;

    ActorClass.prototype.convertCurrency = async function () {
        const customs = getCustomCurrencies().filter(
            c => c.convertsTo && c.convertsTo !== "none"
        );
        if (customs.length === 0) return original.call(this);

        // Snapshot amounts from system.currency
        const amounts = {};
        for (const c of getCustomCurrencies()) {
            amounts[c.id] = this.system?.currency?.[c.id] ?? 0;
        }
        amounts["__cp__"] = this.system?.currency?.cp ?? 0;

        // Resolve chains (multiple passes for depth > 1)
        const MAX_PASSES = getCustomCurrencies().length + 1;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            let changed = false;
            for (const curr of customs) {
                const rate   = Math.max(1, curr.convertRate ?? 1);
                const amount = amounts[curr.id] ?? 0;
                if (amount < rate) continue;

                const whole      = Math.floor(amount / rate);
                amounts[curr.id] = amount % rate;
                changed          = true;

                if (curr.convertsTo === "standard") {
                    amounts["__cp__"] += whole;
                } else {
                    amounts[curr.convertsTo] = (amounts[curr.convertsTo] ?? 0) + whole;
                }
            }
            if (!changed) break;
        }

        // Build update using system.currency paths
        const updates = {};
        for (const c of getCustomCurrencies()) {
            const orig = this.system?.currency?.[c.id] ?? 0;
            if (amounts[c.id] !== orig) {
                updates[`system.currency.${c.id}`] = amounts[c.id];
            }
        }
        const origCp = this.system?.currency?.cp ?? 0;
        if (amounts["__cp__"] !== origCp) {
            updates["system.currency.cp"] = amounts["__cp__"];
        }

        if (Object.keys(updates).length > 0) await this.update(updates);

        if (game.settings.get(MODULE_ID, "depCur")) {
            return original.call(this);
        }
    };

    console.log("5e-custom-currency | Patched convertCurrency");
}

// ─── Item Piles optional sync ─────────────────────────────────────────────────

export async function syncItemPiles() {
    if (!game.modules.get("item-piles")?.active) return;
    if (!game.user?.isGM) return;
    const api = game.itempiles?.API;
    if (!api?.setCurrencies) return;

    const customs = getCustomCurrencies();

    // ── Primary currencies: keep existing standard ones, strip any old custom entries ──
    const existing = (api.CURRENCIES ?? []).filter(
        c => !c.data?.path?.startsWith(`system.currency.custom`)
           && !c.data?.path?.startsWith(`flags.${MODULE_ID}`)
    );

    // ── Secondary currencies: our custom ones ─────────────────────────────────
    // setSecondaryCurrencies uses a simpler shape — no primary/exchangeRate fields.
    const secondaryEntries = customs.map(curr => {
        const rawImg = curr.img || DEFAULT_CURRENCY_ICON;
        const img    = rawImg.startsWith("http") || rawImg.startsWith("/")
            ? rawImg : `/${rawImg}`;
        return {
            type:         "attribute",
            name:         curr.name,
            img,
            abbreviation: `{#}${curr.abbreviation}`,
            data:         { path: `system.currency.${curr.id}` },
        };
    });

    try {
        // Restore primary currencies without our custom entries
        await api.setCurrencies(existing);

        // Place custom currencies in the secondary slot (if API supports it)
        if (api.setSecondaryCurrencies) {
            await api.setSecondaryCurrencies(secondaryEntries);
            console.log("5e-custom-currency | Synced custom currencies to Item Piles (secondary)");
        } else {
            // Fallback for older Item Piles: append to primary with primary:false
            const fallbackEntries = customs.map(curr => {
                const rawImg = curr.img || DEFAULT_CURRENCY_ICON;
                const img    = rawImg.startsWith("http") || rawImg.startsWith("/")
                    ? rawImg : `/${rawImg}`;
                return {
                    type:         "attribute",
                    name:         curr.name,
                    img,
                    abbreviation: `{#}${curr.abbreviation}`,
                    data:         { path: `system.currency.${curr.id}` },
                    primary:      false,
                    exchangeRate: (curr.exchangeRate > 0) ? curr.exchangeRate : 0.0001,
                };
            });
            await api.setCurrencies([...existing, ...fallbackEntries]);
            console.log("5e-custom-currency | Synced custom currencies to Item Piles (primary fallback)");
        }
    } catch (err) {
        console.warn("5e-custom-currency | Item Piles sync failed:", err);
    }
}

// ─── Shared character-sheet handler ──────────────────────────────────────────

function handleCharacterSheet(sheet, html) {
    html = normaliseHtml(html);
    const actor = actorFromSheet(sheet);

    if (!g("depCur")) removeConvertCurrency(html);

    fixDnd5eIcons(html);
    alterCharacterCurrency(html);

    if (actor) {
        applyStandardVisibility(html, actor);
        injectCustomCurrencies(html, actor);
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
    // Patch CONFIG before actor data models initialize so that dnd5e's
    // MappingField for system.currency includes our custom keys from the start.
    patch_currencyNames();
    loadTemplates([`modules/${MODULE_ID}/templates/currency-manager.hbs`]);
});

Hooks.on("ready", () => {
    console.log("5e-custom-currency | Ready");

    // Re-patch after ready in case any other module reset CONFIG.DND5E.currencies
    patch_currencyNames();

    if (g("depCur")) {
        patch_currencyConversion();
    } else {
        const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
        if (ActorClass?.prototype) {
            ActorClass.prototype.convertCurrency = async function () {};
        }
    }

    patchConvertCurrency();

    if (game.modules.get("item-piles")?.active) {
        if (game.itempiles) syncItemPiles();
        else Hooks.once("item-piles-ready", syncItemPiles);
    }
});

Hooks.on("renderActorSheet5eCharacter",  handleCharacterSheet);
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

// ─── Compatibility: Item sheets ──────────────────────────────────────────────

Hooks.on("renderItemSheet5e",  (sheet, html) => fixDnd5eIcons(normaliseHtml(html)));
Hooks.on("renderItemSheet5e2", (sheet, html) => fixDnd5eIcons(normaliseHtml(html)));

// ─── Compatibility: Party Overview ───────────────────────────────────────────

Hooks.on("renderPartyOverviewApp", (sheet, html) => {
    html = normaliseHtml(html);
    _alterPartyOverviewCurrency(html, sheet);
});

function _alterPartyOverviewCurrency(html, sheet) {
    const headers = html.find('div[data-tab="currencies"] div.table-row.header div.text.icon');
    const labels  = ["ppAlt","gpAlt","epAlt","spAlt","cpAlt"].map(k => g(k));
    labels.forEach((label, i) => { if (label && headers[i]) $(headers[i]).text(label); });
    if (labels[1] && headers[5]) {
        $(headers[5]).text(`${labels[1]} (${game.i18n.localize("party-overview.TOTAL")})`);
    }

    const customs = getCustomCurrencies().filter(c => c.visibility !== "never");
    if (!customs.length) return;

    const currencyTab = html.find('div[data-tab="currencies"]');
    if (!currencyTab.length) return;

    const members = sheet.object?.system?.members ?? sheet.document?.system?.members ?? [];
    const actors  = members.map(m => game.actors.get(m.actor?.id ?? m.id)).filter(Boolean);
    if (!actors.length) return;

    const rows = customs.map(curr => {
        // Values are in system.currency
        const total = actors.reduce(
            (sum, a) => sum + (a.system?.currency?.[curr.id] ?? 0), 0
        );
        return `<div class="table-row custom-currency-total flexrow">
            <img src="${curr.img || DEFAULT_CURRENCY_ICON}"
                 style="width:14px;height:14px;object-fit:contain;margin-right:4px;">
            <span style="flex:1">${curr.name}</span>
            <span>${total.toLocaleString()}</span>
        </div>`;
    }).join("");

    currencyTab.append(`
        <div class="custom-currency-party-totals"
             style="margin-top:8px;border-top:1px solid #ccc;padding-top:6px;">
            <strong style="font-size:0.85em;">Custom Currencies</strong>
            ${rows}
        </div>
    `);
}
