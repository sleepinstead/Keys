import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

// The icon set is large, so the chooser loads the first time it's opened.
const IconChooser = lazy(() => import('./IconChooser.tsx'));
import type { CSSProperties, FormEvent, KeyboardEvent, MutableRefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Eye, EyeOff, Globe, Pencil, Plus, Shapes, Sparkles, Star, Trash2, X } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api.ts';
import { useConfirm, useSettings, useToast } from '../context.tsx';
import { collapse, popStar } from '../motion.ts';
import { normalizeIcon } from '../icon.ts';
import { CATEGORY_COLORS } from '../../shared/types.ts';
import type { Category, CustomField, Entry, EntryInput, EntryType, CategoryColor } from '../../shared/types.ts';
import { FIELD_LABELS, hostname, modKey, TYPE_LABELS } from '../util.ts';
import { Generator } from './Generator.tsx';
import { Select } from './Select.tsx';
import { Button, Dialog, Field, IconButton, Kbd, Menu, Monogram, Segmented, Spinner, StrengthMeter, useStrength } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

export interface EditorState {
  entry: Entry | null;
  type: EntryType;
  categoryId: string | null;
  /** Changes every time the editor opens, so each opening starts from a fresh form. */
  session: number;
}

function blank(type: EntryType, categoryId: string | null): EntryInput {
  return { type, title: '', username: '', password: '', url: '', notes: '', codes: '', categoryId, favorite: false, icon: '', customFields: [] };
}

