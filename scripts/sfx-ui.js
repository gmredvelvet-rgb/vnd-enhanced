const ID = "vnd-enhanced";

export class SfxSettingsApp extends FormApplication {
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "vne-sfx-settings",
      classes: ["vne-settings"],
      title: game.i18n.localize("vnd-enhanced.settings.sfxMenu.title") || "VNE SFX Settings",
      template: `modules/${ID}/templates/sfx-settings.hbs`,
      width: 640
    });
  }

  async getData() {
    return {
      sfxFolder: game.settings.get(ID, "sfxFolder") || "",
      enableSfx: game.settings.get(ID, "enableSfx") || false,
      sfxTurnStart: game.settings.get(ID, "sfxTurnStart") || "",
      sfxVictory: game.settings.get(ID, "sfxVictory") || "",
      sfxDefeat: game.settings.get(ID, "sfxDefeat") || ""
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Play preview buttons
    html.find(".vne-sfx-play").click(async (ev) => {
      const key = ev.currentTarget.dataset.key;
      const folder = html.find('input[name="sfxFolder"]').val() || "";
      const file = html.find(`input[name="${key}"]`).val() || "";
      const src = folder ? `${folder}/${file}` : file;
      // Validate file exists before attempting playback
      const ok = await this._fileExists(src);
      if (!ok) {
        ui.notifications.warn(game.i18n.localize("vnd-enhanced.settings.sfxMenu.missingFile") || "SFX file not found: " + src);
        html.find(`.vne-sfx-status[data-key="${key}"]`).text("(missing)").addClass("vne-sfx-missing");
        return;
      }
      try { AudioHelper.play({ src }, true); } catch (e) { try { AudioHelper.play(src, true); } catch { ui.notifications.error("SFX preview failed"); } }
      html.find(`.vne-sfx-status[data-key="${key}"]`).text("(ok)").removeClass("vne-sfx-missing");
    });

    // Browse file picker
    html.find(".vne-sfx-browse").click((ev) => {
      const key = ev.currentTarget.dataset.key;
      const folder = html.find('input[name="sfxFolder"]').val() || "";
      const fp = new FilePicker({
        type: "audio",
        current: folder,
        callback: (path) => {
          // path may be full path; prefer filename only for these settings
          const name = path.split('/').pop();
          html.find(`input[name="${key}"]`).val(name);
        }
      });
      fp.render(true);
    });

    // Validate all files button
    html.find('.vne-sfx-validate').click(async (ev) => {
      ev.preventDefault();
      const folder = html.find('input[name="sfxFolder"]').val() || "";
      const keys = ["sfxTurnStart", "sfxVictory", "sfxDefeat"];
      for (const key of keys) {
        const file = html.find(`input[name="${key}"]`).val() || "";
        const src = folder ? `${folder}/${file}` : file;
        const ok = await this._fileExists(src);
        const statusEl = html.find(`.vne-sfx-status[data-key="${key}"]`);
        if (ok) { statusEl.text("(ok)").removeClass('vne-sfx-missing'); }
        else    { statusEl.text("(missing)").addClass('vne-sfx-missing'); }
      }
      ui.notifications.info(game.i18n.localize("vnd-enhanced.settings.sfxMenu.validated") || "SFX validation complete");
    });

    // Inline input change: clear status so user re-validates
    html.find('input[name="sfxFolder"], input[name="sfxTurnStart"], input[name="sfxVictory"], input[name="sfxDefeat"]').on('input', (ev) => {
      const name = ev.currentTarget.name;
      html.find(`.vne-sfx-status[data-key="${name}"]`).text("").removeClass('vne-sfx-missing');
    });
  }

  async _updateObject(event, formData) {
    // Persist settings (world for folder and event filenames; client for enableSfx)
    await game.settings.set(ID, "sfxFolder", (formData.sfxFolder || "").toString());
    await game.settings.set(ID, "sfxTurnStart", (formData.sfxTurnStart || "").toString());
    await game.settings.set(ID, "sfxVictory", (formData.sfxVictory || "").toString());
    await game.settings.set(ID, "sfxDefeat", (formData.sfxDefeat || "").toString());
    await game.settings.set(ID, "enableSfx", !!formData.enableSfx);

    // Validate files post-save and warn non-critically if missing
    const folder = (formData.sfxFolder || "").toString();
    const toCheck = ["sfxTurnStart", "sfxVictory", "sfxDefeat"];
    const missing = [];
    for (const key of toCheck) {
      const file = (formData[key] || "").toString();
      const src = folder ? `${folder}/${file}` : file;
      // eslint-disable-next-line no-await-in-loop
      const ok = await this._fileExists(src);
      if (!ok) missing.push(src);
    }
    if (missing.length) {
      ui.notifications.warn(game.i18n.localize("vnd-enhanced.settings.sfxMenu.missingOnSave") || `Some SFX files were not found: ${missing.join(', ')}`);
    } else {
      ui.notifications?.info(game.i18n.localize("vnd-enhanced.settings.sfxMenu.saved") || "SFX settings saved");
    }
  }

  // Check whether a given src exists via a HEAD request
  async _fileExists(src) {
    if (!src) return false;
    try {
      const res = await fetch(src, { method: 'HEAD' });
      return res.ok;
    } catch (e) {
      return false;
    }
  }
}
