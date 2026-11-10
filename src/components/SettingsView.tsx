import { Fragment, useEffect, useRef, useState } from 'react';
import type { DragEvent, FormEvent, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Archive, Check, Compass, Eye, EyeOff, FileDown, Folder, FileLock2, FileSpreadsheet, FileUp, Grid3x3, HardDrive, KeyRound, Palette, Pencil, Plus, Shapes, ShieldCheck, Timer, Trash2, TriangleAlert, X } from 'lucide-react';
import { api, ApiError, errorMessage, LOCK_EVENT } from '../api.ts';
import { useConfirm, useSettings, useToast } from '../context.tsx';
import { collapse, fade } from '../motion.ts';
import { isShortCredential } from '../../shared/types.ts';
import type { Category, CategoryColor, Credential, EntryType, ExportFormat, PinStatus, StorageInfo, VaultStatus } from '../../shared/types.ts';
import { isWeakPin } from '../../shared/generator.ts';
import { CREDENTIAL_NAMES, choiceFromCredential, CredentialPicker, PatternInput, PatternSetup, PinWarning } from './credential.tsx';
import type { CredentialChoice } from './credential.tsx';
import { encodePattern, passphraseProblem, passphraseWords } from '../../shared/credential.ts';
import { downloadBytes, downloadFile, plural, TYPE_LABELS } from '../util.ts';
import { StorageDialog } from './StorageDialog.tsx';
import { ColorMenu } from './ColorMenu.tsx';
import { Select } from './Select.tsx';
import type { StorageMode } from './StorageDialog.tsx';
import { Button, Dialog, Field, IconButton, OtpInput, Segmented, StrengthMeter, Switch, ThemeToggle, useStrength, FolderIcon } from './ui.tsx';

type Size = 'wide' | 'narrow' | 'half' | 'full';

/** One tile of the settings bento grid. */
function Section({
  title,
  lede,
  children,
  icon,
  size = 'half',
  tall,
  action,
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  delay?: number;
  icon?: ReactNode;
  size?: Size;
  tall?: boolean;
  action?: ReactNode;
}) {
  return (
    <section className={`bento-card bento-${size}${tall ? ' bento-tall' : ''}`}>
      <header className="bento-head">
        {icon && <span className="tile-icon">{icon}</span>}
        <div className="bento-head-text">
          <h2>{title}</h2>
          {lede && <p className="settings-lede">{lede}</p>}
        </div>
        {action && <div className="bento-head-action">{action}</div>}
      </header>
      <div className="bento-body">{children}</div>
    </section>
  );
}

