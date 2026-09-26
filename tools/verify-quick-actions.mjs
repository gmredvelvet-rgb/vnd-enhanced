import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = fs.readFileSync(path.join(root, "scripts", "main.js"), "utf8").replaceAll("\r\n", "\n");
const en = JSON.parse(fs.readFileSync(path.join(root, "language", "en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(root, "language", "es.json"), "utf8"));

for (const marker of [
  'traits.includes("impulse")',
  '["action", "reaction", "free"].includes(actionType)',
  "win?._vneAbortController?.abort();",
  'closeQuickActionWindow();\n    await _useQuickAction(actor, entry, e, variantIdx);'
]) {
  assert.ok(main.includes(marker), `Missing quick-action behavior: ${marker}`);
}

for (const locale of [en, es]) {
  const qa = locale["vnd-enhanced"].qa;
  for (const key of ["impulse", "actionCost", "reaction", "freeAction"]) {
    assert.equal(typeof qa[key], "string", `Missing localization: qa.${key}`);
  }
}

const items = [
  { name: "Hail of Splinters", type: "feat", actionType: "action", traits: ["impulse", "kineticist"] },
  { name: "Aura", type: "feat", actionType: "passive", traits: ["kineticist"] },
  { name: "Reactive Strike", type: "feat", actionType: "reaction", traits: ["impulse"] },
  { name: "General Feat", type: "feat", actionType: "action", traits: ["general"] }
];
const shownAsActions = items.filter(item => item.type === "feat"
  && item.traits.includes("impulse")
  && ["action", "reaction", "free"].includes(item.actionType));

assert.deepEqual(shownAsActions.map(item => item.name), ["Hail of Splinters", "Reactive Strike"]);
console.log("Quick-action verification passed.");
