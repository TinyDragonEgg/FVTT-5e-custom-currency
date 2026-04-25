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
    injectCurrencyIconCSS,
    injectVisibilityCSS,
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

/**
 * Build the list of currency keys that should be hidden for this actor.
 * Returns a string of space-separated keys (empty = nothing hidden).
 */
function buildHiddenList(actor) {
    const hidden = [];
    for (const key of STANDARD_KEYS) {
        const vis = g(key + "Visibility") ?? "always";
        if (vis === "always") continue;
        const amount = actor?.system?.currency?.[key] ?? 0;
        if (vis === "never" || (vis === "owned" && amount <= 0)) hidden.push(key);
    }
    for (const curr of getCustomCurrencies()) {
        const vis = curr.visibility ?? "always";
        if (vis === "always") continue;
        const amount = actor?.system?.currency?.[curr.id] ?? 0;
        if (vis === "never" || (vis === "owned" && amount <= 0)) hidden.push(curr.id);
    }
    return hidden;
}

/**
 * Apply visibility to an open sheet.
 *
 * dnd5e 5.x renders the currency bar inside <dnd5e-inventory> which fetches
 * its template asynchronously — the labels do not exist when the render hook
 * fires.  We therefore:
 *  1. Set a CSS data-attribute on the root right now (static :has() rules kick
 *     in the moment the labels are stamped into the DOM, no timing required).
 *  2. Install a long-running MutationObserver on the root that re-hides via
 *     jQuery whenever the currency section is created or re-rendered.
 *     Debounced at 50 ms so rapid batched mutations only fire once.
 *     Auto-disconnects when the root element leaves the DOM (sheet closed).
 *
 * @param {jQuery}   html   - The normalised jQuery-wrapped sheet element.
 * @param {Actor5e}  actor
 */
function applyVisibility(html, actor) {
    const rootEl = html instanceof jQuery ? html[0] : html;
    if (!(rootEl instanceof HTMLElement)) return;

    const hidden    = buildHiddenList(actor);
    const hiddenSet = new Set(hidden);

    // ── 1. CSS data-attribute (instant — works as soon as labels hit the DOM) ──
    // Skip if the user is currently in "show all" mode — we must not put keys
    // back into the attribute while the toggle is active (the !important CSS
    // rules would re-hide everything and defeat the toggle).
    if (rootEl.dataset.ccShowAll !== "1") {
        rootEl.dataset.hideCurrencies = hidden.join(" ");
        if (rootEl.parentElement instanceof HTMLElement) {
            rootEl.parentElement.dataset.hideCurrencies = hidden.join(" ");
        }
    }

    // ── 2. Direct jQuery hide/show ────────────────────────────────────────────
    function hideNow() {
        if (!rootEl.isConnected) return;
        // If the user clicked "show all currencies", don't re-hide until they toggle back
        if (rootEl.dataset.ccShowAll === "1") return;
        const allKeys = [...STANDARD_KEYS, ...getCustomCurrencies().map(c => c.id)];
        for (const key of allKeys) {
            if (hiddenSet.has(key)) {
                $(rootEl).find(`i.currency.${key}`).closest("label, li").hide();
                $(rootEl).find(`li.${key}, li[data-denomination="${key}"]`).hide();
            } else {
                $(rootEl).find(`i.currency.${key}`).closest("label, li").show();
                $(rootEl).find(`li.${key}, li[data-denomination="${key}"]`).show();
            }
        }
    }

    // Run immediately (sync render path)
    hideNow();

    // ── 3. MutationObserver — catches async inventory renders ─────────────────
    // Disconnect any previous observer for this exact element
    _sheetObservers.get(rootEl)?.disconnect();

    let debounce = null;
    const obs = new MutationObserver(() => {
        if (!rootEl.isConnected) {
            obs.disconnect();
            _sheetObservers.delete(rootEl);
            return;
        }
        clearTimeout(debounce);
        debounce = setTimeout(hideNow, 50);
    });
    _sheetObservers.set(rootEl, obs);
    obs.observe(rootEl, { childList: true, subtree: true });

    // Belt-and-suspenders fallbacks for slow async renders
    setTimeout(hideNow, 100);
    setTimeout(hideNow, 400);
}

