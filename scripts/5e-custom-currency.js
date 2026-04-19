// Import
import { registerSettings } from "./settings.js";

/**
 * Normalise the html argument passed by render hooks.
 * FormApplication (V12 and older) passes a jQuery object.
 * ApplicationV2 (V13+) passes a plain HTMLElement.
 * $() is idempotent on jQuery objects so this is safe either way.
 */
function normaliseHtml(html) {
    return html instanceof HTMLElement ? $(html) : html;
}

// Base Hooks
Hooks.once("init", () => {
    console.log("5e-custom-currency | Init");

    registerSettings();
});

Hooks.on("ready", function() {
    console.log("5e-custom-currency | Ready");

    patch_currencyNames();
    console.log("5e-custom-currency | patch_currencyNames");

    if (game.settings.get("5e-custom-currency", "depCur")) {
        patch_currencyConversion();
        console.log("5e-custom-currency | patch_currencyConversion");
    } else {
        console.log("5e-custom-currency | Using Independent Currencies");
        independentCurrency();
    }
});

// Character sheet — dnd5e 3.x V1 (FormApplication) sheet
Hooks.on("renderActorSheet5eCharacter", (sheet, html) => {
    html = normaliseHtml(html);
    if (!game.settings.get("5e-custom-currency", "depCur")) {
        removeConvertCurrency(html);
    }
    alterCharacterCurrency(html);
});

// Character sheet — dnd5e 3.x/4.x V2 (ApplicationV2) sheet
Hooks.on("renderActorSheet5eCharacter2", (sheet, html) => {
    html = normaliseHtml(html);
    if (!game.settings.get("5e-custom-currency", "depCur")) {
        removeConvertCurrency(html);
    }
    alterCharacterCurrency(html);
});

//  Base Functions

function get_conversion_rates() {
    return {
        cp_sp: game.settings.get("5e-custom-currency", "cp-sp"),
        sp_ep: game.settings.get("5e-custom-currency", "sp-ep"),
        ep_gp: game.settings.get("5e-custom-currency", "ep-gp"),
        gp_pp: game.settings.get("5e-custom-currency", "gp-pp")
    };
}

function fetchParams() {
    return {
        cpAlt:    game.settings.get("5e-custom-currency", "cpAlt"),
        spAlt:    game.settings.get("5e-custom-currency", "spAlt"),
        epAlt:    game.settings.get("5e-custom-currency", "epAlt"),
        gpAlt:    game.settings.get("5e-custom-currency", "gpAlt"),
        ppAlt:    game.settings.get("5e-custom-currency", "ppAlt"),
        cpAltAbrv: game.settings.get("5e-custom-currency", "cpAltAbrv"),
        spAltAbrv: game.settings.get("5e-custom-currency", "spAltAbrv"),
        epAltAbrv: game.settings.get("5e-custom-currency", "epAltAbrv"),
        gpAltAbrv: game.settings.get("5e-custom-currency", "gpAltAbrv"),
        ppAltAbrv: game.settings.get("5e-custom-currency", "ppAltAbrv"),
    };
}

/**
 * Patch currency names and abbreviations into CONFIG.DND5E.currencies.
 *
 * dnd5e 2.x+ changed CONFIG.DND5E.currencies from a flat { pp: "Platinum" }
 * map to a { pp: { label, abbreviation, conversion } } object map.
 * We patch only label/abbreviation to preserve the conversion values already
 * set by dnd5e, then let patch_currencyConversion() overwrite those if needed.
 */
export function patch_currencyNames() {
    let altNames = fetchParams();

    CONFIG.DND5E.currencies.pp.label       = altNames.ppAlt;
    CONFIG.DND5E.currencies.pp.abbreviation = altNames.ppAltAbrv;
    CONFIG.DND5E.currencies.gp.label       = altNames.gpAlt;
    CONFIG.DND5E.currencies.gp.abbreviation = altNames.gpAltAbrv;
    CONFIG.DND5E.currencies.ep.label       = altNames.epAlt;
    CONFIG.DND5E.currencies.ep.abbreviation = altNames.epAltAbrv;
    CONFIG.DND5E.currencies.sp.label       = altNames.spAlt;
    CONFIG.DND5E.currencies.sp.abbreviation = altNames.spAltAbrv;
    CONFIG.DND5E.currencies.cp.label       = altNames.cpAlt;
    CONFIG.DND5E.currencies.cp.abbreviation = altNames.cpAltAbrv;
}

/**
 * Patch conversion rates into CONFIG.DND5E.currencies[key].conversion.
 *
 * CONFIG.DND5E.currencyConversion (the old chain format) was removed in
 * dnd5e 3.x. The replacement is a numeric `conversion` property on each
 * currency entry representing how many of the next-lower denomination equal
 * one of this denomination (e.g. sp.conversion = 10 means 10 cp = 1 sp).
 * cp has no lower denomination so its conversion is null.
 */
