import { CATEGORY_COLORS, CHECKLIST_STEPS, ENTRY_TYPES, DEFAULT_SETTINGS } from '../shared/types.ts';
import {
  DEFAULT_GENERATOR_OPTIONS,
  MAX_LENGTH,
  MAX_PIN,
  MAX_WORDS,
  MIN_LENGTH,
  MIN_PIN,
  MIN_WORDS,
  SEPARATORS,
} from '../shared/generator.ts';
import type { GeneratorMode, GeneratorOptions } from '../shared/generator.ts';
import type { ChecklistStep, CustomField, EntryInput, EntryType, Settings } from '../shared/types.ts';
import { randomId } from './crypto.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LIMITS = {
  title: 200,
  username: 512,
  password: 4096,
  url: 2048,
  notes: 100_000,
  codes: 20_000,
  fieldLabel: 100,
  fieldValue: 10_000,
  fields: 50,
  icon: 200_000,
} as const;

/** Item icons are small raster images, stored as data URLs inside the encrypted item. */
function icon(value: unknown): string {
  const s = str(value, LIMITS.icon, 'Icon');
  if (s === 'none') return s;
  // A coloured letter tile: 'tint:' + one of the shared colour names.
  if (s.startsWith('tint:')) {
    if (!Object.hasOwn(CATEGORY_COLORS, s.slice(5))) throw new HttpError(400, 'Unknown icon colour');
    return s;
  }
  if (s && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(s)) throw new HttpError(400, 'Icon must be a PNG, JPEG or WebP image');
  return s;
}

function str(value: unknown, max: number, name: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  if (value.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`);
  return value;
}

function customFields(value: unknown): CustomField[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'customFields must be an array');
  if (value.length > LIMITS.fields) throw new HttpError(400, `Too many custom fields (max ${LIMITS.fields})`);
  return value.map((f: unknown) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return {
      id: typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 64 ? o.id : randomId(),
      label: str(o.label, LIMITS.fieldLabel, 'Field label').trim(),
      value: str(o.value, LIMITS.fieldValue, 'Field value'),
      hidden: Boolean(o.hidden),
    };
  });
}

export function sanitizeEntryInput(raw: unknown): EntryInput {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Invalid entry');
  const o = raw as Record<string, unknown>;
  const type = o.type as EntryType;
  if (!ENTRY_TYPES.includes(type)) throw new HttpError(400, 'Invalid entry type');
  const title = str(o.title, LIMITS.title, 'Title').trim();
  if (!title) throw new HttpError(400, 'Title is required');
  const categoryId = o.categoryId === null || o.categoryId === undefined || o.categoryId === '' ? null : o.categoryId;
  if (categoryId !== null && (typeof categoryId !== 'string' || categoryId.length > 64)) {
    throw new HttpError(400, 'Invalid category');
  }
  return {
    type,
    title,
    username: str(o.username, LIMITS.username, 'Username').trim(),
    password: str(o.password, LIMITS.password, 'Password'),
    url: str(o.url, LIMITS.url, 'URL').trim(),
    notes: str(o.notes, LIMITS.notes, 'Notes'),
    codes: str(o.codes, LIMITS.codes, 'Recovery codes'),
    categoryId,
    favorite: Boolean(o.favorite),
    icon: icon(o.icon),
    customFields: customFields(o.customFields),
  };
}

export function sanitizeCategoryName(raw: unknown): string {
  const name = str(raw, 60, 'Category name').trim();
  if (!name) throw new HttpError(400, 'Category name is required');
  return name;
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function generatorOptions(raw: unknown, current: GeneratorOptions): GeneratorOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = { ...DEFAULT_GENERATOR_OPTIONS, ...current };
  const flag = (k: keyof GeneratorOptions) => (Object.hasOwn(o, k) ? Boolean(o[k]) : (base[k] as boolean));
  const num = (k: keyof GeneratorOptions, min: number, max: number) =>
    Object.hasOwn(o, k) ? intIn(o[k], min, max, base[k] as number) : (base[k] as number);
  const next: GeneratorOptions = {
    mode: (['random', 'passphrase', 'pin'] as const).includes(o.mode as GeneratorMode) ? (o.mode as GeneratorMode) : base.mode,
    length: num('length', MIN_LENGTH, MAX_LENGTH),
    lowercase: flag('lowercase'),
    uppercase: flag('uppercase'),
    digits: flag('digits'),
    symbols: flag('symbols'),
    excludeAmbiguous: flag('excludeAmbiguous'),
    words: num('words', MIN_WORDS, MAX_WORDS),
    separator: (SEPARATORS as readonly string[]).includes(o.separator as string) ? (o.separator as string) : base.separator,
    capitalize: flag('capitalize'),
    includeNumber: flag('includeNumber'),
    pinLength: num('pinLength', MIN_PIN, MAX_PIN),
  };
  if (!(next.lowercase || next.uppercase || next.digits || next.symbols)) {
    Object.assign(next, { lowercase: base.lowercase, uppercase: base.uppercase, digits: base.digits, symbols: base.symbols });
  }
  return next;
}

/** Per-kind "hide icons" switches. Also reads the older single login switch. */
function hideIcons(o: Record<string, unknown>, current: Settings['hideIcons']): Settings['hideIcons'] {
  const next = { ...current };
  if (typeof o.hideLoginIcons === 'boolean') next.login = o.hideLoginIcons;
  const raw = o.hideIcons;
  if (raw && typeof raw === 'object') {
    for (const type of ENTRY_TYPES) {
      const v = (raw as Record<string, unknown>)[type];
      if (typeof v === 'boolean') next[type] = v;
    }
  }
  return next;
}

function checklist(raw: unknown): Settings['checklist'] {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const done = Array.isArray(o.done) ? CHECKLIST_STEPS.filter((s: ChecklistStep) => (o.done as unknown[]).includes(s)) : [];
  return { tourSeen: Boolean(o.tourSeen), done };
}

export function sanitizeSettings(raw: unknown, current: Settings = DEFAULT_SETTINGS): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const has = (k: keyof Settings) => Object.hasOwn(o, k);
  return {
    autoLockMinutes: has('autoLockMinutes') ? intIn(o.autoLockMinutes, 1, 240, current.autoLockMinutes) : current.autoLockMinutes,
    clipboardClearSeconds: has('clipboardClearSeconds')
      ? intIn(o.clipboardClearSeconds, 0, 600, current.clipboardClearSeconds)
      : current.clipboardClearSeconds,
    outdatedDays: has('outdatedDays') ? intIn(o.outdatedDays, 30, 3650, current.outdatedDays) : current.outdatedDays,
    breachCheckEnabled: has('breachCheckEnabled') ? Boolean(o.breachCheckEnabled) : current.breachCheckEnabled,
    lockOnHiddenSeconds: has('lockOnHiddenSeconds')
      ? intIn(o.lockOnHiddenSeconds, 0, 3600, current.lockOnHiddenSeconds)
      : current.lockOnHiddenSeconds,
    generator: has('generator') ? generatorOptions(o.generator, current.generator) : current.generator,
    appearance: has('appearance') && ['system', 'light', 'dark'].includes(o.appearance as string)
      ? (o.appearance as Settings['appearance'])
      : current.appearance,
    hideIcons: hideIcons(o, current.hideIcons),
    categoriesEnabled: has('categoriesEnabled') ? Boolean(o.categoriesEnabled) : (current.categoriesEnabled ?? true),
    checklist: has('checklist') ? checklist(o.checklist) : (current.checklist ?? null),
  };
}

export function requireString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`);
  if (value.length > max) throw new HttpError(400, `${name} is too long`);
  return value;
}