function SelectRow({
  label,
  desc,
  value,
  options,
  onChange,
}: {
  label: string;
  desc?: string;
  value: number;
  options: [number, string][];
  onChange: (v: number) => void;
}) {
  const id = `set-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="setting-row">
      <div>
        <label htmlFor={id} className="setting-label">
          {label}
        </label>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <Select id={id} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l }))} />
    </div>
  );
}

export function SettingsView({
  categories,
  onViewOnboarding,
  onShowGettingStarted,
  onCategoriesChanged,
  onImported,
}: {
  categories: Category[];
  onViewOnboarding: () => void;
  onShowGettingStarted: () => void;
  onCategoriesChanged: () => Promise<void>;
  onImported: () => Promise<void>;
}) {
  const { settings, updateSettings } = useSettings();
  const save = (patch: Parameters<typeof updateSettings>[0]) => void updateSettings(patch).catch(() => {});
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const refreshStatus = () => api.status().then(setVaultStatus).catch(() => {});
  useEffect(() => {
    void refreshStatus();
  }, []);
  const credential: Credential = vaultStatus?.credential ?? { type: 'password' };

  return (
    <div className="page page-wide">
      <header className="page-head">
        <h1>Settings</h1>
        <p className="page-lede">Everything here is saved encrypted in your database file.</p>
      </header>

      {/* Tiles flow into balanced columns and are only as tall as their content. */}
      <div className="settings-masonry">
      {vaultStatus && <CredentialSection credential={credential} onChanged={refreshStatus} />}
      <Section title="Appearance" icon={<Palette size={17} />} size="narrow">
        <div className="group">
          <div className="setting-row">
            <div>
              <div className="setting-label">Theme</div>
              <div className="setting-desc">Match your system, or always use light or dark.</div>
            </div>
            <ThemeToggle value={settings.appearance} onChange={(v) => save({ appearance: v })} />
          </div>
        </div>
      </Section>
      {vaultStatus && <StorageSection storage={vaultStatus.storage} credential={vaultStatus.credential} onMoved={refreshStatus} />}

      <Section title="Icons" icon={<Shapes size={17} />} size="narrow" lede="Hidden kinds show as plain text rows.">
        <div className="group">
          {(Object.keys(TYPE_LABELS) as EntryType[]).map((type) => (
            <div className="setting-row" key={type}>
              <div>
                <label htmlFor={`hide-icons-${type}`} className="setting-label">
                  Hide icons in {TYPE_LABELS[type].many}
                </label>
                {type === 'login' && <div className="setting-desc">Also stops fetching website icons.</div>}
              </div>
              <Switch
                id={`hide-icons-${type}`}
                checked={settings.hideIcons[type]}
                onChange={(v) => save({ hideIcons: { ...settings.hideIcons, [type]: v } })}
                label={`Hide icons in ${TYPE_LABELS[type].many}`}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Locking" icon={<Timer size={17} />} size="wide">
        <div className="group">
          <SelectRow
            label="Lock after inactivity"
            value={settings.autoLockMinutes}
            onChange={(v) => save({ autoLockMinutes: v })}
            options={[
              [1, '1 min'],
              [5, '5 min'],
              [15, '15 min'],
              [30, '30 min'],
              [60, '1 hr'],
              [240, '4 hr'],
            ]}
          />
          <SelectRow
            label="Lock in the background"
            desc="Starts when you switch tabs or minimise the window"
            value={settings.lockOnHiddenSeconds}
            onChange={(v) => save({ lockOnHiddenSeconds: v })}
            options={[
              [0, 'Never'],
              [10, '10 sec'],
              [60, '1 min'],
              [300, '5 min'],
            ]}
          />
          <SelectRow
            label="Clear copied secrets"
            desc="Wipes passwords and codes from the clipboard"
            value={settings.clipboardClearSeconds}
            onChange={(v) => save({ clipboardClearSeconds: v })}
            options={[
              [10, '10 sec'],
              [30, '30 sec'],
              [60, '1 min'],
              [120, '2 min'],
              [0, 'Never'],
            ]}
          />
        </div>
      </Section>

      {vaultStatus && !isShortCredential(credential) && <PinSection pin={vaultStatus.pin} credential={credential} onChanged={refreshStatus} />}

      <Section title="Security audit" icon={<ShieldCheck size={17} />} size="narrow">
        <div className="group">
          <SelectRow
            label="Flag passwords older than"
            value={settings.outdatedDays}
            onChange={(v) => save({ outdatedDays: v })}
            options={[
              [90, '3 months'],
              [180, '6 months'],
              [365, '1 year'],
              [730, '2 years'],
            ]}
          />
          <div className="setting-row">
            <div>
              <label htmlFor="breach-switch" className="setting-label">
                Breach checking
              </label>
              <div className="setting-desc">Looks up a 5-character hash prefix on Have I Been Pwned. Your passwords are never sent.</div>
            </div>
            <Switch id="breach-switch" checked={settings.breachCheckEnabled} onChange={(v) => save({ breachCheckEnabled: v })} label="Breach checking" />
          </div>
        </div>
      </Section>

      <BackupSection credential={credential} onImported={onImported} />
      <CategoriesSection categories={categories} onChanged={onCategoriesChanged} />
      <Section title="Help" icon={<Compass size={17} />} size="narrow">
        <div className="group">
          <div className="setting-row">
            <div>
              <div className="setting-label">Onboarding</div>
              <div className="setting-desc">Replay the welcome screens. Nothing changes.</div>
            </div>
            <Button variant="outline" onClick={onViewOnboarding}>
              View
            </Button>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Getting started</div>
              <div className="setting-desc">Show the tips and checklist again.</div>
            </div>
            <Button variant="outline" onClick={onShowGettingStarted}>
              Show
            </Button>
          </div>
        </div>
      </Section>
      </div>
    </div>
  );
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Shortens a long path to its start and its file name, keeping both readable. */
function shortPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+/)?.[0];
  const nice = (home ? '~' + p.slice(home.length) : p).replace('~/Library/Mobile Documents/com~apple~CloudDocs', 'iCloud Drive').replace(/^~\/Library\/CloudStorage\/GoogleDrive-[^/]+\/My Drive/, 'Google Drive');
  return nice;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Where the database file lives, and ways to connect, move or create one. */
function StorageSection({ storage, credential, onMoved }: { storage: StorageInfo; credential: Credential; onMoved: () => Promise<void> }) {
  const [mode, setMode] = useState<StorageMode | null>(null);
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();

  async function download() {
    setDownloading(true);
    try {
      const { filename, data } = await api.storageTemplate();
      downloadBytes(filename, 'application/vnd.sqlite3', data);
      toast('Empty database downloaded. Move it anywhere, then connect it');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Section title="Database" icon={<HardDrive size={17} />} size="wide" lede="Keep the file anywhere: a folder, iCloud Drive, Google Drive.">
      <div className="storage-file">
        <span className="storage-file-path" title={storage.path}>
          {/* Break long paths only after a slash, never inside a folder or file name. */}
          {shortPath(storage.path)
            .split('/')
            .map((part, i, all) => (
              <Fragment key={i}>
                {part}
                {i < all.length - 1 && (
                  <>
                    /<wbr />
                  </>
                )}
              </Fragment>
            ))}
        </span>
        <span className="storage-file-meta">
          <span className="badge" data-tone={storage.isDefault ? 'muted' : 'good'}>
            {storage.isDefault ? 'Built-in' : 'Your location'}
          </span>
          {formatSize(storage.size)}
        </span>
      </div>
      <div className="group">
        <div className="setting-row">
          <div>
            <div className="setting-label">Connect a database</div>
            <div className="setting-desc">Open a Keys file you already have.</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setMode('connect')}>
            Connect
          </Button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Move this database</div>
            <div className="setting-desc">Copy everything to a new location and use it there.</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setMode('move')}>
            Move
          </Button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">New empty database</div>
            <div className="setting-desc">Download one to place anywhere, then connect it.</div>
          </div>
          <div className="row-buttons">
            {storage.canBrowse && (
              <Button size="sm" variant="outline" onClick={() => setMode('create')}>
                Create
              </Button>
            )}
            <Button size="sm" variant="outline" icon={<FileDown size={14} />} loading={downloading} onClick={() => void download()}>
              Download
            </Button>
          </div>
        </div>
        {!storage.isDefault && (
          <div className="setting-row">
            <div>
              <div className="setting-label">Built-in location</div>
              <div className="setting-desc">Go back to the file inside the Keys folder.</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setMode('default')}>
              Use built-in
            </Button>
          </div>
        )}
        <div className="setting-row">
          <div>
            <div className="setting-label">Erase this database</div>
            <div className="setting-desc">Permanently delete everything in this file.</div>
          </div>
          <Button size="sm" variant="danger" onClick={() => setMode('wipe')}>
            Erase
          </Button>
        </div>
      </div>
      <StorageDialog
        mode={mode}
        storage={storage}
        credential={credential}
        onClose={() => setMode(null)}
        onDone={(next) => {
          const moved = mode === 'move';
          setMode(null);
          if (moved) {
            void onMoved();
            toast(`Moved to ${fileName(next.storage.path)}`);
          } else {
            // A different file has its own password: go to its lock (or setup) screen.
            window.dispatchEvent(new Event(LOCK_EVENT));
          }
        }}
      />
    </Section>
  );
}

/** The current credential, in whatever form the vault uses: text, OTP boxes or a pattern grid. */
function CredentialField({
  credential,
  id,
  label,
  value,
  onChange,
  hint,
}: {
  credential: Credential;
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  const [points, setPoints] = useState<number[]>([]);
  useEffect(() => {
    if (!value) setPoints([]);
  }, [value]);
  if (credential.type === 'pin') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <OtpInput id={id} label={label} length={credential.length} value={value} onChange={onChange} size="md" />
        {hint && <div className="field-hint">{hint}</div>}
      </div>
    );
  }
  if (credential.type === 'pattern') {
    return (
      <div className="field">
        <div className="field-row">
          <span className="field-label">{label}</span>
          {value && <span className="badge" data-tone="good">Pattern entered</span>}
        </div>
        <PatternInput
          compact
          value={points}
          label={label}
          state={value ? 'success' : 'idle'}
          onChange={(p) => {
            setPoints(p);
            if (value) onChange('');
          }}
          onComplete={(p) => onChange(encodePattern(p))}
        />
        {hint && <div className="field-hint">{hint}</div>}
      </div>
    );
  }
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <input id={id} type="password" className="input" autoComplete="current-password" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** Two rows of OTP boxes: a new PIN and its confirmation, with a reveal toggle and a weak-PIN check. */
function NewPinFields({ length, value, again, onValue, onAgain, idPrefix }: { length: number; value: string; again: string; onValue: (v: string) => void; onAgain: (v: string) => void; idPrefix: string }) {
  const [show, setShow] = useState(false);
  const complete = value.length === length;
  const weak = complete && isWeakPin(value);
  const mismatch = again.length === length && again !== value;
  return (
    <div className="stack">
      <div className="field">
        <div className="otp-head">
          <span className="field-label">New PIN</span>
          <button type="button" className="otp-reveal" onClick={() => setShow(!show)} aria-pressed={show}>
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <OtpInput
          id={`${idPrefix}-new`}
          label={`New ${length}-digit PIN`}
          length={length}
          value={value}
          masked={!show}
          invalid={weak}
          size="md"
          onChange={(v) => {
            onValue(v);
            if (v.length < length) onAgain('');
          }}
          onComplete={(v) => !isWeakPin(v) && requestAnimationFrame(() => document.getElementById(`${idPrefix}-again`)?.focus())}
        />
        {weak && <div className="field-hint field-hint-bad">Too easy to guess. Avoid patterns like 1234, repeats and years.</div>}
      </div>
      <div className="field">
        <span className="field-label">Enter it again</span>
        <OtpInput id={`${idPrefix}-again`} label="Confirm PIN" length={length} value={again} masked={!show} invalid={mismatch} size="md" onChange={onAgain} disabled={!complete || weak} />
        {mismatch && <div className="field-hint field-hint-bad">The two PINs don’t match.</div>}
      </div>
    </div>
  );
}

function PinSection({ pin, credential, onChanged }: { pin: PinStatus | null; credential: Credential; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [length, setLength] = useState<'4' | '6'>('6');
  const [value, setValue] = useState('');
  const [again, setAgain] = useState('');
  const [master, setMaster] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  const reset = () => {
    setValue('');
    setAgain('');
    setMaster('');
    setError(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.setPin(value, master);
      await onChanged();
      setOpen(false);
      reset();
      toast('PIN unlock is on');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    const ok = await confirm({ title: 'Turn off PIN unlock?', body: 'You’ll need your master password every time Keys locks.', confirmLabel: 'Turn off', danger: true });
    if (!ok) return;
    await api.removePin().catch((err) => toast(errorMessage(err), 'error'));
    await onChanged();
    toast('PIN unlock is off');
  }

  const n = Number(length);
  const complete = value.length === n && again === value && !isWeakPin(value) && master.length > 0;

  return (
    <Section
      icon={<Grid3x3 size={17} />}
      size="narrow"
      title="Unlock with a PIN"
      lede="A quick way back in after Keys auto-locks."
    >
      <div className="group">
        <div className="setting-row">
          <div className="pin-summary">
            <span className="tile-icon">
              <Grid3x3 size={17} />
            </span>
            <div>
              <div className="setting-label">{pin ? `On with a ${pin.length}-digit PIN` : 'Off'}</div>
              <div className="setting-desc">
                {pin ? (pin.available ? 'Ready the next time Keys locks' : 'Unlock once with your master password to use it again') : 'Use your master password every time'}
              </div>
            </div>
          </div>
          <div className="row-buttons">
            {pin && (
              <Button size="sm" variant="outline" onClick={turnOff}>
                Turn off
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {pin ? 'Change' : 'Set up'}
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={pin ? 'Change unlock PIN' : 'Unlock with a PIN'}
        description="It never encrypts anything on disk. After a restart or 5 wrong tries, your master password is needed again."
        bare
      >
        <form className="dialog-form" onSubmit={submit}>
          <div className="dialog-body stack cred-dialog">
            <Segmented
              label="PIN length"
              value={length}
              onChange={(v) => {
                setLength(v);
                setValue('');
                setAgain('');
              }}
              options={[
                { value: '6', label: '6 digits' },
                { value: '4', label: '4 digits' },
              ]}
            />
            {/* Old boxes leave at once and the new ones fade in, so the dialog never doubles in height. */}
            <motion.div key={length} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
              <NewPinFields idPrefix="quick-pin" length={n} value={value} again={again} onValue={setValue} onAgain={setAgain} />
            </motion.div>
            <CredentialField credential={credential} id="pin-master" label={`Your ${CREDENTIAL_NAMES[credential.type]}`} value={master} onChange={setMaster} />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="dialog-foot">
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!complete}>
              {pin ? 'Save PIN' : 'Turn on'}
            </Button>
          </footer>
        </form>
      </Dialog>
    </Section>
  );
}

function CategoriesSection({ categories, onChanged }: { categories: Category[]; onChanged: () => Promise<void> }) {
  const { settings, updateSettings } = useSettings();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<CategoryColor | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  async function toggle(enabled: boolean) {
    try {
      await updateSettings({ categoriesEnabled: enabled });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function createCategory(e: FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const created = await api.createCategory(trimmed);
      if (newColor) await api.colorCategory(created.id, newColor);
      setNewName('');
      setNewColor(null);
      setAdding(false);
      await onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function rename(e: FormEvent, id: string) {
    e.preventDefault();
    try {
      await api.renameCategory(id, name.trim());
      setEditing(null);
      await onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function recolor(c: Category, color: CategoryColor | null) {
    try {
      await api.colorCategory(c.id, color);
      await onChanged();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove(c: Category) {
    const ok = await confirm({
      title: `Delete the ${c.name} category?`,
      body: 'Items in it are kept and become uncategorised.',
      confirmLabel: 'Delete category',
      danger: true,
    });
    if (!ok) return;
    await api.deleteCategory(c.id).catch((err) => toast(errorMessage(err), 'error'));
    await onChanged();
  }

  return (
    <Section
      title="Categories"
      icon={<Folder size={17} />}
      size="narrow"
      lede="Organise items into folders."
    >
      <div className="group">
        <div className="setting-row">
          <div>
            <label htmlFor="setting-categories-enabled" className="setting-label">
              Enable categories
            </label>
            <div className="setting-desc">Show folders in the sidebar and item editor.</div>
          </div>
          <Switch
            id="setting-categories-enabled"
            checked={settings.categoriesEnabled}
            onChange={(v) => void toggle(v)}
            label="Enable categories"
          />
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Manage categories</div>
            <div className="setting-desc">{plural(categories.length, 'folder')}: rename, recolour, add or delete.</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setManaging(true)}>
            Manage
          </Button>
        </div>
      </div>
      <Dialog open={managing} onClose={() => { setManaging(false); setAdding(false); setEditing(null); }} title="Categories" description="Click a folder to change its colour." size="sm">
        <div className="group cat-manage">
        <AnimatePresence initial={false}>
          {categories.map((c) => (
            <motion.div key={c.id} className="collapse cat-row-wrap" {...collapse}>
              <div className="setting-row cat-row">
              <ColorMenu
                label={`Folder colour for ${c.name}`}
                value={c.color}
                onChange={(color) => void recolor(c, color)}
                trigger={(props) => (
                  <IconButton label={`Folder colour for ${c.name}`} className="cat-color-btn" {...props}>
                    <FolderIcon color={c.color} />
                  </IconButton>
                )}
              />
              {editing === c.id ? (
                <form className="cat-edit" onSubmit={(e) => rename(e, c.id)}>
                  <input
                    className="input input-sm"
                    autoFocus
                    maxLength={60}
                    aria-label="Category name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <IconButton label="Save name" type="submit">
                    <Check size={16} />
                  </IconButton>
                  <IconButton label="Cancel" onClick={() => setEditing(null)}>
                    <X size={16} />
                  </IconButton>
                </form>
              ) : (
                <>
                  <span className="cat-name">{c.name}</span>
                  <IconButton
                    label={`Rename ${c.name}`}
                    onClick={() => {
                      setEditing(c.id);
                      setName(c.name);
                    }}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton label={`Delete ${c.name}`} onClick={() => remove(c)}>
                    <Trash2 size={15} />
                  </IconButton>
                </>
              )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
          {adding && (
            <div className="setting-row cat-row cat-row-wrap">
              <ColorMenu
                label="Folder colour for the new category"
                value={newColor}
                onChange={setNewColor}
                trigger={(props) => (
                  <IconButton label="Folder colour" className="cat-color-btn" {...props}>
                    <FolderIcon color={newColor} />
                  </IconButton>
                )}
              />
              <form className="cat-edit" onSubmit={createCategory}>
                <input
                  className="input input-sm"
                  autoFocus
                  maxLength={60}
                  placeholder="New category name"
                  aria-label="New category name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setAdding(false);
                      setNewName('');
                    }
                  }}
                />
                <IconButton label="Save category" type="submit" disabled={!newName.trim()}>
                  <Check size={16} />
                </IconButton>
                <IconButton label="Cancel" onClick={() => { setAdding(false); setNewName(''); }}>
                  <X size={16} />
                </IconButton>
              </form>
            </div>
          )}

        {!adding && (
          <button
            type="button"
            className="cat-add-btn"
            onClick={() => setAdding(true)}
          >
            <Plus size={15} />
            <span>Add category</span>
          </button>
        )}
        </div>
      </Dialog>
    </Section>
  );
}

/** A small tile that says how Keys unlocks today; the change itself happens in a dialog. */
function CredentialSection({ credential, onChanged }: { credential: Credential; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const name = CREDENTIAL_NAMES[credential.type];
  const title = { password: 'Master password', passphrase: 'Passphrase', pin: 'Unlock PIN', pattern: 'Unlock pattern' }[credential.type];
  return (
    <Section title={title} icon={<KeyRound size={17} />} size="narrow">
      <div className="group">
      <div className="setting-row">
        <div>
          <div className="setting-label">{credential.type === 'pin' ? `${credential.length}-digit PIN` : `Unlocks with a ${name}`}</div>
          <div className="setting-desc">Can’t be recovered if you forget it.</div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSession((n) => n + 1);
            setOpen(true);
          }}
        >
          Change
        </Button>
      </div>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Change ${credential.type === 'pin' ? 'PIN' : name}`}
        description="There’s no way to recover it if you forget it."
        bare
      >
        <CredentialForm key={session} credential={credential} onChanged={onChanged} onDone={() => setOpen(false)} />
      </Dialog>
    </Section>
  );
}