export function patch_currencyConversion() {
    let rates = get_conversion_rates();

    CONFIG.DND5E.currencies.cp.conversion = null;
    CONFIG.DND5E.currencies.sp.conversion = rates.cp_sp;
    CONFIG.DND5E.currencies.ep.conversion = rates.sp_ep;
    CONFIG.DND5E.currencies.gp.conversion = rates.ep_gp;
    CONFIG.DND5E.currencies.pp.conversion = rates.gp_pp;
}

/**
 * Swap out currency abbreviation text on the actor sheet.
 * dnd5e 3.x+ reads labels from CONFIG at render time, so in most cases
 * the CONFIG patch above is sufficient. These DOM tweaks handle edge cases
 * (e.g. sheets that cache the label before our ready hook runs).
 * Selectors use the multi-class form (.denomination.pp) rather than an
 * exact attribute match ([class="denomination pp"]) so they survive any
 * extra classes added by themes or other modules.
 */
function alterCharacterCurrency(html) {
    let altNames = fetchParams();

    html.find(".denomination.pp").text(altNames.ppAltAbrv);
    html.find(".denomination.gp").text(altNames.gpAltAbrv);
    html.find(".denomination.ep").text(altNames.epAltAbrv);
    html.find(".denomination.sp").text(altNames.spAltAbrv);
    html.find(".denomination.cp").text(altNames.cpAltAbrv);
}

/**
 * Stub out convertCurrency so the converter button does nothing when
 * currencies are set to independent (non-dependent) mode.
 *
 * In dnd5e 3.x+ the method lives on dnd5e.documents.Actor5e, not on
 * the base Foundry Actor class. Fall back to the base class for older builds.
 */
function independentCurrency() {
    const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
    ActorClass.prototype.convertCurrency = async function() {};
}

function removeConvertCurrency(html) {
    html.find('[class="currency-item convert"]').remove();
    html.find('[data-action="convertCurrency"]').remove();
    html.find('[title="Convert Currency"]').remove();
}

// Compatibility: Tidy5E
Hooks.on("renderActorSheet5eNPC", (sheet, html) => {
    html = normaliseHtml(html);
    if (game.modules.get("tidy5e-sheet")?.active && sheet.constructor.name === "Tidy5eNPC") {
        alterCharacterCurrency(html);
    }
});

// Compatibility: Let's Trade 5E
Hooks.on("renderTradeWindow", (sheet, html) => {
    html = normaliseHtml(html);
    alterTradeWindowCurrency(html);
});

Hooks.on("renderDialog", (sheet, html) => {
    html = normaliseHtml(html);
    if (game.modules.get("5e-custom-currency")?.active && sheet.title === "Incoming Trade Request") {
        alterTradeDialogCurrency(html);
    }
});

function alterTradeDialogCurrency(html) {
    let altNames = fetchParams();

    const content = html.find(".dialog-content p");
    const match = content.text().match(/.+ is sending you [0-9]+((pp|gp|ep|sp|cp) \.).+/);
    if (match) content.text(content.text().replace(match[1], " " + altNames[match[2] + "Alt"] + "."));
}

function alterTradeWindowCurrency(html) {
    let altNames = fetchParams();

    ["pp", "gp", "ep", "sp", "cp"].forEach(dndCurrency => {
        const container = html.find('[data-coin="' + dndCurrency + '"]').parent();
        if (!container.length) return;

        for (const [k, n] of Object.entries(container.contents())) {
            if (n.nodeType === Node.TEXT_NODE) n.remove();
        }

        container.append(" " + altNames[dndCurrency + "AltAbrv"]);
        container.attr("title", altNames[dndCurrency + "Alt"]);
    });
}

// Compatibility: Party Overview
Hooks.on("renderPartyOverviewApp", (sheet, html) => {
    html = normaliseHtml(html);
    alterPartyOverviewWindowCurrency(html);
});

function alterPartyOverviewWindowCurrency(html) {
    let altNames = fetchParams();

    const currencies = html.find('div[data-tab="currencies"] div.table-row.header div.text.icon');
    $(currencies[0]).text(altNames.ppAlt);
    $(currencies[1]).text(altNames.gpAlt);
    $(currencies[2]).text(altNames.epAlt);
    $(currencies[3]).text(altNames.spAlt);
    $(currencies[4]).text(altNames.cpAlt);
    $(currencies[5]).text(`${altNames.gpAlt} (${game.i18n.localize("party-overview.TOTAL")})`);
}
