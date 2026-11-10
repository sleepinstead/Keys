// Types shared between the Node backend and the React client.
import { DEFAULT_GENERATOR_OPTIONS } from './generator.ts';
import type { GeneratorOptions } from './generator.ts';

export type EntryType = 'login' | 'note' | 'apiKey' | 'recovery';

export const ENTRY_TYPES: readonly EntryType[] = ['login', 'note', 'apiKey', 'recovery'];

export interface CustomField {
  id: string;
  label: string;
  value: string;
  hidden: boolean;
}

export interface PasswordHistoryItem {
  password: string;
  changedAt: number;
}

export interface BreachResult {
  count: number;
  checkedAt: number;
}

/** Everything inside an entry. Stored only as AES-256-GCM ciphertext. */
export interface EntryData {
  type: EntryType;
  title: string;
  /** Login username, API key ID, or the account a set of recovery codes belongs to. */
  username: string;
  /** Login password or API secret. */
  password: string;
  url: string;
  notes: string;
  /** Recovery codes, one per line. */
  codes: string;
  categoryId: string | null;
  favorite: boolean;
  /**
   * Picture for the item: a small PNG data URL; '' means none yet (a login's
   * website icon may be fetched); 'none' means the user chose the letter.
   */
  icon: string;
  customFields: CustomField[];
  passwordUpdatedAt: number;
  history: PasswordHistoryItem[];
  breach: BreachResult | null;
}

export interface Entry extends EntryData {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** Fields the client may send when creating or updating an entry. */
export type EntryInput = Pick<
  EntryData,
  'type' | 'title' | 'username' | 'password' | 'url' | 'notes' | 'codes' | 'categoryId' | 'favorite' | 'icon' | 'customFields'
>;

/** List view of an entry: no secrets. */
export interface EntrySummary {
  id: string;
  type: EntryType;
  title: string;
  username: string;
  url: string;
  categoryId: string | null;
  favorite: boolean;
  icon: string;
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Category {
  id: string;
  name: string;
  /** One of CATEGORY_COLORS, or null for the plain grey folder. */
  color: CategoryColor | null;
  createdAt: number;
}

/** Folder colours a category can have. */
export const CATEGORY_COLORS = {
  gray: '#737373',
  red: '#dc2626',
  orange: '#ea580c',
  amber: '#d97706',
  yellow: '#ca8a04',
  lime: '#65a30d',
  green: '#16a34a',
  teal: '#0d9488',
  cyan: '#0891b2',
  blue: '#2563eb',
  indigo: '#4f46e5',
  violet: '#7c3aed',
  pink: '#db2777',
  rose: '#e11d48',
} as const;
export type CategoryColor = keyof typeof CATEGORY_COLORS;

export interface Settings {
  /** Idle minutes before the vault locks itself. */
  autoLockMinutes: number;
  /** Seconds before copied secrets are wiped from the clipboard. 0 disables. */
  clipboardClearSeconds: number;
  /** Passwords older than this are flagged as outdated. */
  outdatedDays: number;
  /** Opt-in: allow k-anonymity lookups against Have I Been Pwned. */
  breachCheckEnabled: boolean;
  /** Lock as soon as the Keys tab is hidden for this many seconds. 0 disables. */
  lockOnHiddenSeconds: number;
  /** Last-used password generator options. */
  generator: GeneratorOptions;
  /** Colour theme. Not secret, so it's also shown on the lock screen. */
  appearance: Appearance;
  /**
   * Item kinds shown as plain text rows, without an icon. Hiding login icons
   * also stops website icons being fetched.
   */
  hideIcons: Record<EntryType, boolean>;
  /** Whether categories are enabled in the vault. */
  categoriesEnabled: boolean;
  /** First-run welcome inside the app. Null once it's finished, and for vaults made before it existed. */
  checklist: { tourSeen: boolean; done: ChecklistStep[] } | null;
}

export const CHECKLIST_STEPS = ['generator', 'audit', 'backup'] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];

export type Appearance = 'system' | 'light' | 'dark';

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 5,
  clipboardClearSeconds: 30,
  outdatedDays: 365,
  breachCheckEnabled: false,
  lockOnHiddenSeconds: 0,
  generator: DEFAULT_GENERATOR_OPTIONS,
  appearance: 'system',
  hideIcons: { login: false, note: true, apiKey: true, recovery: true },
  categoriesEnabled: true,
  checklist: null,
};

/** Where the SQLite database lives. Not secret: the lock screen shows it. */
export interface StorageInfo {
  path: string;
  /** True for the built-in location inside the app folder. */
  isDefault: boolean;
  /** False when the file can't be opened (missing, not yet synced, no permission). */
  available: boolean;
  error: string | null;
  size: number | null;
  /** The server can open a native file dialog (macOS). */
  canBrowse: boolean;
}

export interface VaultStatus {
  storage: StorageInfo;
  initialized: boolean;
  unlocked: boolean;
  /** Epoch ms until which unlock attempts are refused. */
  lockoutUntil: number | null;
  /** Epoch ms at which the session auto-locks if idle. */
  expiresAt: number | null;
  settings: Settings | null;
  appearance: Appearance;
  /** PIN quick unlock, when set up. */
  pin: PinStatus | null;
  credential: Credential;
}

/** What unlocks the vault: a master password, or (weaker, by the owner's choice) a numeric PIN. */
export type Credential =
  | { type: 'password' }
  | { type: 'passphrase' }
  | { type: 'pin'; length: 4 | 6 }
  | { type: 'pattern' };
export type CredentialType = Credential['type'];
export const MASTER_PIN_LENGTHS = [4, 6] as const;

/** PINs and patterns have little entropy, so they get the heavy KDF and stricter export rules. */
export const isShortCredential = (c: Credential) => c.type === 'pin' || c.type === 'pattern';

export interface PinStatus {
  length: number;
  /** False after a server restart or too many wrong PINs, until the master password is used. */
  available: boolean;
  attemptsLeft: number;
}

export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  guessesLog10: number;
  crackTime: string;
  warning: string | null;
  suggestions: string[];
}

export type AuditIssue = 'weak' | 'reused' | 'outdated' | 'breached';

export interface AuditItem {
  id: string;
  title: string;
  icon: string;
  username: string;
  url: string;
  score: number;
  crackTime: string;
  ageDays: number;
  reuseCount: number;
  breachCount: number | null;
  breachCheckedAt: number | null;
  issues: AuditIssue[];
}

export interface AuditReport {
  generatedAt: number;
  health: number;
  totals: {
    logins: number;
    weak: number;
    reused: number;
    outdated: number;
    breached: number;
    unchecked: number;
    /** Extra copies that could be removed, not counting the one kept in each group. */
    duplicates: number;
  };
  items: AuditItem[];
  reusedGroups: string[][];
  /** Logins with the same site, username and password: usually the same account imported twice. */
  duplicateGroups: DuplicateGroup[];
  breachCheckEnabled: boolean;
}

export interface DuplicateGroup {
  username: string;
  site: string;
  /** Newest first; the first is the suggested one to keep. */
  items: { id: string; title: string; updatedAt: number; /** Has notes, codes or fields the newest copy doesn't. */ extra: boolean }[];
}

export type ExportFormat = 'encrypted' | 'json' | 'csv';

export interface ExportResult {
  filename: string;
  mime: string;
  content: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  categoriesCreated: number;
  source: string;
}

export interface ApiError {
  error: string;
  code?: string;
}
