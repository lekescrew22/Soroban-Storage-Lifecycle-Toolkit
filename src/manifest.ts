import { parseStorageKey } from "./ledger-key.js";

export interface StorageKeyManifestEntry {
  name: string;
  key: string;
  owner?: string;
  notes?: string;
}

export interface StorageKeyManifest {
  version: 1;
  entries: StorageKeyManifestEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(
  value: unknown,
  field: string,
  entryNumber: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Manifest entry ${entryNumber} "${field}" must be non-empty text`,
    );
  }
  return value.trim();
}

export function parseStorageKeyManifest(value: unknown): StorageKeyManifest {
  if (!isObject(value)) {
    throw new Error("Key manifest must be a JSON object");
  }
  if (value.version !== 1) {
    throw new Error('Key manifest "version" must be 1');
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error('Key manifest "entries" must be a non-empty array');
  }
  if (value.entries.length > 200) {
    throw new Error("Key manifest may contain at most 200 entries");
  }

  const names = new Set<string>();
  const keys = new Set<string>();
  const entries = value.entries.map((entry, index): StorageKeyManifestEntry => {
    const entryNumber = index + 1;
    if (!isObject(entry)) {
      throw new Error(`Manifest entry ${entryNumber} must be an object`);
    }
    const unknownFields = Object.keys(entry).filter(
      (field) => !["name", "key", "owner", "notes"].includes(field),
    );
    if (unknownFields.length > 0) {
      throw new Error(
        `Manifest entry ${entryNumber} has unknown field(s): ${unknownFields.join(", ")}`,
      );
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new Error(
        `Manifest entry ${entryNumber} requires a non-empty "name"`,
      );
    }
    const name = entry.name.trim();
    if (names.has(name)) {
      throw new Error(`Manifest contains duplicate name "${name}"`);
    }
    if (typeof entry.key !== "string") {
      throw new Error(`Manifest entry "${name}" requires a ledger-key "key"`);
    }
    let key: string;
    try {
      key = parseStorageKey(entry.key).xdr;
    } catch (error) {
      throw new Error(
        `Manifest entry "${name}" has an invalid ledger key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (keys.has(key)) {
      throw new Error(`Manifest contains duplicate ledger key for "${name}"`);
    }
    const owner = optionalText(entry.owner, "owner", entryNumber);
    const notes = optionalText(entry.notes, "notes", entryNumber);
    names.add(name);
    keys.add(key);
    return {
      name,
      key,
      ...(owner === undefined ? {} : { owner }),
      ...(notes === undefined ? {} : { notes }),
    };
  });
  return { version: 1, entries };
}
