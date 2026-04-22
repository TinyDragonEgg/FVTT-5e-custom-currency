// Import
import { registerSettings } from "./settings.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MODULE_ID = "5e-custom-currency";

/** Keys of the two actor-flag-backed custom currency slots. */
const CUSTOM_KEYS = ["custom1", "custom2"];

/** Standard dnd5e currency keys. */
const STANDARD_KEYS = ["cp", "sp", "ep", "gp", "pp"];

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Normalise the html argument passed by render hooks.
 * FormApplication (V12 and older) passes jQuery; ApplicationV2 (V13+) passes HTMLElement.
 */
function normaliseHtml(html) {
    return html instanceof HTMLElement ? $(html) : html;
}

/** Resolve the Actor from a sheet instance regardless of Foundry version. */
function actorFromSheet(sheet) {
    return sheet.actor ?? sheet.document ?? sheet.object ?? null;
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function fetchParams() {
    const get = (key) => game.settings.get(MODULE_ID, key);
    return {
        cpAlt:       get("cpAlt"),    cpAltAbrv:  get("cpAltAbrv"),
        spAlt:       get("spAlt"),    spAltAbrv:  get("spAltAbrv"),
        epAlt:       get("epAlt"),    epAltAbrv:  get("epAltAbrv"),
        gpAlt:       get("gpAlt"),    gpAltAbrv:  get("gpAltAbrv"),
        ppAlt:       get("ppAlt"),    ppAltAbrv:  get("ppAltAbrv"),
        custom1Alt:  get("custom1Alt"),  custom1AltAbrv: get("custom1AltAbrv"),
        custom2Alt:  get("custom2Alt"),  custom2AltAbrv: get("custom2AltAbrv"),
    };
}

function get_conversion_rates() {
    const get = (key) => game.settings.get(MODULE_ID, key);
    return {
        cp_sp: get("cp-sp"),
        sp_ep: get("sp-ep"),
        ep_gp: get("ep-gp"),
        gp_pp: get("gp-pp"),
    };
}

// ─── Core patches ─────────────────────────────────────────────────────────────

/**
 * Patch currency names and abbreviations into CONFIG.DND5E.currencies.
 * Only patches label/abbreviation on the existing 5 entries — does not add
 * custom1/custom2 to CONFIG (those are stored in actor flags, not system data).
 */
export function patch_currencyNames() {
    const p = fetchParams();

    for (const [key, altKey, abrvKey] of [
        ["cp", "cpAlt", "cpAltAbrv"], ["sp", "spAlt", "spAltAbrv"],
        ["ep", "epAlt", "epAltAbrv"], ["gp", "gpAlt", "gpAltAbrv"],
        ["pp", "ppAlt", "ppAltAbrv"],
    ]) {
        if (CONFIG.DND5E.currencies[key]) {
            CONFIG.DND5E.currencies[key].label        = p[altKey];
            CONFIG.DND5E.currencies[key].abbreviation = p[abrvKey];
        }
    }
}

/**
 * Patch conversion rates.
 * Standard currencies use CONFIG.DND5E.currencies[key].conversion (dnd5e 3.x+ format).
 * Custom currencies store their GP rate in settings; actual conversion is handled
 * via the sheet inject, not dnd5e's native convertCurrency.
 */
export function patch_currencyConversion() {
    const rates = get_conversion_rates();

    CONFIG.DND5E.currencies.cp.conversion = null;
    CONFIG.DND5E.currencies.sp.conversion = rates.cp_sp;
    CONFIG.DND5E.currencies.ep.conversion = rates.sp_ep;
    CONFIG.DND5E.currencies.gp.conversion = rates.ep_gp;
    CONFIG.DND5E.currencies.pp.conversion = rates.gp_pp;
}

/**
 * Stub out convertCurrency so the converter button is inert when currencies
 * are set to independent mode.
 */
function independentCurrency() {
    const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
    ActorClass.prototype.convertCurrency = async function() {};
}

// ─── Sheet helpers ────────────────────────────────────────────────────────────

/**
 * Rename currency abbreviation labels on the sheet for standard currencies.
 * dnd5e 3.x+ reads CONFIG at render time so in most cases the CONFIG patch is
 * sufficient; these DOM tweaks catch sheets that cache labels before our ready
 * hook fires. Uses multi-class selectors (.denomination.pp) instead of the
 * fragile exact-attribute form ([class="denomination pp"]).
 */
function alterCharacterCurrency(html) {
    const p = fetchParams();
    html.find(".denomination.pp").text(p.ppAltAbrv);
    html.find(".denomination.gp").text(p.gpAltAbrv);
    html.find(".denomination.ep").text(p.epAltAbrv);
    html.find(".denomination.sp").text(p.spAltAbrv);
    html.find(".denomination.cp").text(p.cpAltAbrv);
}

/**
 * Hide standard currency rows whose visibility setting is not satisfied.
 * "always"  → always show
 * "owned"   → show only if actor holds > 0
 * "never"   → always hide
 */
function applyStandardVisibility(html, actor) {
    for (const key of STANDARD_KEYS) {
        const vis = game.settings.get(MODULE_ID, key + "Visibility");
        if (vis === "always") continue;
        const amount = actor?.system?.currency?.[key] ?? 0;
        if (vis === "never" || (vis === "owned" && amount <= 0)) {
            // Cover both V1 (.currency-item.gp) and V2 (li.currency.gp) sheet structures
            html.find(`.currency-item.${key}, li.currency.${key}`).hide();
        }
    }
}

/**
 * Inject custom currency rows into the character sheet currency bar.
 * Values are read from / saved to actor flags so they don't touch the
 * dnd5e data model at all.
 *
 * Supports both the dnd5e V1 sheet (ol.currency-list) and the V2 sheet
 * (ul.currency). Falls back gracefully if neither selector matches.
 */
function injectCustomCurrencies(html, actor) {
    const container = html.find("ol.currency-list, ul.currency").first();
    if (!container.length) return;

    const isV2 = container.is("ul");

    for (const key of CUSTOM_KEYS) {
        const name = game.settings.get(MODULE_ID, key + "Alt");
        const abrv = game.settings.get(MODULE_ID, key + "AltAbrv");
        const vis  = game.settings.get(MODULE_ID, key + "Visibility");
        const amount = actor?.getFlag(MODULE_ID, key) ?? 0;

        if (vis === "never") continue;
        if (vis === "owned" && amount <= 0) continue;

        const li = isV2
            ? $(`<li class="currency ${key}" aria-label="${name}">
                    <input class="uninput" type="number"
                           data-flag-currency="${key}" value="${amount}" placeholder="--">
                    <span class="denomination ${key}" aria-hidden="true">${abrv}</span>
                 </li>`)
            : $(`<li class="currency-item ${key}">
                    <input type="number"
                           data-flag-currency="${key}" value="${amount}" placeholder="0" min="0">
                    <span class="denomination ${key}">${abrv}</span>
                 </li>`);

        container.append(li);
    }
}

/**
 * Attach change handlers to the injected custom currency inputs so that
 * editing a value persists it to the actor's flags immediately.
 */
function bindCustomCurrencyInputs(html, actor) {
    html.find("[data-flag-currency]").on("change", function() {
        const key   = $(this).data("flag-currency");
        const value = parseInt($(this).val()) || 0;
        actor.setFlag(MODULE_ID, key, value);
    });
}

function removeConvertCurrency(html) {
    html.find('[class="currency-item convert"]').remove();
    html.find('[data-action="convertCurrency"]').remove();
    html.find('[title="Convert Currency"]').remove();
}

// ─── Shared sheet handler ─────────────────────────────────────────────────────

function handleCharacterSheet(sheet, html) {
    html = normaliseHtml(html);
    const actor = actorFromSheet(sheet);

    if (!game.settings.get(MODULE_ID, "depCur")) {
        removeConvertCurrency(html);
    }

    alterCharacterCurrency(html);

    if (actor) {
        applyStandardVisibility(html, actor);
        injectCustomCurrencies(html, actor);
        bindCustomCurrencyInputs(html, actor);
    }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
    console.log("5e-custom-currency | Init");
    registerSettings();
});

