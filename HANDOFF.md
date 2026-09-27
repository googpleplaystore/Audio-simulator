# Handoff: work in progress

## Hardware add-ons (custom speakers/subwoofers) — mostly done, untested in the browser
Done:
- `src/hardware/addons.js`: add-on JSON format (`"format": "audiospace-hardware", "version": 1`), validator with path-specific errors, measured-response → voicing fit, `addonTemplate()`.
- `src/hardware/addonStore.js`: localStorage persistence, install/remove, registered at startup (`App.init`) before settings load.
- `src/hardware/index.js`: custom-model registry (`setCustomHardware`, `resolveHardware`); `src/hardware/response.js` split out.
- `src/core/settings.js` `fixModelIds()`: unknown models fall back to defaults (also used by scenes).
- UI: `src/ui/components/addonManager.js` (Hardware Catalog → "Add-ons" button: import file / paste JSON / template / field reference / remove); dropping `.json` files on the app imports add-ons; custom badges, measured-response overlay on model pages.
- Fixed: Room/Receiver/Crossover views crashed on unknown model ids.

Still to do:
1. Run the app and try the Add-ons dialog end to end (import template, assign to L+R, reload, remove).
2. `scripts/validate-addon.mjs <file>` CLI (wrap `validateAddon`, print errors/warnings, exit 1 on errors).
3. Claude Code skill `.claude/skills/audiospace-addon/SKILL.md`: gather specs → write `addons/<name>.audiospace.json` → run the CLI → fix → tell the user to import it. Field docs: `SPEAKER_FIELDS` / `SUB_FIELDS` in `src/hardware/addons.js`.
4. Docs: `docs/addons/README.md`, JSON schema, example add-ons; README section.
5. Tests: unit tests for `validateAddon`/`addonStore`/`fixModelIds`; an E2E step for importing an add-on.

## Then: bug hunt
Fuzz the tag parsers, monkey-test all views for console errors, review risky modules; fix with regression tests.

Checks: `npm test`, `npm run lint`, `npm run test:e2e`, `(cd desktop && go test ./...)`.