// ─── Show-all toggle button ───────────────────────────────────────────────────

/**
 * Inject a small eye-toggle button at the end of the currency bar.
 * Clicking it temporarily reveals every currency (even hidden ones) so the
 * user can enter values, then clicking again restores the visibility rules.
 *
 * The "show all" state is stored on rootEl.dataset.ccShowAll so it survives
 * partial re-renders of the inventory section.
 *
 * Only injected when at least one currency is currently hidden for this actor.
 */
function injectCurrencyToggle(rootEl, actor, sheet, context = null) {
    if (!(rootEl instanceof HTMLElement)) return;
    if (!buildHiddenList(actor).length) return; // nothing hidden → no button needed

    const SECTION_SEL = "section.currency, ol.currency-list, ul.currency-list, ul.currency";
    const BTN_SEL     = ".currency-show-hidden-btn";

    /**
     * Determine whether the sheet is currently in edit mode.
     *
     * Priority order — stops at the first definitive answer:
     *
     * 1. sheet.mode  — dnd5e 5.x ActorSheetV2 exposes a public getter that
     *    returns MODES.PLAY (1) or MODES.EDIT (2).  Most reliable.
     *
     * 2. context.editable — passed from the V2 render hook; dnd5e sets this
     *    in _prepareContext from isEditable which DOES include the mode check
     *    there.  Only valid on the initial render call, not from the observer.
     *
     * 3. sheet.isEditable — in some dnd5e versions this also includes the mode
     *    check; in others it only checks ownership.  Used as tertiary fallback.
     *
     * 4. DOM class / dataset checks — last resort.
     */
    function isEditMode() {
        // 1. Public mode getter (dnd5e 5.x)
        if (typeof sheet?.mode === "number") {
            const EDIT = sheet.constructor?.MODES?.EDIT ?? 2;
            return sheet.mode === EDIT;
        }
        // 2. Render-context editable flag
        if (context && typeof context.editable === "boolean") return context.editable;
        // 3. isEditable (may or may not include mode in this dnd5e version)
        if (sheet && typeof sheet.isEditable === "boolean") return sheet.isEditable;
        // 4. DOM fallbacks
        if (rootEl.classList.contains("locked")) return false;
        if (rootEl.dataset.mode) return rootEl.dataset.mode === "edit";
        const hasToggle = rootEl.classList.contains("mode-play")
                       || rootEl.classList.contains("mode-edit");
        return !hasToggle || rootEl.classList.contains("mode-edit");
    }

    function addButton() {
        if (!rootEl.isConnected) return;

        // Remove button when sheet is not in edit mode
        if (!isEditMode()) {
            rootEl.querySelector(BTN_SEL)?.remove();
            return;
        }

        const section = rootEl.querySelector(SECTION_SEL);
        if (!section) return;
        if (section.querySelector(BTN_SEL)) return; // already present

        const showAll = rootEl.dataset.ccShowAll === "1";

        const btn = document.createElement("button");
        btn.type      = "button";
        btn.className = "currency-show-hidden-btn" + (showAll ? " active" : "");
        btn.setAttribute("data-tooltip", showAll ? "Restore visibility" : "Show all currencies");
        btn.innerHTML = `<i class="fas fa-${showAll ? "eye-slash" : "eye"}"></i>`;

        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            const nowShowAll = rootEl.dataset.ccShowAll !== "1";
            rootEl.dataset.ccShowAll = nowShowAll ? "1" : "0";
            btn.classList.toggle("active", nowShowAll);
            btn.setAttribute("data-tooltip", nowShowAll ? "Restore visibility" : "Show all currencies");
            btn.querySelector("i").className = `fas fa-${nowShowAll ? "eye-slash" : "eye"}`;

            if (nowShowAll) {
                // Clear the CSS data-attribute so !important rules don't block display
                rootEl.dataset.hideCurrencies = "";
                if (rootEl.parentElement instanceof HTMLElement) {
                    rootEl.parentElement.dataset.hideCurrencies = "";
                }
                // Force-show every currency label/row
                const allKeys = [...STANDARD_KEYS, ...getCustomCurrencies().map(c => c.id)];
                for (const key of allKeys) {
                    $(rootEl).find(`i.currency.${key}`).closest("label, li").show();
                    $(rootEl).find(`li.${key}, li[data-denomination="${key}"]`).show();
                }
            } else {
                // Re-apply the normal visibility rules (restores data-hide-currencies too)
                applyVisibility($(rootEl), actor);
            }
        });

        section.appendChild(btn);
    }

    // Watch for any attribute change on the root (class, data-*, etc.) so the
    // button appears/disappears when dnd5e switches play ↔ edit mode, however
    // it signals that change, without requiring a full sheet re-render.
    if (!rootEl.dataset.ccModeObserver) {
        rootEl.dataset.ccModeObserver = "1";
        new MutationObserver(addButton)
            .observe(rootEl, { attributes: true });
    }

    // Try immediately, then after async inventory renders
    addButton();
    setTimeout(addButton, 150);
    setTimeout(addButton, 500);
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

        // Visibility is handled by applyVisibilityAttribute + injected CSS;
        // no jQuery .hide()/.show() needed here.
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

