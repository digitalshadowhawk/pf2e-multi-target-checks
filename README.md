# PF2e Multi-Target Checks

A Foundry VTT module for **Pathfinder 2e** and **Starfinder 2e** that resolves check rolls against **every** targeted creature, not just the first one.

## Features

### One roll, many targets

Target several creatures and roll as usual: a Strike, a skill action like Demoralize or Feint, a spell attack, or an Elemental Blast. The chat card gets a row for each target:

```
Targets
Goblin Warrior    23   vs. AC 16   Critical Success
Goblin Archer     21   vs. AC 18   Success
Bugbear Thug      21   vs. AC 22   Failure
```

Each row is resolved properly against **that** target, including:

- Target-specific modifiers, such as range increments, bonuses against certain traits, and Demoralize's penalty against a creature that doesn't understand you
- Contextual changes to the target's defense, such as flanking off-guard
- Degree-of-success adjustments and incapacitation
- Natural 20s and 1s

Hover a row's total to see how its modifiers differ from the primary target listed in the base chat card. Hover the DC or AC to see any contextual defense modifiers.

Rerolls (hero points, mythic points, and so on) update every row.

### Separate rolls per target

Some abilities call for a separate roll against each target, *Whirlwind Strike* for example. **Hold `X`** (rebindable under *Configure Controls*) while you click the Strike, action, or blast, and the module makes one full, normal roll per target instead:

- Each roll gets its own chat card, its own damage button, and its own critical hit
- All Strikes use the multiple attack penalty you clicked
- The roll dialog appears once. Whatever you change in it (extra modifiers, unchecked modifiers, fortune or misfortune, roll mode) applies to every roll
- Targets beyond an Elemental Blast's maximum range are skipped with a warning

### Metagame Settings

- accounts for PF2e's metagame settings for showing DCs, results, and breakdowns
- Players always see their own results when an enemy rolls against them
- Hidden, unnoticed, and undetected tokens are only shown to the GM
- Token name visibility is respected
- Blind rolls stay hidden

## Integrations (optional)

- **[PF2e Toolbelt](https://github.com/reonZ/pf2e-toolbelt)** (Target Helper): damage cards created from this module's rolls get the right targets. A separate roll's damage goes to that roll's target. A shared roll's **Damage** and **Critical** buttons go to the targets that hit or critically hit. A spell card's damage goes to the targets the spell attack hit.
- **[PF2e Modifiers Matter](https://github.com/shemetz/pf2e-modifiers-matter)**: each target row is highlighted when a modifier changed that target's result, using Modifiers Matter's own logic, ignore lists, and colors. Hover the result to see which modifiers mattered.

## Requirements

- Foundry VTT v14
- Pathfinder 2e or Starfinder 2e system
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)

## Installation

In Foundry's **Add-on Modules** tab, choose **Install Module** and paste this manifest URL:

```
https://github.com/digitalshadowhawk/pf2e-multi-target-checks/releases/latest/download/module.json
```

Then enable **PF2e Multi-Target Checks** in your world.

## For macro authors

Results for any multi-target message are available through the module's API:

```js
const api = game.modules.get("pf2e-multi-target-checks").api;
const results = api.getResults(message); // null if the message has no multi-target data
```

Each entry looks like:

```js
{
    uuid: "Scene.abc.Token.xyz", // target token UUID
    total: 23,                   // this target's total
    dc: 18,                      // this target's DC or AC
    delta: 2,                    // modifier difference from the primary target
    outcome: "success",          // criticalFailure | failure | success | criticalSuccess
    unadjusted: "success",       // before degree-of-success adjustments
    adjustment: null,            // label of the adjustment that applied, if any
}
```

## Known limitations

- **Fortune and misfortune** that only apply against some targets aren't split: a shared roll uses one d20 for everyone.
- **Spells with both an attack and a save**: Toolbelt replaces the hit-only damage targets with the spell card's targets.
- **Escape using an unarmed attack** isn't covered. Escape with Acrobatics or Athletics is, but Escape is a single-target action anyway, so this shouldn't generally come up.

## License

[MIT](LICENSE)