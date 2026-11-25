const MODULE_ID = "pf2e-multi-target-checks";
const PROBE_PREFIX = "pf2e-mtc:probe:";
const PRIMARY_PREFIX = "pf2e-mtc:primary:";
const SEPARATE_PREFIX = "pf2e-mtc:separate:";
const MARKER_PREFIX = "pf2e-mtc:";

const SEPARATE_LATCH_MS = 750;

const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];
const TARGET_TYPES = ["creature", "hazard", "vehicle"];

const probeResults = new Map();
const pendingPrimaries = new Map();
const pendingRerolls = new Map();
let activeProbeId = null;

let separateHeld = false;
let separateReleasedAt = 0;

function isSeparateMode() {
    return separateHeld || Date.now() - separateReleasedAt < SEPARATE_LATCH_MS;
}

const localize = (key, data) =>
    data ? game.i18n.format(`${MODULE_ID}.${key}`, data) : game.i18n.localize(`${MODULE_ID}.${key}`);

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
    game.keybindings.register(MODULE_ID, "separateRolls", {
        name: `${MODULE_ID}.keybindings.separateRolls.name`,
        hint: `${MODULE_ID}.keybindings.separateRolls.hint`,
        editable: [{ key: "KeyX" }],
        onDown: () => {
            separateHeld = true;
            return false;
        },
        onUp: () => {
            separateHeld = false;
            separateReleasedAt = Date.now();
            return false;
        },
    });

    window.addEventListener("blur", () => {
        separateHeld = false;
    });
});

Hooks.once("setup", () => {
    libWrapper.register(MODULE_ID, "game.pf2e.Check.roll", onCheckRoll, "MIXED");
    libWrapper.register(MODULE_ID, "game.pf2e.Check.rerollFromMessage", onRerollFromMessage, "WRAPPER");
    libWrapper.register(MODULE_ID, "CONFIG.ChatMessage.documentClass.prototype.renderHTML", onRenderHTML, "WRAPPER");
    if (game.pf2e.ElementalBlast) {
        libWrapper.register(MODULE_ID, "game.pf2e.ElementalBlast.prototype.damage", onBlastDamage, "WRAPPER");
    }
});

Hooks.once("ready", () => {
    const StatisticCheck = findStatisticCheckClass();
    if (!StatisticCheck) {
        console.error(`${MODULE_ID} | could not locate StatisticCheck; skill actions and spell attacks won't be resolved per target`);
    } else {
        globalThis.PF2E_MTC = { StatisticCheck };
        libWrapper.register(MODULE_ID, "PF2E_MTC.StatisticCheck.prototype.roll", onStatisticCheckRoll, "MIXED");
    }

    const module = game.modules.get(MODULE_ID);
    if (module) module.api = { getResults };
});

function findStatisticCheckClass() {
    const fromActor = (actor) =>
        actor?.skills?.acrobatics?.check ?? actor?.saves?.fortitude?.check ?? actor?.perception?.check ?? null;

    let check = fromActor(game.actors.find((a) => !!fromActor(a)));
    if (!check) {
        try {
            check = fromActor(new CONFIG.Actor.documentClass({ name: MODULE_ID, type: "npc" }));
        } catch (err) {
            console.error(`${MODULE_ID} | failed to create probe actor`, err);
        }
    }
    if (!check) return null;

    let proto = Object.getPrototypeOf(check);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "roll")) {
        proto = Object.getPrototypeOf(proto);
    }
    return proto?.constructor ?? null;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function findMarker(options, prefix) {
    if (!options) return null;
    for (const option of options) {
        if (typeof option === "string" && option.startsWith(prefix)) return option.slice(prefix.length);
    }
    return null;
}

function stripMarkers(options) {
    return Array.from(options).filter((o) => !o.startsWith(MARKER_PREFIX));
}

function getContext(message) {
    return message.flags?.[game.system.id]?.context ?? null;
}

function getMultiTargets(selfActor, selfToken) {
    const selfUuid = selfToken?.uuid ?? null;
    return [...game.user.targets].filter((token) => {
        if (!token.document || !token.actor?.isOfType(...TARGET_TYPES)) return false;
        return token.actor !== selfActor && token.document.uuid !== selfUuid;
    });
}

function isTargetingStatistic(statisticCheck, args) {
    if (["flat-check", "saving-throw"].includes(statisticCheck.type)) return false;
    if (args.target && args.target === statisticCheck.actor) return false;

    const dc = typeof args.dc === "number" ? { value: args.dc } : (args.dc ?? null);
    if (typeof dc?.value === "number") return false;

    const item = args.item ?? null;
    if (statisticCheck.domains?.includes("spell-attack-roll") && item?.isOfType("spell")) return true;

    return (
        !!(dc?.slug || (dc && "statistic" in dc)) &&
        (!item || item.isOfType("action", "campaignFeature", "feat", "weapon"))
    );
}

function isPrimaryStrike(context) {
    return (
        context.type === "attack-roll" &&
        context.action === "strike" &&
        !context.isReroll &&
        context.createMessage !== false &&
        !!context.identifier
    );
}

function findStrike(actor, identifier) {
    const [itemId, slug, kind] = identifier?.split(".") ?? [];
    if (!kind) return null;

    const base = actor.system.actions?.find((s) => s.slug === slug && s.item?.id === itemId);
    return (
        [base, ...(base?.altUsages ?? [])].find((attack) => {
            if (!attack) return false;
            if (attack.type !== "strike") return attack.type === kind;
            return (attack.item.isMelee ? "melee" : "ranged") === kind;
        }) ?? null
    );
}