function CredentialForm({ credential, onChanged, onDone }: { credential: Credential; onChanged: () => Promise<void>; onDone: () => void }) {
  const [showNew, setShowNew] = useState(false);
  const [current, setCurrent] = useState('');
  const [choice, setChoice] = useState<CredentialChoice>(choiceFromCredential(credential));
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const isText = choice.type === 'password' || choice.type === 'passphrase';
  const strength = useStrength(isText ? next : '');
  const toast = useToast();
  const currentName = CREDENTIAL_NAMES[credential.type];
  const title = { password: 'Master password', passphrase: 'Passphrase', pin: 'Unlock PIN', pattern: 'Unlock pattern' }[credential.type];

  const phraseIssue = choice.type === 'passphrase' ? passphraseProblem(next) : null;
  const newOk =
    choice.type === 'password'
      ? next.length >= 10 && again === next && (strength?.score ?? 0) >= 3
      : choice.type === 'passphrase'
        ? !phraseIssue && again === next && (strength?.score ?? 0) >= 3
        : choice.type === 'pin'
          ? next.length === choice.pinLength && again === next && !isWeakPin(next)
          : next.length > 0;
  const ready = current.length > 0 && newOk;

  const choose = (c: CredentialChoice) => {
    setChoice(c);
    setNext('');
    setAgain('');
    setError(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.changePassword(current, next, choice.type);
      setCurrent('');
      setNext('');
      setAgain('');
      setFormKey((k) => k + 1);
      await onChanged();
      onDone();
      const c = res.credential;
      toast(c.type === credential.type ? `${title} changed` : `You now unlock with ${c.type === 'pin' ? `a ${c.length}-digit PIN` : `a ${CREDENTIAL_NAMES[c.type]}`}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form key={formKey} className="dialog-form" onSubmit={submit}>
      <div className="dialog-body stack cred-dialog">
        <CredentialField credential={credential} id="cp-current" label={`Current ${currentName}`} value={current} onChange={setCurrent} />
        <div className="field">
          <span className="field-label">Unlock with</span>
          <CredentialPicker value={choice} onChange={choose} />
        </div>
        {/* The old form is replaced in the same frame (no exit animation), so the
            dialog never holds both forms at once; the new one only fades in. */}
          <motion.div
            key={`${choice.type}-${choice.pinLength}`}
            className="stack"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            {isText ? (
              <>
                <div className="field">
                  <div className="otp-head">
                    <label htmlFor="cp-next" className="field-label">
                      {choice.type === 'passphrase' ? 'New passphrase' : 'New master password'}
                    </label>
                    <button type="button" className="otp-reveal" onClick={() => setShowNew(!showNew)} aria-pressed={showNew}>
                      {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
                      {showNew ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <input id="cp-next" type={showNew ? 'text' : 'password'} className="input" autoComplete="new-password" spellCheck={false} placeholder={choice.type === 'passphrase' ? 'Four or more words' : ''} value={next} onChange={(e) => setNext(e.target.value)} />
                  {next && <StrengthMeter result={strength} />}
                  {choice.type === 'passphrase' && <div className="field-hint">{`${passphraseWords(next).length} words. ${phraseIssue ?? 'Looks good.'}`}</div>}
                </div>
                <Field label="Type it again" htmlFor="cp-again">
                  <input id="cp-again" type={showNew ? 'text' : 'password'} className="input" autoComplete="new-password" spellCheck={false} value={again} onChange={(e) => setAgain(e.target.value)} />
                </Field>
              </>
            ) : choice.type === 'pin' ? (
              <>
                <NewPinFields idPrefix="cp-pin" length={choice.pinLength} value={next} again={again} onValue={setNext} onAgain={setAgain} />
              </>
            ) : (
              <>
                <PatternSetup onChange={(v) => setNext(v ?? '')} />
                <PinWarning pattern />
              </>
            )}
          </motion.div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-foot">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            {choice.type === credential.type && (choice.type !== 'pin' || (credential.type === 'pin' && credential.length === choice.pinLength)) ? `Change ${currentName}` : `Switch to ${choice.type === 'pin' ? `a ${choice.pinLength}-digit PIN` : `a ${CREDENTIAL_NAMES[choice.type]}`}`}
        </Button>
      </footer>
    </form>
  );
}

const EXPORT_FORMATS: { value: ExportFormat; label: string; description: string; icon: ReactNode }[] = [
  { value: 'encrypted', label: 'Encrypted', description: 'Locked with a password. Restores into Keys.', icon: <FileLock2 size={18} /> },
  { value: 'json', label: 'JSON', description: 'Unencrypted, with every field and note.', icon: <FileDown size={18} /> },
  { value: 'csv', label: 'CSV', description: 'Unencrypted, for browsers and other apps.', icon: <FileSpreadsheet size={18} /> },
];

/** One tile for backups: export and import, each opening its own dialog. */
function BackupSection({ credential, onImported }: { credential: Credential; onImported: () => Promise<void> }) {
  const [open, setOpen] = useState<'export' | 'import' | null>(null);
  const [session, setSession] = useState(0);
  const show = (which: 'export' | 'import') => {
    setSession((n) => n + 1);
    setOpen(which);
  };
  return (
    <Section title="Backup" icon={<Archive size={17} />} size="narrow">
      <div className="group">
        <div className="setting-row">
          <div>
            <div className="setting-label">Export</div>
            <div className="setting-desc">An encrypted file, or plain JSON or CSV.</div>
          </div>
          <Button size="sm" variant="outline" icon={<FileDown size={14} />} onClick={() => show('export')}>
            Export
          </Button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">Import</div>
            <div className="setting-desc">From a Keys backup, Bitwarden, or a browser’s CSV.</div>
          </div>
          <Button size="sm" variant="outline" icon={<FileUp size={14} />} onClick={() => show('import')}>
            Import
          </Button>
        </div>
      </div>
      <Dialog open={open === 'export'} onClose={() => setOpen(null)} title="Export a backup" description="Every export asks for your password or PIN again." bare>
        <ExportForm key={`e${session}`} credential={credential} onDone={() => setOpen(null)} />
      </Dialog>
      <Dialog
        open={open === 'import'}
        onClose={() => setOpen(null)}
        title="Import passwords"
        description="Keys backups, Bitwarden JSON, or CSV from Chrome, Firefox, Safari, 1Password, LastPass and Bitwarden. Items you already have are skipped."
        bare
      >
        <ImportForm key={`i${session}`} onImported={onImported} onDone={() => setOpen(null)} />
      </Dialog>
    </Section>
  );
}

function ExportForm({ credential, onDone }: { credential: Credential; onDone: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('encrypted');
  const [master, setMaster] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const { settings, updateSettings } = useSettings();
  const short = isShortCredential(credential);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (format !== 'encrypted') {
      const ok = await confirm({
        title: 'Export without encryption?',
        body: 'Every password will be readable in the downloaded file. Delete it as soon as you’re done with it.',
        confirmLabel: 'Export anyway',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const file = await api.exportVault(format, master, format === 'encrypted' ? exportPassword || undefined : undefined);
      downloadFile(file.filename, file.mime, file.content);
      toast(`Exported ${file.filename}`);
      const state = settings.checklist;
      if (state && !state.done.includes('backup')) void updateSettings({ checklist: { ...state, done: [...state.done, 'backup'] } }).catch(() => {});
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dialog-form" onSubmit={submit}>
      <div className="dialog-body stack export-dialog">
        <div className="format-grid" role="radiogroup" aria-label="Export format">
          {EXPORT_FORMATS.map((f) => (
            <button key={f.value} type="button" role="radio" aria-checked={format === f.value} className="format-card" onClick={() => setFormat(f.value)}>
              <span className="tile-icon">{f.icon}</span>
              <span className="format-label">{f.label}</span>
              <span className="format-desc">{f.description}</span>
            </button>
          ))}
        </div>
        {/* Both options share one slot, so switching formats never changes the dialog's height. */}
        <div className="export-slot">
          <div className="export-slot-item" hidden={format !== 'encrypted'}>
            <div className="field">
              <div className="otp-head">
                <label htmlFor="ex-pass" className="field-label">
                  File password
                </label>
                <button type="button" className="otp-reveal" onClick={() => setShowPass(!showPass)} aria-pressed={showPass}>
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  {showPass ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                id="ex-pass"
                type={showPass ? 'text' : 'password'}
                className="input"
                autoComplete="new-password"
                spellCheck={false}
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
              />
              <div className="field-hint">{short ? 'At least 10 characters. A PIN would be too easy to crack.' : `Leave blank to use your ${CREDENTIAL_NAMES[credential.type]}.`}</div>
            </div>
          </div>
          <p className="export-slot-item export-plain-note" hidden={format === 'encrypted'}>
            <TriangleAlert size={15} aria-hidden="true" />
            Not encrypted: anyone who gets this file can read every password.
          </p>
        </div>
        <CredentialField credential={credential} id="ex-master" label={`Your ${CREDENTIAL_NAMES[credential.type]}`} value={master} onChange={setMaster} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-foot">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!master || (short && format === 'encrypted' && exportPassword.length < 10)}
          icon={<FileDown size={16} />}
        >
          Export
        </Button>
      </footer>
    </form>
  );
}

function ImportForm({ onImported, onDone }: { onImported: () => Promise<void>; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const pick = (f: File | null) => {
    setFile(f);
    setNeedsPassword(false);
    setError(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0] ?? null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const content = await file.text();
      const res = await api.importVault(content, password || undefined);
      toast(`Imported ${plural(res.imported, 'item')} from ${res.source}` + (res.skipped ? `, skipped ${res.skipped}` : ''));
      await onImported();
      onDone();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NEEDS_PASSWORD' || err.code === 'BAD_PASSWORD')) setNeedsPassword(true);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dialog-form" onSubmit={submit}>
      <div className="dialog-body stack import-dialog">
        <label
          className="dropzone"
          data-dragging={dragging || undefined}
          data-has-file={file ? true : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="tile-icon">
            <FileUp size={18} />
          </span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={file?.name ?? 'empty'} className="dropzone-text" {...fade}>
              {file ? (
                <>
                  <strong>{file.name}</strong>
                  <span>{(file.size / 1024).toFixed(1)} KB, ready to import</span>
                </>
              ) : (
                <>
                  <strong>Drop a file here</strong>
                  <span>or click to choose one</span>
                </>
              )}
            </motion.span>
          </AnimatePresence>
          <input ref={inputRef} type="file" accept=".json,.csv,application/json,text/csv" className="visually-hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        <AnimatePresence initial={false}>
          {needsPassword && (
            <motion.div className="collapse" {...collapse}>
              <Field label="File password" htmlFor="im-pass">
                <input id="im-pass" type="password" className="input" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-foot">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!file} icon={<FileUp size={16} />}>
          Import
        </Button>
      </footer>
    </form>
  );
}
