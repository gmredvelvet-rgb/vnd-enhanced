/**
 * Velvet License Hub — the bridge this module shares with the rest of the family.
 *
 * With the hub active, the licence is the hub's: this module registers with it
 * and shows no card, reminder or licence menu of its own — one Patreon
 * connection covers every module. Without the hub, the module's own licence
 * flow runs exactly as it always did.
 *
 * Identical in every module; the contract lives in velvet-license-hub
 * (README, docs/PLAN-HUB-ROLLOUT.md → D9). Change it there, not here.
 */

const HUB_ID = "velvet-license-hub";

/**
 * The hub's API when it is active and at least `minVersion`, else null.
 *
 * An active hub whose API never appeared (it failed to initialise) counts as
 * absent: better a second card than a module that never asks at all.
 * @param {number} [minVersion]  1 to register; 2 for hasVerdict() and request().
 * @returns {object|null}
 */
export function licenseHub(minVersion = 1) {
  const hub = game.modules.get(HUB_ID);
  return (hub?.active && (hub.api?.apiVersion >= minVersion)) ? hub.api : null;
}

/**
 * Whether the hub is active in this world. All that can be known in `init`:
 * the hub publishes its API from its own init hook, which may not have run yet.
 * @returns {boolean}
 */
export function hubActive() {
  return game.modules.get(HUB_ID)?.active === true;
}

/**
 * This module's effective licence.
 *
 * The hub decides once it has spoken for this world. Until then the module's
 * own older `worldLicensed` flag still counts, so a patron who already paid
 * loses nothing by updating before they connect the hub. Valid from `setup`
 * on: the hub registers its settings in `init`.
 * @param {string} moduleId
 * @returns {boolean}
 */
export function isModuleLicensed(moduleId) {
  const hub = licenseHub(2);
  if ( hub?.hasVerdict() ) return hub.isLicensed(moduleId);
  try {
    return game.settings.get(moduleId, "worldLicensed") === true;
  }
  catch ( err ) {
    return false;
  }
}