/* -------------------------------------------- */
/*  Probing                                     */
/* -------------------------------------------- */

async function runProbe(fn) {
    const id = foundry.utils.randomID();
    probeResults.set(id, null);

    const previous = activeProbeId;
    activeProbeId = id;
    try {
        await fn(`${PROBE_PREFIX}${id}`);
    } catch (err) {
        console.warn(`${MODULE_ID} | probe failed`, err);
    } finally {
        activeProbeId = previous;
    }

    const result = probeResults.get(id);
    probeResults.delete(id);
    return result;
}

/**
 * @param {Token[]} targets
 * @param {TokenDocument|null} primaryDoc
 * @param {(token: Token, marker: string) => Promise<unknown>} rollFn
 */
async function probeAll(targets, primaryDoc, rollFn) {
    const tokens = [...targets];
    const primaryToken = primaryDoc?.object;
    if (primaryToken && !tokens.some((t) => t.document.uuid === primaryDoc.uuid)) {
        tokens.push(primaryToken);
    }

    const probes = [];
    for (const token of tokens) {
        const result = await runProbe((marker) => rollFn(token, marker));
        probes.push({ uuid: token.document.uuid, result });
    }
    return probes;
}

function registerPrimary(probes) {
    const id = foundry.utils.randomID();
    pendingPrimaries.set(id, probes);
    return id;
}

function getContextualDcModifiers(context) {
    const statistic = context.dc?.statistic;
    if (!statistic?.modifiers) return [];

    const slug = statistic.parent?.slug;
    const realActor = context.target?.token?.actor; // the token's real actor, not the contextual clone
    const base = slug && realActor ? realActor.getStatistic(slug)?.dc : null;

    const key = (m) => `${m.slug}:${m.modifier}`;
    const baseKeys = new Set((base?.modifiers ?? []).filter((m) => m.enabled).map(key));

    return statistic.modifiers
        .filter((m) => m.enabled && m.modifier !== 0 && !baseKeys.has(key(m)))
        .map((m) => ({ label: m.label, modifier: m.modifier }));
}

function captureProbe(id, check, context, options) {
    if (typeof context.mapIncreases === "number") options.add(`map:increases:${context.mapIncreases}`);
    if (!context.isReroll && options.size > 0) check.calculateTotal(options);

    probeResults.set(id, {
        totalModifier: check.totalModifier,
        dc: context.dc?.value ?? null,
        dcModifiers: getContextualDcModifiers(context),
        dosAdjustments: (context.dosAdjustments ?? []).map((adjustment) => ({
            adjustments: foundry.utils.deepClone(adjustment.adjustments ?? {}),
            predicate: adjustment.predicate ? foundry.utils.deepClone(Array.from(adjustment.predicate)) : null,
            options: adjustment.options ? Array.from(adjustment.options) : null
        })),
        options: stripMarkers(options),
        modifierSlugs: check.modifiers.map((m) => m.slug),
        rollMods: check.modifiers.filter((m) => m.enabled && !m.ignored).map(serializeModifier),
        dcMods: getDcModifierList(context)
    });
}

function serializeModifier(m) {
    return {
        label: m.label,
        modifier: m.modifier,
        type: m.type,
        slug: m.slug,
        source: m.source ?? null,
        enabled: true,
        ignored: false,
    };
}

function getDcModifierList(context) {
    const statistic = context.dc?.statistic;
    if (!statistic?.modifiers) return [];

    const isAC = ["ac", "armor"].includes(context.dc?.slug);
    const armor = isAC ? context.target?.token?.actor?.wornArmor : null;
    const armorSlugs = new Set([armor?.slug, armor?.system?.baseItem].filter(Boolean));

    return statistic.modifiers
        .filter((m) => m.enabled && !m.ignored && !armorSlugs.has(m.slug))
        .map(serializeModifier);
}

async function probeStrike(context) {
    const actor = context.token?.actor ?? (context.actor?.id ? game.actors.get(context.actor.id) : null);
    if (!actor) return null;

    const targets = getMultiTargets(actor, context.token);
    if (targets.length < 2) return null;

    const variant = findStrike(actor, context.identifier)?.variants?.[context.mapIncreases ?? 0];
    if (typeof variant?.roll !== "function") return null;

    const probes = await probeAll(targets, context.target?.token ?? null, (token, marker) =>
        variant.roll({ target: token, options: [marker], consumeAmmo: false, createMessage: false }),
    );
    return registerPrimary(probes);
}

/* -------------------------------------------- */
/*  Separate rolls                              */
/* -------------------------------------------- */

function orderTargets(targets, primaryDoc) {
    const primary = primaryDoc?.object ?? null;
    const rest = targets.filter((t) => t.document.uuid !== primaryDoc?.uuid);
    return primary ? [primary, ...rest] : rest;
}

const separateMarker = (sequenceId, index) => `${SEPARATE_PREFIX}${sequenceId}:${index === 0 ? "first" : "rest"}`;

function parseSeparateMarker(value) {
    const [sequenceId, role] = value?.split(":") ?? [];
    return sequenceId && role ? { sequenceId, role } : null;
}

const separateCarries = new Map();