// WeakMap so we never stack duplicate observers on the same sheet element
const _sheetObservers = new WeakMap();

// ─── _prepareContext patch ────────────────────────────────────────────────────

/**
 * Patch every registered dnd5e actor sheet class so that hidden currencies are
 * removed from the template context BEFORE the sheet renders.
 *
 * This is the only approach that's immune to async rendering timing — if the
 * data isn't in the context, dnd5e simply never stamps a DOM node for it.
 *
 * dnd5e 5.x puts the currency array in context.currencies (array of objects
 * with a .key property).  We filter that array in place.
 */
export function patchSheetContext() {
    const patched = new WeakSet();

    const tryPatch = (SheetClass) => {
        if (!SheetClass?.prototype?._prepareContext) return;
        if (patched.has(SheetClass)) return;
        patched.add(SheetClass);

        const orig = SheetClass.prototype._prepareContext;
        SheetClass.prototype._prepareContext = async function (options) {
            const ctx = await orig.call(this, options);
            const actor = this.document ?? this.actor ?? this.object;
            if (!actor?.system?.currency) return ctx;

            const hidden = new Set(buildHiddenList(actor));
            if (!hidden.size) return ctx;

            // dnd5e 5.x passes the global CONFIG object into the template context
            // as ctx.CONFIG.  The currency bar template iterates
            // CONFIG.DND5E.currencies directly, so there is no ctx.currencies
            // array to filter — we must shadow the currencies map on ctx.CONFIG.
            //
            // We shallow-copy the path ctx.CONFIG → DND5E → currencies so that
            // the global CONFIG object is never mutated (thread-safe across
            // simultaneous sheet renders).
            if (ctx.CONFIG?.DND5E?.currencies) {
                ctx.CONFIG = {
                    ...ctx.CONFIG,
                    DND5E: {
                        ...ctx.CONFIG.DND5E,
                        currencies: Object.fromEntries(
                            Object.entries(ctx.CONFIG.DND5E.currencies)
                                  .filter(([key]) => !hidden.has(key))
                        ),
                    },
                };
            }

            return ctx;
        };
    };

    // Patch every sheet class registered for any actor type
    for (const classes of Object.values(CONFIG.Actor.sheetClasses ?? {})) {
        for (const entry of Object.values(classes)) {
            tryPatch(entry.cls ?? entry);
        }
    }
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
    const existing = (api.CURRENCIES ?? []).filter(
        c => !c.data?.path?.startsWith(`system.currency.custom`)
           && !c.data?.path?.startsWith(`flags.${MODULE_ID}`)
    );

    const entries = customs.map(curr => {
        const rawImg = curr.img || DEFAULT_CURRENCY_ICON;
        const img    = rawImg.startsWith("http") || rawImg.startsWith("/")
            ? rawImg : `/${rawImg}`;
        return {
            type:         "attribute",
            name:         curr.name,
            img,
            abbreviation: `{#}${curr.abbreviation}`,
            data:         { path: `system.currency.${curr.id}` },
            primary:      true,
            exchangeRate: (curr.exchangeRate > 0) ? curr.exchangeRate : 0.0001,
        };
    });

    try {
        await api.setCurrencies([...existing, ...entries]);
        console.log("5e-custom-currency | Synced custom currencies to Item Piles");
    } catch (err) {
        console.warn("5e-custom-currency | Item Piles sync failed:", err);
    }
}

