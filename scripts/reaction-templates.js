const ID = "vnd-enhanced";

export class ReactionTemplatesApp extends FormApplication {
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "vne-reaction-templates",
      classes: ["vne-settings"],
      title: game.i18n.localize("vnd-enhanced.settings.reactionMenu.title") || "VNE Reaction Templates",
      template: `modules/${ID}/templates/reaction-templates.hbs`,
      width: 700
    });
  }

  async getData() {
    const templates = game.settings.get(ID, "vnReactionTemplates") || {};
    const d = getDataRO();
    // snapshot of current portraits for preview purposes
    const portraits = { ...d.portraits };
    return { templates, portraits };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('.vne-rt-save').click(async (ev) => {
      ev.preventDefault();
      const name = html.find('input[name="templateName"]').val()?.trim();
      if (!name) return ui.notifications.warn(game.i18n.localize("vnd-enhanced.settings.reactionMenu.nameRequired") || "Name required");
      // Build mapping: actorId -> activeReaction (from portraits)
      const d = getDataRO();
      const mapping = {};
      for (const p of [...(d.leftCast ?? []), ...(d.rightCast ?? [])]) {
        const portrait = d.portraits?.[p.id];
        if (portrait && portrait.activeReaction) mapping[p.id] = portrait.activeReaction;
      }
      const templates = game.settings.get(ID, "vnReactionTemplates") || {};
      templates[name] = mapping;
      await game.settings.set(ID, "vnReactionTemplates", templates);
      ui.notifications.info(game.i18n.localize("vnd-enhanced.settings.reactionMenu.saved") || "Template saved");
      this.render();
    });

    html.find('.vne-rt-apply').click(async (ev) => {
      ev.preventDefault();
      const name = ev.currentTarget.dataset.name;
      const templates = game.settings.get(ID, "vnReactionTemplates") || {};
      const mapping = templates[name];
      if (!mapping) return ui.notifications.error("Template not found");
      for (const [actorId, reactionName] of Object.entries(mapping)) {
        // Use setReaction which will route via socket for non-GM clients
        try { await setReaction(actorId, reactionName); } catch (e) { /* ignore per-item errors */ }
      }
      ui.notifications.info(game.i18n.localize("vnd-enhanced.settings.reactionMenu.applied") || "Template applied");
    });

    html.find('.vne-rt-delete').click(async (ev) => {
      ev.preventDefault();
      const name = ev.currentTarget.dataset.name;
      const templates = game.settings.get(ID, "vnReactionTemplates") || {};
      if (!templates[name]) return;
      delete templates[name];
      await game.settings.set(ID, "vnReactionTemplates", templates);
      ui.notifications.info(game.i18n.localize("vnd-enhanced.settings.reactionMenu.deleted") || "Template deleted");
      this.render();
    });
  }

  async _updateObject(ev, formData) {
    // Nothing to persist via form submit — actions handled by buttons
    return;
  }
}