function snapshotBeforeDialog(check, context, options) {
    if (typeof context.mapIncreases === "number") options.add(`map:increases:${context.mapIncreases}`);
    if (!context.isReroll && options.size > 0) check.calculateTotal(options);

    return {
        modifiers: new Map(check.modifiers.map((m) => [m, m.ignored])),
        rollTwice: context.rollTwice ?? false,
        substitutions: new Map((context.substitutions ?? []).map((s) => [s.slug, !!s.selected])),
    };
}

function collectDialogChanges(before, check, context) {
    const added = [];
    const toggled = [];

    for (const modifier of check.modifiers) {
        if (!before.modifiers.has(modifier)) {
            added.push(modifier.clone());
        } else if (before.modifiers.get(modifier) !== modifier.ignored) {
            toggled.push({ slug: modifier.slug, ignored: modifier.ignored });
        }
    }

    const substitutions = new Map();
    for (const substitution of context.substitutions ?? []) {
        if (before.substitutions.get(substitution.slug) !== !!substitution.selected) {
            substitutions.set(substitution.slug, !!substitution.selected);
        }
    }

    return {
        added,
        toggled,
        rollTwice: (context.rollTwice ?? false) !== before.rollTwice ? (context.rollTwice ?? false) : undefined,
        substitutions,
        messageMode: context.messageMode,
    };
}

function applyDialogChanges(carry, check, context) {
    for (const { slug, ignored } of carry.toggled) {
        const modifier = check.modifiers.find((m) => m.slug === slug);
        if (!modifier) continue;

        check.delete(modifier);
        if (!ignored) {
            check.push(modifier.clone({ predicate: [], enabled: true, ignored: false }));
        }
    }

    for (const modifier of carry.added) {
        check.push(modifier.clone());
    }

    if (carry.rollTwice !== undefined) context.rollTwice = carry.rollTwice;
    for (const substitution of context.substitutions ?? []) {
        if (!carry.substitutions.has(substitution.slug)) continue;
        substitution.selected = carry.substitutions.get(substitution.slug);
        const option = `substitute:${substitution.slug}`;
        if (substitution.selected) context.options.add(option);
        else context.options.delete(option);
    }
    if (carry.messageMode) context.messageMode = carry.messageMode;
}

async function getCallerAdditions(variant, check, context) {
    const none = { options: [], modifiers: [] };
    const primaryToken = context.target?.token?.object;
    if (!primaryToken) return none;

    const baseline = await runProbe((marker) =>
        variant.roll({ target: primaryToken, options: [marker], consumeAmmo: false, createMessage: false }),
    );
    if (!baseline) return none;

    const baselineOptions = new Set(baseline.options);
    const baselineSlugs = new Set(baseline.modifierSlugs);

    return {
        options: stripMarkers(context.options).filter((o) => !baselineOptions.has(o)),
        modifiers: check.modifiers.filter((m) => !baselineSlugs.has(m.slug)),
    };
}

async function rollStrikeSeparately(check, context, event) {
    const actor = context.token?.actor ?? (context.actor?.id ? game.actors.get(context.actor.id) : null);
    if (!actor) return false;

    const targets = getMultiTargets(actor, context.token);
    if (targets.length < 2) return false;

    const variant = findStrike(actor, context.identifier)?.variants?.[context.mapIncreases ?? 0];
    if (typeof variant?.roll !== "function") return false;

    const additions = await getCallerAdditions(variant, check, context);

    const ordered = orderTargets(targets, context.target?.token ?? null);
    const sequenceId = foundry.utils.randomID();
    try {
        for (const [index, token] of ordered.entries()) {
            const roll = await variant.roll({
                target: token,
                options: [...additions.options, separateMarker(sequenceId, index)],
                modifiers: additions.modifiers.map((m) => m.clone()),
                ...(index === 0 && event ? { event } : {}),
            });
            // Cancelling the first dialog cancels the whole sequence.
            if (index === 0 && !roll) break;
        }
    } finally {
        separateCarries.delete(sequenceId);
    }
    return true;
}

/* -------------------------------------------- */
/*  Wrappers                                    */
/* -------------------------------------------- */

async function onCheckRoll(wrapped, check, context = {}, event = null, callback) {
    if (Array.isArray(context.options)) context.options = new Set(context.options);
    context.options ??= new Set();
    const options = context.options;

    const probeId =
        findMarker(options, PROBE_PREFIX) ??
        (activeProbeId && context.createMessage === false && context.type !== "saving-throw" ? activeProbeId : null);

    if (probeId && probeResults.has(probeId)) {
        captureProbe(probeId, check, context, options);
        return null;
    }

    const separate = parseSeparateMarker(findMarker(options, SEPARATE_PREFIX));
    if (separate?.role === "first") {
        const before = snapshotBeforeDialog(check, context, options);
        const roll = await wrapped(check, context, event, callback);
        if (roll) separateCarries.set(separate.sequenceId, collectDialogChanges(before, check, context));
        return roll;
    }
    if (separate?.role === "rest") {
        const carry = separateCarries.get(separate.sequenceId);
        if (carry) applyDialogChanges(carry, check, context);
        context.skipDialog = true;
        return wrapped(check, context, event, callback);
    }

    if (isPrimaryStrike(context) && isSeparateMode() && (await rollStrikeSeparately(check, context, event))) {
        return null;
    }

    if (isPrimaryStrike(context) && !findMarker(options, PRIMARY_PREFIX)) {
        const primaryId = await probeStrike(context);
        if (primaryId) {
            options.add(`${PRIMARY_PREFIX}${primaryId}`);
            try {
                return await wrapped(check, context, event, callback);
            } finally {
                pendingPrimaries.delete(primaryId);
            }
        }
    }

    return wrapped(check, context, event, callback);
}