/** The item's picture: click it to upload an image, use the website's own icon, or go back to the letter. */
function IconPicker({ icon, title, type, url, onChange }: { icon: string; title: string; type: EntryType; url: string; onChange: (icon: string) => void }) {
  const [choosing, setChoosing] = useState(false);
  const [chooserLoaded, setChooserLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = async (get: () => Promise<string>, done: string) => {
    setBusy(true);
    try {
      onChange(await normalizeIcon(await get()));
      toast(done);
    } catch (e) {
      toast(e instanceof Error && !(e instanceof ApiError) ? e.message : errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const items: MenuItem[] = [
    ...(type !== 'note'
      ? [
          {
            label: 'Website icon',
            icon: <Globe size={15} />,
            onSelect: () =>
              url.trim() ? void run(async () => (await api.siteIcon(url)).icon, 'Website icon added') : toast('Add the website address first, then pick this again.', 'error'),
          },
        ]
      : []),
    { label: 'Choose icon…', icon: <Shapes size={15} />, onSelect: () => {
        setChooserLoaded(true);
        setChoosing(true);
      } },
    // Remove is for pictures only; a colour is cleared with the "no colour" swatch.
    ...(icon && icon !== 'none' && !icon.startsWith('tint:') ? [{ label: 'Remove', icon: <Trash2 size={15} />, danger: true, separatorBefore: true, onSelect: () => onChange('none') }] : []),
  ];

  return (
    <div className="icon-picker">
      <Menu
        label="Item icon"
        align="start"
        items={items}
        footer={(close) => (
          <div className="menu-colors" role="radiogroup" aria-label="Letter colour">
            {/* 13 colours plus "no colour" in the last spot keeps the grid at 2 × 7. */}
            {(Object.keys(CATEGORY_COLORS) as CategoryColor[]).filter((c) => c !== 'rose').map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={icon === `tint:${c}`}
                aria-label={c}
                title={c[0]!.toUpperCase() + c.slice(1)}
                className="menu-swatch"
                style={{ '--swatch': CATEGORY_COLORS[c] } as CSSProperties}
                onClick={() => {
                  onChange(`tint:${c}`);
                  close();
                }}
              />
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={!icon.startsWith('tint:')}
              aria-label="No colour"
              title="No colour"
              className="menu-swatch menu-swatch-none"
              onClick={() => {
                if (icon.startsWith('tint:')) onChange('none');
                close();
              }}
            />
          </div>
        )}
        trigger={(props) => (
          <button type="button" className="icon-picker-btn" aria-label={icon && icon !== 'none' ? 'Change icon' : 'Add icon'} disabled={busy} {...props}>
            <Monogram title={title || '?'} type={type} size="lg" icon={icon} />
            <span className="icon-picker-badge">{busy ? <Spinner size={11} /> : <Pencil size={11} />}</span>
          </button>
        )}
      />
      {chooserLoaded && (
        <Suspense fallback={null}>
          <IconChooser
            open={choosing}
            onClose={() => setChoosing(false)}
            onPick={(png) => onChange(png)}
            onUpload={(f) => void run(async () => normalizeIcon(f), 'Icon added')}
            color={icon.startsWith('tint:') ? CATEGORY_COLORS[icon.slice(5) as CategoryColor] : '#52525b'}
          />
        </Suspense>
      )}
    </div>
  );
}

function toInput(e: Entry): EntryInput {
  const { type, title, username, password, url, notes, codes, categoryId, favorite, icon, customFields } = e;
  return { type, title, username, password, url, notes, codes, categoryId, favorite, icon, customFields };
}

/** Add or edit an item in a dialog. Escape, the close button and the overlay all ask before discarding edits. */
export function EntryEditorDialog({
  state,
  categories,
  onSaved,
  onClose,
}: {
  state: EditorState | null;
  categories: Category[];
  onSaved: (entry: Entry) => void;
  onClose: () => void;
}) {
  // Keep showing the last form while the dialog animates out.
  const last = useRef(state);
  if (state) last.current = state;
  const s = last.current;
  const requestClose = useRef<() => void>(onClose);

  return (
    <Dialog
      open={!!state}
      onClose={() => requestClose.current()}
      size="lg"
      className="dialog-editor"
      bare
      title={s?.entry ? 'Edit item' : 'New item'}
      description={s?.entry ? s.entry.title : 'Everything you enter is encrypted before it’s saved.'}
    >
      {s && <EditorForm key={s.session} state={s} categories={categories} onSaved={onSaved} onClose={onClose} requestClose={requestClose} />}
    </Dialog>
  );
}

/**
 * Recovery codes as one block per code. Enter adds a block, Backspace on an
 * empty block removes it, and pasting several codes splits them into blocks.
 * Stored as before: one code per line.
 */
function CodeBlocks({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const codes = value === '' ? [''] : value.split('\n');
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  // Focus lands in the same commit as the new block, so fast typing never goes to the old one.
  const pendingFocus = useRef<number | null>(null);
  const focusAt = (i: number) => {
    pendingFocus.current = i;
  };
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    refs.current[pendingFocus.current]?.focus();
    pendingFocus.current = null;
  });
  const update = (next: string[]) => onChange(next.join('\n'));

  return (
    <div className="code-blocks">
      <div className="code-grid">
        {codes.map((code, i) => (
          <div key={i} className="code-block">
            <span className="code-index" aria-hidden="true">
              {i + 1}
            </span>
            <input
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="code-input"
              aria-label={`Recovery code ${i + 1}`}
              spellCheck={false}
              autoComplete="off"
              value={code}
              onChange={(e) => update(codes.map((c, j) => (j === i ? e.target.value : c)))}
              onPaste={(e) => {
                const parts = e.clipboardData.getData('text').split(/[\s,]+/).filter(Boolean);
                if (parts.length < 2) return;
                e.preventDefault();
                const next = [...codes.slice(0, i), ...(code ? [code] : []), ...parts, ...codes.slice(i + 1)];
                update(next);
                focusAt(i + parts.length - (code ? 0 : 1));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  update([...codes.slice(0, i + 1), '', ...codes.slice(i + 1)]);
                  focusAt(i + 1);
                } else if (e.key === 'Backspace' && code === '' && codes.length > 1) {
                  e.preventDefault();
                  update(codes.filter((_, j) => j !== i));
                  focusAt(Math.max(0, i - 1));
                }
              }}
            />
            {codes.length > 1 && (
              <button type="button" className="code-remove" aria-label={`Remove code ${i + 1}`} onClick={() => update(codes.filter((_, j) => j !== i))}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={14} />}
        onClick={() => {
          update([...codes, '']);
          focusAt(codes.length);
        }}
      >
        Add code
      </Button>
    </div>
  );
}

function EditorForm({
  state,
  categories,
  onSaved,
  onClose,
  requestClose,
}: {
  state: EditorState;
  categories: Category[];
  onSaved: (entry: Entry) => void;
  onClose: () => void;
  requestClose: MutableRefObject<() => void>;
}) {
  const { entry } = state;
  const initial = useMemo(() => (entry ? toInput(entry) : blank(state.type, state.categoryId)), [entry, state.type, state.categoryId]);
  const [form, setForm] = useState<EntryInput>(initial);
  const { settings } = useSettings();
  const hideIcons = settings.hideIcons;
  const [showPassword, setShowPassword] = useState(!entry);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  const labels = FIELD_LABELS[form.type];
  const hasSecret = form.type === 'login' || form.type === 'apiKey';
  const strength = useStrength(form.type === 'login' ? form.password : '', [form.username, form.title, hostname(form.url)]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const set = <K extends keyof EntryInput>(k: K, v: EntryInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setField = (i: number, patch: Partial<CustomField>) => set('customFields', form.customFields.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  async function cancel() {
    if (dirty && !(await confirm({ title: 'Discard changes?', body: 'Your edits to this item haven’t been saved.', confirmLabel: 'Discard', danger: true }))) return;
    onClose();
  }
  useEffect(() => {
    requestClose.current = () => void cancel();
  });

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!form.title.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      const cleaned = {
        ...form,
        codes: form.codes.split('\n').map((c) => c.trim()).filter(Boolean).join('\n'),
        customFields: form.customFields.filter((f) => f.label.trim() || f.value),
      };
      onSaved(entry ? await api.updateEntry(entry.id, cleaned) : await api.createEntry(cleaned));
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="dialog-form" onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="dialog-body editor">
        {!entry && (
          <Segmented
            label="Item type"
            block
            value={form.type}
            onChange={(t) => set('type', t)}
            options={(Object.keys(TYPE_LABELS) as EntryType[]).map((t) => ({ value: t, label: TYPE_LABELS[t].one }))}
          />
        )}

        <div className="editor-identity">
          {!hideIcons[form.type] && (
            <IconPicker icon={form.icon} title={form.title} type={form.type} url={form.url} onChange={(icon) => set('icon', icon)} />
          )}
          <Field label="Name" htmlFor={fid('title')}>
            <input
              id={fid('title')}
              className="input input-lg"
              required
              maxLength={200}
              autoFocus
              autoComplete="off"
              placeholder={form.type === 'login' ? 'e.g. GitHub' : form.type === 'apiKey' ? 'e.g. Stripe live key' : form.type === 'note' ? 'e.g. Wi-Fi details' : 'e.g. Google account'}
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>
          <IconButton
            label={form.favorite ? 'Remove from favorites' : 'Add to favorites'}
            className="editor-fav"
            aria-pressed={form.favorite}
            onClick={(e) => { if (!form.favorite) popStar(e.currentTarget); set('favorite', !form.favorite); }}
          >
            <Star size={18} className={form.favorite ? 'is-fav' : undefined} />
          </IconButton>
        </div>

        {/* Keyed by type: the new fields fade in, the old ones leave at once, so switching never overlaps. */}
        <motion.section key={form.type} className="editor-section" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}>
          <h3 className="editor-section-title">Details</h3>

          {form.type !== 'note' && (
            <div className="field-pair">
              <Field label={labels.username} htmlFor={fid('username')}>
                <input
                  id={fid('username')}
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={512}
                  placeholder={form.type === 'login' ? 'Email or username' : form.type === 'apiKey' ? 'Optional' : 'Email or username'}
                  value={form.username}
                  onChange={(e) => set('username', e.target.value)}
                />
              </Field>
              <Field label={labels.url} htmlFor={fid('url')}>
                <input id={fid('url')} className="input" inputMode="url" autoComplete="off" spellCheck={false} placeholder="example.com" value={form.url} onChange={(e) => set('url', e.target.value)} />
              </Field>
            </div>
          )}

          {hasSecret && (
            <div className="field">
              <label className="field-label" htmlFor={fid('password')}>
                {labels.password}
              </label>
              <div className="input-group">
                <div className="input-icon">
                  <input
                    id={fid('password')}
                    className="input input-mono"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={4096}
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                  />
                  <IconButton label={showPassword ? `Hide ${labels.password.toLowerCase()}` : `Show ${labels.password.toLowerCase()}`} className="input-icon-trail" onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </IconButton>
                </div>
                <Button variant={generatorOpen ? 'secondary' : 'outline'} icon={<Sparkles size={15} />} onClick={() => setGeneratorOpen(!generatorOpen)} aria-expanded={generatorOpen}>
                  Generate
                </Button>
              </div>
              {form.type === 'login' && form.password && !generatorOpen && <StrengthMeter result={strength} />}
              <AnimatePresence initial={false}>
                {generatorOpen && (
                  <motion.div className="collapse" {...collapse}>
                    <div className="editor-generator">
                      <Generator
                        compact
                        onUse={(pw) => {
                          set('password', pw);
                          setShowPassword(true);
                          setGeneratorOpen(false);
                        }}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {entry && entry.password && form.password !== entry.password && <p className="field-hint">The old one is kept in this item’s password history.</p>}
            </div>
          )}

          {form.type === 'recovery' && (
            <div className="field">
              <span className="field-label">Recovery codes</span>
              <CodeBlocks value={form.codes} onChange={(v) => set('codes', v)} />
            </div>
          )}

          {/* Only secure notes have a text body; other kinds have no notes field. */}
          {form.type === 'note' && (
            <Field label={labels.notes} htmlFor={fid('notes')}>
              <textarea
                id={fid('notes')}
                className="input"
                rows={10}
                placeholder="Write anything. It’s encrypted like everything else."
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </Field>
          )}
        </motion.section>

        {settings.categoriesEnabled && (
          <section className="editor-section">
            <h3 className="editor-section-title">Organise</h3>
            <Field label="Category" htmlFor={fid('category')}>
              <Select
                id={fid('category')}
                className="select-block"
                value={form.categoryId ?? ''}
                onChange={(v) => set('categoryId', v || null)}
                options={[{ value: '', label: 'None' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
              />
            </Field>
          </section>
        )}

        {form.type !== 'note' && (
          <section className="editor-section">
            <h3 className="editor-section-title">Extra fields</h3>
            {form.customFields.length > 0 && (
              <div className="custom-fields">
                {form.customFields.map((f, i) => (
                  <div key={f.id} className="custom-field">
                    <input className="input" placeholder="Label" aria-label={`Field ${i + 1} label`} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                    <input
                      className={`input${f.hidden ? ' input-mono' : ''}`}
                      placeholder="Value"
                      aria-label={`Field ${i + 1} value`}
                      type={f.hidden ? 'password' : 'text'}
                      autoComplete="off"
                      value={f.value}
                      onChange={(e) => setField(i, { value: e.target.value })}
                    />
                    <IconButton label={f.hidden ? 'Show value' : 'Hide value'} onClick={() => setField(i, { hidden: !f.hidden })} aria-pressed={f.hidden}>
                      {f.hidden ? <EyeOff size={16} /> : <Eye size={16} />}
                    </IconButton>
                    <IconButton label="Remove field" onClick={() => set('customFields', form.customFields.filter((_, j) => j !== i))}>
                      <X size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => set('customFields', [...form.customFields, { id: crypto.randomUUID(), label: '', value: '', hidden: false }])}
              >
                Add field
              </Button>
            </div>
          </section>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <footer className="dialog-foot">
        <span className="dialog-hint">
          <Kbd>{`${modKey}↵`}</Kbd> to save
        </span>
        <Button variant="outline" onClick={() => void cancel()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!form.title.trim()}>
          {entry ? 'Save changes' : 'Save item'}
        </Button>
      </footer>
    </form>
  );
}