// ─── Shared sheet handlers ────────────────────────────────────────────────────

function handleCharacterSheet(sheet, html, context = null) {
    html = normaliseHtml(html);
    const actor = actorFromSheet(sheet);

    if (!g("depCur")) removeConvertCurrency(html);
    fixDnd5eIcons(html);
    alterCharacterCurrency(html);

    if (actor) {
        applyVisibility(html, actor);
        injectCurrencyToggle(html[0], actor, sheet, context);
        injectCustomCurrencies(html, actor);
        injectWealthTotal(html, actor);
    }
}

/** Apply visibility / icon fixes to NPC / vehicle sheets. */
function handleNpcSheet(sheet, html, context = null) {
    html = normaliseHtml(html);
    const actor = actorFromSheet(sheet);

    fixDnd5eIcons(html);
    alterCharacterCurrency(html);

    if (actor) {
        applyVisibility(html, actor);
        injectCurrencyToggle(html[0], actor, sheet, context);
        injectCustomCurrencies(html, actor);
    }
}

function removeConvertCurrency(html) {
    html.find('[class="currency-item convert"]').remove();
    html.find('[data-action="convertCurrency"]').remove();
    html.find('[title="Convert Currency"]').remove();
}

// ─── dnd5e-inventory patch ────────────────────────────────────────────────────

/**
 * Patch dnd5e-inventory's connectedCallback so that every time the element
 * renders its currency bar into the light DOM we immediately hide any
 * currencies whose visibility setting says they should be hidden.
 *
 * The element uses light DOM (confirmed by diagnostic), so querySelectorAll
 * and style.display work normally.  We set up a MutationObserver on the
 * element itself — not the outer sheet root — so we only watch the exact
 * subtree where currencies appear.
 */
export async function patchDnd5eInventory() {
    await customElements.whenDefined("dnd5e-inventory");
    const cls = customElements.get("dnd5e-inventory");
    if (!cls?.prototype?.connectedCallback) return;

    const origCC = cls.prototype.connectedCallback;

    cls.prototype.connectedCallback = function () {
        if (origCC) origCC.call(this);
        const el = this;
        // Delay slightly so the element has time to populate its actor reference
        // and render its initial content before we try to hide things.
        setTimeout(() => {
            const actor = el.actor;
            if (!actor?.system?.currency) return;
            // Prefer the sheet root so the observer covers the full sheet;
            // fall back to the inventory element itself.
            const rootEl = el.app?.element ?? el;
            applyVisibility($(rootEl), actor);
        }, 50);
    };

    // Apply to any dnd5e-inventory elements that were already in the DOM
    // before this patch ran (e.g. sheets restored from a previous session).
    for (const el of document.querySelectorAll("dnd5e-inventory")) {
        const actor = el.actor;
        if (!actor?.system?.currency) continue;
        const rootEl = el.app?.element ?? el;
        setTimeout(() => applyVisibility($(rootEl), actor), 100);
    }

    console.log("5e-custom-currency | Patched dnd5e-inventory");
}

// ─── Dynamic render-hook registration ────────────────────────────────────────

/**
 * In FVTT V13, ApplicationV2 fires `render{ClassName}` hooks instead of the
 * generic `render` hook used by V1.  We cannot hard-code class names because
 * dnd5e renames them between major versions (e.g. ActorSheet5eCharacter2 →
 * CharacterActorSheet in dnd5e 5.x).
 *
 * Instead we iterate CONFIG.Actor.sheetClasses at ready-time and register a
 * hook for every class name we find.  This catches every sheet variant
 * (character, npc, vehicle, group…) in any dnd5e version automatically.
 */