async function onStatisticCheckRoll(wrapped, args = {}) {
    const separate = isSeparateMode();

    const extra = args.extraRollOptions ?? [];
    if (
        activeProbeId ||
        findMarker(extra, PROBE_PREFIX) ||
        findMarker(extra, PRIMARY_PREFIX) ||
        findMarker(extra, SEPARATE_PREFIX)
    ) {
        return wrapped(args);
    }
    if (args.createMessage === false || !isTargetingStatistic(this, args)) {
        return wrapped(args);
    }

    const self = this.actor;
    const selfToken = args.token ?? self.getActiveTokens(true, true).shift() ?? null;
    const targets = getMultiTargets(self, selfToken);
    if (targets.length < 2) return wrapped(args);

    const primaryDoc = args.target
        ? (args.target.getActiveTokens(true, true).find((t) => t.actor?.isOfType("army", "creature", "hazard")) ?? null)
        : null;

    if (separate) {
        return rollStatisticSeparately(wrapped, args, extra, selfToken, orderTargets(targets, primaryDoc));
    }

    const probes = await probeAll(targets, primaryDoc, (token, marker) =>
        isBeyondMaxRange(args, selfToken, token)
            ? null
            : wrapped({
                ...args,
                event: undefined,
                callback: undefined,
                target: token.actor,
                token: selfToken,
                modifiers: args.modifiers?.map((m) => m.clone?.() ?? m),
                extraRollOptions: [...extra, marker],
                skipDialog: true,
                createMessage: false,
            }),
    );

    const primaryId = registerPrimary(probes);
    try {
        return await wrapped({ ...args, extraRollOptions: [...extra, `${PRIMARY_PREFIX}${primaryId}`] });
    } finally {
        pendingPrimaries.delete(primaryId);
    }
}

async function rollStatisticSeparately(wrapped, args, extra, selfToken, ordered) {
    const sequenceId = foundry.utils.randomID();
    try {
        return await rollStatisticSequence(wrapped, args, extra, selfToken, ordered, sequenceId);
    } finally {
        separateCarries.delete(sequenceId);
    }
}

async function rollStatisticSequence(wrapped, args, extra, selfToken, ordered, sequenceId) {
    let last = null;
    let rolled = 0;
    for (const token of ordered) {
        if (isBeyondMaxRange(args, selfToken, token)) {
            ui.notifications.warn(`${token.name}: ${game.i18n.localize("PF2E.Action.Strike.OutOfRange")}`);
            continue;
        }

        const isFirst = rolled === 0;
        const roll = await wrapped({
            ...args,
            ...(isFirst ? {} : { event: undefined, skipDialog: true }),
            target: token.actor,
            token: selfToken,
            modifiers: args.modifiers?.map((m) => m.clone?.() ?? m),
            extraRollOptions: [...extra, separateMarker(sequenceId, rolled)],
        });
        if (isFirst && !roll) return null;
        rolled++;
        last = roll ?? last;
    }
    return last;
}

function isBeyondMaxRange(args, selfToken, token) {
    if (args.action !== "elemental-blast" || args.melee) return false;

    const max = args.item?.range?.max;
    const origin = selfToken?.object;
    if (!max || !origin) return false;

    return origin.distanceTo(token) > max;
}

async function onRerollFromMessage(wrapped, message, ...args) {
    const entries = message?.getFlag?.(MODULE_ID, "targets");
    const primaryId = findMarker(getContext(message)?.options, PRIMARY_PREFIX);
    if (!entries?.length || !primaryId) return wrapped(message, ...args);

    pendingRerolls.set(primaryId, entries);
    try {
        return await wrapped(message, ...args);
    } finally {
        pendingRerolls.delete(primaryId);
    }
}

async function onRenderHTML(wrapped, ...args) {
    const html = await wrapped(...args);
    try {
        renderTargets(this, html);
        attachDamageTargeting(this, html);
        attachSpellDamageTargeting(this, html);
    } catch (err) {
        console.error(`${MODULE_ID} | failed to render targets`, err);
    }
    return html;
}

/* -------------------------------------------- */
/*  Message creation                            */
/* -------------------------------------------- */

Hooks.on("preCreateChatMessage", (message, _data, _options, userId) => {
    if (userId !== game.user.id) return;

    const context = getContext(message);
    if (context?.type === "damage-roll") {
        applyDamageTargets(message);
        return;
    }

    const primaryId = findMarker(context?.options, PRIMARY_PREFIX);
    if (!primaryId) return;

    if (context.isReroll) {
        const entries = pendingRerolls.get(primaryId);
        if (entries) message.updateSource({ [`flags.${MODULE_ID}.targets`]: entries });
        return;
    }

    const probes = pendingPrimaries.get(primaryId);
    if (!probes) return;

    const entries = buildEntries(message, context, probes);
    if (entries.length >= 2) {
        message.updateSource({ [`flags.${MODULE_ID}.targets`]: entries });
    }
});

