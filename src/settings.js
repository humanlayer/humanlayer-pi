import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_SETTINGS = Object.freeze({ defaultMirroring: "on" });

const settingsFilePath = () => join(getAgentDir(), "settings.json");

async function readSettingsDocument() {
  let text;
  try {
    text = await readFile(settingsFilePath(), "utf8");
  } catch (err) {
    if (err.code === "ENOENT")
      return {};
    throw err;
  }
  const document = JSON.parse(text);
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error("Pi settings.json must contain an object");
  const settings = document.humanlayer;
  if (settings !== undefined) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("Pi settings.json humanlayer must contain an object");
    if (settings.defaultMirroring !== undefined && settings.defaultMirroring !== "on" && settings.defaultMirroring !== "off")
      throw new Error("humanlayer.defaultMirroring must be on or off");
  }
  return document;
}

export function createHumanlayerSettings({ withFileLock, writeJsonFileAtomic }) {
  return {
    async load() {
      const document = await readSettingsDocument();
      return { defaultMirroring: document.humanlayer?.defaultMirroring ?? DEFAULT_SETTINGS.defaultMirroring };
    },
    async save(settings) {
      if (settings.defaultMirroring !== "on" && settings.defaultMirroring !== "off")
        throw new Error("humanlayer.defaultMirroring must be on or off");
      const file = settingsFilePath();
      await withFileLock(`${file}.humanlayer.lock`, async () => {
        const document = await readSettingsDocument();
        document.humanlayer = { ...document.humanlayer, ...settings };
        await writeJsonFileAtomic(file, document);
      });
    },
    statusLines(settings) {
      return [`default mirroring: ${settings.defaultMirroring}`];
    }
  };
}