Hooks.on("ready", function() {
    console.log("5e-custom-currency | Ready");

    patch_currencyNames();
    console.log("5e-custom-currency | patch_currencyNames");

    if (game.settings.get(MODULE_ID, "depCur")) {
        patch_currencyConversion();
        console.log("5e-custom-currency | patch_currencyConversion");
    } else {
        console.log("5e-custom-currency | Using Independent Currencies");
        independentCurrency();
    }
});

// Character sheet — dnd5e 3.x V1 (FormApplication)
Hooks.on("renderActorSheet5eCharacter", handleCharacterSheet);

// Character sheet — dnd5e 3.x/4.x V2 (ApplicationV2)
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
    alterTradeWindowCurrency(html);
});

Hooks.on("renderDialog", (sheet, html) => {
    html = normaliseHtml(html);
    if (game.modules.get(MODULE_ID)?.active && sheet.title === "Incoming Trade Request") {
        alterTradeDialogCurrency(html);
    }
});

function alterTradeDialogCurrency(html) {
    const p = fetchParams();
    const content = html.find(".dialog-content p");
    const match = content.text().match(/.+ is sending you [0-9]+((pp|gp|ep|sp|cp) \.).+/);
    if (match) content.text(content.text().replace(match[1], " " + p[match[2] + "Alt"] + "."));
}

function alterTradeWindowCurrency(html) {
    const p = fetchParams();
    ["pp", "gp", "ep", "sp", "cp"].forEach(dndCurrency => {
        const container = html.find('[data-coin="' + dndCurrency + '"]').parent();
        if (!container.length) return;
        for (const [k, n] of Object.entries(container.contents())) {
            if (n.nodeType === Node.TEXT_NODE) n.remove();
        }
        container.append(" " + p[dndCurrency + "AltAbrv"]);
        container.attr("title", p[dndCurrency + "Alt"]);
    });
}

// ─── Compatibility: Party Overview ───────────────────────────────────────────

Hooks.on("renderPartyOverviewApp", (sheet, html) => {
    html = normaliseHtml(html);
    alterPartyOverviewWindowCurrency(html);
});

function alterPartyOverviewWindowCurrency(html) {
    const p = fetchParams();
    const currencies = html.find('div[data-tab="currencies"] div.table-row.header div.text.icon');
    $(currencies[0]).text(p.ppAlt);
    $(currencies[1]).text(p.gpAlt);
    $(currencies[2]).text(p.epAlt);
    $(currencies[3]).text(p.spAlt);
    $(currencies[4]).text(p.cpAlt);
    $(currencies[5]).text(`${p.gpAlt} (${game.i18n.localize("party-overview.TOTAL")})`);
}