function buildEntries(message, context, probes) {
    const roll = message.rolls?.[0];
    const primaryUuid = context.target?.token ?? null;
    const primaryProbe = probes.find((p) => p.uuid === primaryUuid)?.result;
    const baseModifier = primaryProbe?.totalModifier ?? roll?.options?.totalModifier ?? null;

    return probes.map(({ uuid, result }) => {
        if (uuid === primaryUuid) {
            return {
                uuid,
                primary: true,
                dc: context.dc?.value ?? result?.dc ?? null,
                delta: 0,
                dcModifiers: result?.dcModifiers ?? [],
                dcMods: result?.dcMods ?? [],
            };
        }
        if (!result || !Number.isFinite(result.dc) || baseModifier === null) {
            return { uuid, unresolved: true };
        }

        const entry = {
            uuid,
            dc: result.dc,
            delta: result.totalModifier - baseModifier,
            dcModifiers: result.dcModifiers,
            rollMods: mergeRollMods(message, primaryProbe, result),
            dcMods: result.dcMods,
        };
        if (result.dosAdjustments.length) {
            entry.dos = result.dosAdjustments;
            entry.options = result.options;
        }
        return entry;
    });
}

function mergeRollMods(message, primaryProbe, probe) {
    const messageMods = message.flags?.[game.system.id]?.modifiers ?? [];
    const primarySlugs = new Set(primaryProbe?.rollMods?.map((m) => m.slug) ?? []);

    const switchedOff = new Set(
        messageMods.filter((m) => (!m.enabled || m.ignored) && primarySlugs.has(m.slug)).map((m) => m.slug),
    );
    const added = messageMods
        .filter((m) => m.enabled && !m.ignored && !primarySlugs.has(m.slug))
        .map(serializeModifier);

    return [...probe.rollMods.filter((m) => !switchedOff.has(m.slug)), ...added];
}

/* -------------------------------------------- */
/*  PF2e Modifiers Matter                       */
/* -------------------------------------------- */

const MM_ID = "pf2e-modifiers-matter";
const SIGNIFICANCE_ORDER = ["ESSENTIAL", "DETRIMENTAL", "HELPFUL", "HARMFUL"];
const MM_DEGREE_KEYS = {
    criticalSuccess: "CRIT_SUCC",
    success: "SUCCESS",
    failure: "FAILURE",
    criticalFailure: "CRIT_FAIL",
};

function mmShowsToEveryone() {
    try {
        return !!game.settings.get(MM_ID, "always-show-highlights-to-everyone");
    } catch {
        return false;
    }
}

function getSignificantModifiers(message, entry, result, roll, isAC) {
    const mm = window.pf2eMm;
    if (!mm || !result) return [];

    try {
        if (entry.primary) return mm.getSignificantModifiersOfMessage(message) ?? [];
        const rollSource = entry.rollMods ?? entry.mm?.rollMods;
        const dcSource = entry.dcMods ?? entry.mm?.dcMods ?? [];
        if (!rollSource) return [];

        const rollMods = mm.filterOutIgnoredModifiers(rollSource);
        let dcMods = mm.filterOutIgnoredModifiers(dcSource);
        if (isAC && mm.IGNORED_MODIFIER_SLUGS_FOR_AC_ONLY) {
            dcMods = dcMods.filter((m) => !mm.IGNORED_MODIFIER_SLUGS_FOR_AC_ONLY.has(m.slug));
        }

        const degree = mm.DEGREES?.[MM_DEGREE_KEYS[result.unadjusted ?? result.outcome]];
        if (!degree) return [];

        const { significantRollModifiers = [], significantDcModifiers = [] } = mm.calcSignificantModifiers({
            rollMods,
            dcMods,
            originalDeltaFromDc: result.total - result.dc,
            dieRoll: getDieResult(roll),
            currentDegreeOfSuccess: degree,
            isStrike: isAC,
        });
        return [...significantRollModifiers, ...significantDcModifiers];
    } catch (err) {
        console.warn(`${MODULE_ID} | Modifiers Matter integration failed`, err);
        return [];
    }
}

function strongestSignificance(significant) {
    return SIGNIFICANCE_ORDER.find((s) => significant.some((m) => m.significance === s)) ?? null;
}

/* -------------------------------------------- */
/*  Breakdown tooltip                           */
/* -------------------------------------------- */

function getRowRollModifiers(message, entry) {
    if (entry.primary) {
        const messageMods = message.flags?.[game.system.id]?.modifiers ?? [];
        return messageMods.filter((m) => m.enabled && !m.ignored);
    }
    return entry.rollMods ?? entry.mm?.rollMods ?? [];
}

const PERMANENT_DEFENSE_TYPES = new Set(["ability", "proficiency", "item", "potency"]);

function getRowDefenseModifiers(entry) {
    const full = entry.dcMods?.length ? entry.dcMods : entry.mm?.dcMods;
    if (!full?.length) return entry.dcModifiers ?? [];

    const contextual = new Set((entry.dcModifiers ?? []).map((m) => `${m.label}:${m.modifier}`));
    return full.filter(
        (m) =>
            m.modifier !== 0 &&
            (contextual.has(`${m.label}:${m.modifier}`) || (!PERMANENT_DEFENSE_TYPES.has(m.type) && m.slug !== "base")),
    );
}

const trimLabel = (label) => game.i18n.localize(label).replace(/(.+) \d+$/, "$1");
const signed = (value) => (value >= 0 ? `+${value}` : String(value));