function registerDynamicRenderHooks() {
    const seen = new Set();

    for (const actorType of Object.keys(CONFIG.Actor.sheetClasses ?? {})) {
        for (const entry of Object.values(CONFIG.Actor.sheetClasses[actorType])) {
            const cls       = entry.cls ?? entry;
            const className = cls?.name;
            if (!className || seen.has(className)) continue;
            seen.add(className);

            // V2 render hook passes (app, html, context, options)
            Hooks.on(`render${className}`, (app, html, context, options) => {
                html = normaliseHtml(html);
                const actor = actorFromSheet(app);
                if (!actor?.system?.currency) return;
                if (actor.type === "character") handleCharacterSheet(app, html, context);
                else handleNpcSheet(app, html, context);
            });
        }
    }

    if (seen.size) {
        console.log(
            `5e-custom-currency | Registered dynamic render hooks for: ${
                [...seen].map(n => `render${n}`).join(", ")
            }`
        );
    }
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
    injectCurrencyIconCSS();
    injectVisibilityCSS();

    if (g("depCur")) {
        patch_currencyConversion();
    } else {
        const ActorClass = dnd5e?.documents?.Actor5e ?? CONFIG.Actor.documentClass;
        if (ActorClass?.prototype) {
            ActorClass.prototype.convertCurrency = async function () {};
        }
    }

    patchConvertCurrency();
    patchSheetContext();
    registerDynamicRenderHooks();
    patchDnd5eInventory();

    if (game.modules.get("item-piles")?.active) {
        if (game.itempiles) syncItemPiles();
        else Hooks.once("item-piles-ready", syncItemPiles);
    }
});

// ─── Actor sheet hooks ────────────────────────────────────────────────────────
// "render" fires for every ApplicationV2 render regardless of the class name,
// so we don't break when dnd5e renames its sheet classes between major versions.
// We filter by checking for a dnd5e currency system object on the actor.
//
// In FVTT V13, ApplicationV2 fires BOTH "render" AND "render{ClassName}", so
// we track which apps we've already handled this tick to avoid duplicate work.

const _handled = new WeakSet();

// Generic "render" hook — fires for ApplicationV1 sheets (FVTT V12 / older
// dnd5e).  In FVTT V13 this does NOT fire for ApplicationV2 sheets; those are
// handled by registerDynamicRenderHooks() above.
Hooks.on("render", (app, html) => {
    const actor = actorFromSheet(app);
    if (!actor?.system?.currency) return;
    _handled.add(app);
    if (actor.type === "character") handleCharacterSheet(app, html);
    else handleNpcSheet(app, html);
});

// Legacy class-specific hooks — fire only if "render" didn't already handle it
// (covers FVTT V12 / older dnd5e where "render" may not exist or fire differently)
function _legacyCharacter(app, html) { if (!_handled.has(app)) handleCharacterSheet(app, html, null); }
function _legacyNpc(app, html)       { if (!_handled.has(app)) handleNpcSheet(app, html, null); }

Hooks.on("renderActorSheet5eCharacter",  _legacyCharacter);
Hooks.on("renderActorSheet5eCharacter2", _legacyCharacter);
Hooks.on("renderActorSheet5eNPC",        _legacyNpc);
Hooks.on("renderActorSheet5eNPC2",       _legacyNpc);
Hooks.on("renderActorSheet5eVehicle",    _legacyNpc);

// Live visibility update when an actor's currency values change
// (e.g. a 0-balance currency gets paid; it should appear/disappear immediately)
Hooks.on("updateActor", (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, "system.currency")) return;
    for (const app of Object.values(actor.apps ?? {})) {
        if (!app?.rendered) continue;
        let el = app.element;
        if (!el) continue;
        applyVisibility(el instanceof HTMLElement ? $(el) : el, actor);
    }
});

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
