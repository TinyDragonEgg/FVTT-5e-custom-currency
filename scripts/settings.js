import { patch_currencyConversion, patch_currencyNames } from "./5e-custom-currency.js";

const VISIBILITY_CHOICES = {
    always: "Always Visible",
    owned: "Visible if Non-Zero",
    never: "Never Visible",
};

// Called by onChange callbacks — only re-applies patches, never re-registers settings.
function patch() {
    patch_currencyNames();
    if (game.settings.get("5e-custom-currency", "depCur")) {
        patch_currencyConversion();
    }
}

export function registerSettings() {
    registerIndependentCurrencies();
    registerSettingsCurrencyNames();
    registerCustomCurrencies();
    registerVisibilitySettings();
    if (game.settings.get("5e-custom-currency", "depCur")) {
        registerSettingsExchangeRate();
    }
    console.log("5e-custom-currency | Settings registered");
}

function registerIndependentCurrencies() {
    game.settings.register("5e-custom-currency", "depCur", {
        name: "Dependent Currencies",
        hint: "When enabled, currencies convert into each other at the configured exchange rates.",
        scope: "world",
        config: true,
        default: true,
        type: Boolean,
        onChange: () => {
            patch();
            window.location.reload();
        },
    });
}

function registerSettingsCurrencyNames() {
    const currencies = [
        ["cp", "Copper",   "CP"],
        ["sp", "Silver",   "SP"],
        ["ep", "Electrum", "EP"],
        ["gp", "Gold",     "GP"],
        ["pp", "Platinum", "PP"],
    ];
    for (const [key, defaultName, defaultAbrv] of currencies) {
        game.settings.register("5e-custom-currency", key + "Alt", {
            name: defaultName + " Name",
            scope: "world",
            config: true,
            default: defaultName,
            type: String,
            onChange: () => patch_currencyNames(),
        });
        game.settings.register("5e-custom-currency", key + "AltAbrv", {
            name: defaultName + " Abbreviation",
            scope: "world",
            config: true,
            default: defaultAbrv,
            type: String,
            onChange: () => patch_currencyNames(),
        });
    }
}

function registerCustomCurrencies() {
    for (const [key, defaultName, defaultAbrv] of [
        ["custom1", "Custom 1", "C1"],
        ["custom2", "Custom 2", "C2"],
    ]) {
        game.settings.register("5e-custom-currency", key + "Alt", {
            name: defaultName + " Name",
            scope: "world",
            config: true,
            default: defaultName,
            type: String,
            onChange: () => patch_currencyNames(),
        });
        game.settings.register("5e-custom-currency", key + "AltAbrv", {
            name: defaultName + " Abbreviation",
            scope: "world",
            config: true,
            default: defaultAbrv,
            type: String,
            onChange: () => patch_currencyNames(),
        });
        game.settings.register("5e-custom-currency", key + "Convert", {
            name: defaultName + " Conversion Rate to GP",
            hint: "How many of this currency equal 1 GP. Set to 0 to disable conversion.",
            scope: "world",
            config: true,
            default: 0,
            type: Number,
            onChange: () => patch_currencyConversion(),
        });
    }
}

function registerVisibilitySettings() {
    const allCurrencies = [
        ["cp", "Copper"],
        ["sp", "Silver"],
        ["ep", "Electrum"],
        ["gp", "Gold"],
        ["pp", "Platinum"],
        ["custom1", "Custom 1"],
        ["custom2", "Custom 2"],
    ];
    for (const [key, label] of allCurrencies) {
        game.settings.register("5e-custom-currency", key + "Visibility", {
            name: label + " Visibility",
            hint: "Control when this currency row appears on character sheets.",
            scope: "world",
            config: true,
            default: "always",
            type: String,
            choices: VISIBILITY_CHOICES,
        });
    }
}

function registerSettingsExchangeRate() {
    const cpAlt = game.settings.get("5e-custom-currency", "cpAlt");
    const spAlt = game.settings.get("5e-custom-currency", "spAlt");
    const epAlt = game.settings.get("5e-custom-currency", "epAlt");
    const gpAlt = game.settings.get("5e-custom-currency", "gpAlt");
    const ppAlt = game.settings.get("5e-custom-currency", "ppAlt");

    game.settings.register("5e-custom-currency", "cp-sp", {
        name: cpAlt + " to " + spAlt,
        scope: "world",
        config: true,
        default: 10,
        type: Number,
        onChange: () => patch_currencyConversion(),
    });
    game.settings.register("5e-custom-currency", "sp-ep", {
        name: spAlt + " to " + epAlt,
        scope: "world",
        config: true,
        default: 5,
        type: Number,
        onChange: () => patch_currencyConversion(),
    });
    game.settings.register("5e-custom-currency", "ep-gp", {
        name: epAlt + " to " + gpAlt,
        scope: "world",
        config: true,
        default: 2,
        type: Number,
        onChange: () => patch_currencyConversion(),
    });
    game.settings.register("5e-custom-currency", "gp-pp", {
        name: gpAlt + " to " + ppAlt,
        scope: "world",
        config: true,
        default: 10,
        type: Number,
        onChange: () => patch_currencyConversion(),
    });
}