function modifierLine(label, value, significance, onDefense) {
    const css = significance ? ` class="pf2e-mtc-sig-text-${significance}"` : "";
    const where = onDefense ? ` <span class="pf2e-mtc-tooltip-defense">(${localize("onDefense")})</span>` : "";
    return `<span${css}>${trimLabel(label)} ${signed(value)}</span>${where}`;
}

function buildBreakdownTooltip({ message, entry, result, roll, dcText, showDC, showResults, showDetails, significant }) {
    const lines = [];

    const checkName = message.item?.name ?? null;
    const header =
        checkName && showDC && dcText
            ? `${checkName} ${localize("vs", { dc: dcText })}`
            : (checkName ?? (showDC ? dcText : ""));
    if (header) lines.push(`<strong>${header}</strong>`);

    let summary = "";
    if (showDetails) summary += `(<i class="fa-solid fa-dice-d20"></i> ${getDieResult(roll)}) `;
    if (showResults) {
        const outcome = game.i18n.localize(`PF2E.Check.Result.Degree.Check.${result.outcome}`);
        summary += showDC ? localize("tooltip.withOffset", { outcome, offset: signed(result.total - result.dc) }) : outcome;
    }
    if (summary) lines.push(localize("tooltip.result", { result: summary }));

    if (showDetails) {
        const remaining = [...significant];
        const takeSignificance = (label, value) => {
            const index = remaining.findIndex((s) => s.name === label && s.value === value);
            return index === -1 ? null : remaining.splice(index, 1)[0].significance;
        };

        for (const m of getRowRollModifiers(message, entry)) {
            lines.push(modifierLine(m.label, m.modifier, takeSignificance(m.label, m.modifier), false));
        }
        for (const m of getRowDefenseModifiers(entry)) {
            lines.push(modifierLine(m.label, m.modifier, takeSignificance(m.label, m.modifier), true));
        }
        for (const s of remaining) {
            lines.push(modifierLine(s.name, s.value, s.significance, s.appliedTo === "dc"));
        }

        if (result.adjustment) {
            lines.push(`<em>${localize("adjusted", { label: game.i18n.localize(result.adjustment) })}</em>`);
        }
    }

    return `<div class="pf2e-mtc-tooltip">${lines.map((line) => `<div>${line}</div>`).join("")}</div>`;
}


/* -------------------------------------------- */
/*  Toolbelt damage targets                     */
/* -------------------------------------------- */

let pendingDamageTargets = null;

function toolbeltTargetHelper() {
    const toolbelt = game.toolbelt;
    if (!toolbelt?.getToolSetting?.("targetHelper", "enabled")) return null;
    return toolbelt.api?.targetHelper ?? null;
}

const DAMAGE_TARGETS_TTL_MS = 10_000;

const DAMAGE_BUTTONS = `[data-action="strike-damage"], [data-action="elemental-blast-damage"]`;

function attachDamageTargeting(message, html) {
    const context = getContext(message);
    if (!context) return;

    const isSeparate = !!findMarker(context.options, SEPARATE_PREFIX);
    const isMulti = !!message.getFlag(MODULE_ID, "targets")?.length;
    if (!isSeparate && !isMulti) return;

    for (const button of html.querySelectorAll(DAMAGE_BUTTONS)) {
        button.addEventListener(
            "click",
            () => {
                const tokens = isSeparate
                    ? [context.target?.token].filter(Boolean)
                    : tokensForOutcome(message, button.dataset.outcome === "success" ? "success" : "criticalSuccess");

                pendingDamageTargets = {
                    actorUuid: message.actor?.uuid ?? null,
                    tokens,
                    rollTarget: isSeparate ? (context.target?.token ?? null) : null,
                    expires: Date.now() + DAMAGE_TARGETS_TTL_MS
                };
            },
            true,
        );
    }
}

function onBlastDamage(wrapped, params = {}) {
    const pending = pendingDamageTargets;
    const uuid = pending && Date.now() <= pending.expires && !params.getFormula ? pending.rollTarget : null;
    const token = uuid ? fromUuidSync(uuid, { strict: false })?.object : null;
    if (!token) return wrapped(params);

    const targets = game.user.targets;
    const hadOwn = Object.prototype.hasOwnProperty.call(targets, "first");
    const previous = targets.first;
    targets.first = () => token;
    try {
        return wrapped(params);
    } finally {
        if (hadOwn) targets.first = previous;
        else delete targets.first;
    }
}

function attachSpellDamageTargeting(message, html) {
    if (!message.item?.isOfType("spell")) return;

    for (const button of html.querySelectorAll(`[data-action="spell-damage"]`)) {
        button.addEventListener(
            "click",
            () => {
                const tokens = findSpellAttackHits(message);
                if (!tokens) return;

                pendingDamageTargets = {
                    actorUuid: message.actor?.uuid ?? null,
                    tokens,
                    rollTarget: null,
                    expires: Date.now() + DAMAGE_TARGETS_TTL_MS,
                };
            },
            true,
        );
    }
}

const HIT_OUTCOMES = new Set(["success", "criticalSuccess"]);
const SPELL_ATTACK_LOOKBACK = 30;

function findSpellAttackHits(spellMessage) {
    const spellId = spellMessage.item?.id;
    const actorUuid = spellMessage.actor?.uuid;
    if (!spellId || !actorUuid) return null;

    const messages = game.messages.contents;
    let sequenceId = null;
    const hits = [];

    for (let i = messages.length - 1, n = 0; i >= 0 && n < SPELL_ATTACK_LOOKBACK; i--, n++) {
        const msg = messages[i];
        if (msg === spellMessage) break;

        const context = getContext(msg);
        if (context?.type !== "attack-roll") continue;
        if (msg.actor?.uuid !== actorUuid || msg.item?.id !== spellId) continue;

        const separate = parseSeparateMarker(findMarker(context.options, SEPARATE_PREFIX));

        if (sequenceId === null) {
            const results = getResults(msg);
            if (results) return results.filter((r) => HIT_OUTCOMES.has(r.outcome)).map((r) => r.uuid);
            if (!separate) return null;
            sequenceId = separate.sequenceId;
        }

        if (separate?.sequenceId !== sequenceId) continue;
        if (HIT_OUTCOMES.has(context.outcome) && context.target?.token) hits.push(context.target.token);
    }

    return sequenceId ? hits : null;
}

function tokensForOutcome(message, outcome) {
    return (getResults(message) ?? []).filter((r) => r.outcome === outcome).map((r) => r.uuid);
}

function applyDamageTargets(message) {
    const pending = pendingDamageTargets;
    pendingDamageTargets = null;

    if (!pending || Date.now() > pending.expires) return;
    if (pending.actorUuid && message.actor?.uuid !== pending.actorUuid) return;

    const toolbelt = toolbeltTargetHelper();
    if (!toolbelt || !pending.tokens.length) return;

    message.updateSource(toolbelt.setMessageFlagTargets({}, pending.tokens));
}

/* -------------------------------------------- */
/*  Degree of success                           */
/* -------------------------------------------- */

function getDieResult(roll) {
    if (roll.isDeterministic) {
        return roll.terms.find((t) => t instanceof foundry.dice.terms.NumericTerm)?.total ?? 1;
    }
    return roll.dice.find((d) => d instanceof foundry.dice.terms.Die && d.faces === 20)?.total ?? 1;
}

function getNaturalResult(roll) {
    return (
        roll.dice.map((d) => d.results.find((r) => r.active && !r.discarded)?.result ?? null).find((r) => !!r) ?? null
    );
}

function resolveAdjustments(entry, total, natural, context) {
    if (!entry.dos?.length) return null;

    const postRoll = [
        `check:total:${total}`,
        `check:total:natural:${natural}`,
        `check:roll:total:natural:${natural}`,
        `check:total:delta:${total - entry.dc}`,
    ];
    const baseOptions = new Set([...postRoll, ...(entry.options ?? []), ...(context?.isReroll ? ["check:reroll"] : [])]);

    const record = {};
    for (const adjustment of entry.dos) {
        const passes =
            !adjustment.predicate ||
            new game.pf2e.Predicate(adjustment.predicate).test(
                adjustment.options ? new Set([...postRoll, ...adjustment.options]) : baseOptions,
            );
        if (!passes) continue;

        for (const outcome of ["all", ...DEGREES]) {
            if (adjustment.adjustments?.[outcome]) record[outcome] = adjustment.adjustments[outcome];
        }
    }
    return record;
}

function computeDegree(total, die, dc, adjustments) {
    let degree = total - dc >= 10 ? 3 : dc - total >= 10 ? 0 : total >= dc ? 2 : 1;
    if (die === 20) degree = Math.min(3, degree + 1);
    else if (die === 1) degree = Math.max(0, degree - 1);
    const unadjusted = degree;

    let adjustment = null;
    for (const outcome of ["all", ...DEGREES]) {
        const { label, amount } = adjustments?.[outcome] ?? {};
        if (
            amount &&
            label &&
            !(degree === 3 && amount === 1) &&
            !(degree === 0 && amount === -1) &&
            (outcome === "all" || DEGREES.indexOf(outcome) === degree)
        ) {
            adjustment = { label, amount };
            break;
        }
    }

    if (adjustment) {
        degree =
            typeof adjustment.amount === "string"
                ? DEGREES.indexOf(adjustment.amount)
                : Math.clamp(degree + adjustment.amount, 0, 3);
    }

    return { outcome: DEGREES[degree], unadjusted: DEGREES[unadjusted], adjustment: adjustment?.label ?? null };
}

function resolveEntry(entry, context, roll) {
    if (entry.unresolved) return null;

    const die = getDieResult(roll);
    const natural = getNaturalResult(roll);

    if (entry.primary) {
        if (DEGREES.includes(context?.outcome)) {
            return { total: roll.total, dc: entry.dc, outcome: context.outcome, adjustment: null };
        }
        if (!Number.isFinite(entry.dc)) return null;
        return { total: roll.total, dc: entry.dc, ...computeDegree(roll.total, die, entry.dc, null) };
    }

    const total = roll.total + entry.delta;
    const adjustments = resolveAdjustments(entry, total, natural, context);
    return { total, dc: entry.dc, ...computeDegree(total, die, entry.dc, adjustments) };
}

function getResults(message) {
    const entries = message.getFlag(MODULE_ID, "targets");
    const roll = message.rolls?.[0];
    if (!entries?.length || !roll) return null;

    const context = getContext(message);
    return entries.map((entry) => ({ uuid: entry.uuid, delta: entry.delta ?? null, ...resolveEntry(entry, context, roll) }));
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function canSeeName(tokenDoc) {
    if (game.user.isGM || tokenDoc.isOwner) return true;
    if (!game.pf2e?.settings?.tokens?.nameVisibility) return true;
    return !!tokenDoc.playersCanSeeName;
}

function isTokenHidden(tokenDoc) {
    if (tokenDoc.hidden) return true;
    if (tokenDoc.hasPlayerOwner) return false;
    return !!tokenDoc.scene?.tokenVision && !!tokenDoc.actor?.hasCondition?.("unnoticed", "undetected");
}

function renderTargets(message, html) {
    const entries = message.getFlag(MODULE_ID, "targets");
    if (!entries?.length) return;
    if (message.isContentVisible === false) return;

    const roll = message.rolls?.[0];
    if (!roll) return;

    const context = getContext(message);
    const isAC = context?.type === "attack-roll" || context?.dc?.slug === "ac";

    const isGM = game.user.isGM;
    const metagame = game.pf2e?.settings?.metagame ?? {};
    const origin = message.actor;
    const originFriendly = !origin || origin.isOwner || origin.hasPlayerOwner;
    const baseShowDC = isGM || !!metagame.dcs;
    const baseShowResults = isGM || !!metagame.results || originFriendly;
    const showBreakdown = isGM || !!metagame.breakdowns || !!origin?.isOwner;
    const mmEveryone = mmShowsToEveryone();

    const rows = [];
    for (const entry of entries) {
        const tokenDoc = fromUuidSync(entry.uuid, { strict: false });
        if (!tokenDoc) continue;

        const hidden = isTokenHidden(tokenDoc);
        if (hidden && !isGM) continue;

        const targetFriendly = tokenDoc.isOwner || tokenDoc.hasPlayerOwner;

        rows.push({
            tokenDoc,
            entry,
            result: resolveEntry(entry, context, roll),
            hidden,
            showDC: baseShowDC || targetFriendly,
            showResults: baseShowResults || targetFriendly,
            showSignificant: showBreakdown || mmEveryone || targetFriendly,
            showDetails: showBreakdown || targetFriendly,
        });
    }
    if (!rows.length) return;

    rows.sort((a, b) => a.tokenDoc.name.localeCompare(b.tokenDoc.name));

    const wrapper = document.createElement("div");
    wrapper.classList.add("pf2e-mtc");

    const header = document.createElement("div");
    header.classList.add("pf2e-mtc-header");
    header.textContent = localize("header");
    wrapper.append(header);

    const dcLabelKey = isAC ? "ac" : "dc";

    for (const { tokenDoc, entry, result, hidden, showDC, showResults, showSignificant, showDetails } of rows) {
        const row = document.createElement("div");
        row.classList.add("pf2e-mtc-row");
        if (hidden) row.classList.add("hidden-token");

        const name = document.createElement("span");
        name.classList.add("pf2e-mtc-name");
        name.textContent = canSeeName(tokenDoc) ? tokenDoc.name : localize("unnamed");

        const totalEl = document.createElement("span");
        totalEl.classList.add("pf2e-mtc-total");
        if (showBreakdown && result) {
            totalEl.textContent = String(result.total);
            if (entry.delta) {
                totalEl.dataset.tooltip = localize("delta", { delta: signed(entry.delta) });
            }
        }

        const dcEl = document.createElement("span");
        dcEl.classList.add("pf2e-mtc-dc");
        const dcText = showDC && result && Number.isFinite(result.dc) ? localize(dcLabelKey, { dc: result.dc }) : "";
        dcEl.textContent = dcText && totalEl.textContent ? localize("vs", { dc: dcText }) : dcText;
        const defenseModifiers = getRowDefenseModifiers(entry);
        if (showBreakdown && dcText && defenseModifiers.length) {
            dcEl.dataset.tooltip = defenseModifiers
                .map((m) => `${game.i18n.localize(m.label)} ${signed(m.modifier)}`)
                .join("<br>");
        }

        const outcomeEl = document.createElement("span");
        outcomeEl.classList.add("pf2e-mtc-outcome");
        if (!result) {
            outcomeEl.textContent = "—";
            outcomeEl.dataset.tooltip = localize("unresolved");
        } else if (showResults) {
            outcomeEl.classList.add(result.outcome);
            outcomeEl.textContent = game.i18n.localize(`PF2E.Check.Result.Degree.Check.${result.outcome}`);
            const significant = showSignificant ? getSignificantModifiers(message, entry, result, roll, isAC) : [];
            const strongest = strongestSignificance(significant);
            if (strongest) outcomeEl.classList.add("pf2e-mtc-significant", `pf2e-mtc-sig-${strongest}`);

            outcomeEl.dataset.tooltip = buildBreakdownTooltip({
                message,
                entry,
                result,
                roll,
                dcText,
                showDC,
                showResults,
                showDetails,
                significant,
            });
        } else {
            outcomeEl.textContent = localize("hiddenOutcome");
        }

        row.append(name, totalEl, dcEl, outcomeEl);

        row.addEventListener("mouseenter", (event) => tokenDoc.object?._onHoverIn?.(event, { hoverOutOthers: true }));
        row.addEventListener("mouseleave", (event) => tokenDoc.object?._onHoverOut?.(event));
        name.addEventListener("click", (event) => {
            event.stopPropagation();
            const token = tokenDoc.object;
            if (token && tokenDoc.parent === canvas.scene) {
                canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
            }
        });
        name.addEventListener("dblclick", (event) => {
            event.stopPropagation();
            tokenDoc.actor?.sheet?.render(true);
        });

        wrapper.append(row);
    }

    const content = html.querySelector(".message-content") ?? html;
    content.append(wrapper);
}