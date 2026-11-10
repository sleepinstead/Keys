import { useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ImageUp, Search } from 'lucide-react';
import { renderGlyph } from '../icon.ts';
import { ICON_SET } from './iconSet.ts';
import { Button, Dialog } from './ui.tsx';


/**
 * Small dialog to give an item a built-in icon on a coloured tile, or to upload
 * an image instead. Reports a PNG data URL (or a File for uploads).
 */
export default function IconChooser({
  open,
  onClose,
  onPick,
  onUpload,
  color,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (icon: string) => void;
  onUpload: (file: File) => void;
  /** Colour the icon is drawn in: the item's colour from the icon menu. */
  color: string;
}) {
  const [query, setQuery] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ICON_SET.filter(([, label, words]) => `${label} ${words}`.toLowerCase().includes(q)) : ICON_SET;
  }, [query]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Choose an icon"
      className="dialog-icons"
      footer={
        <>
          <Button variant="outline" icon={<ImageUp size={15} />} onClick={() => file.current?.click()} className="icon-chooser-upload">
            Upload image
          </Button>
          <input
            ref={file}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) {
                onUpload(f);
                onClose();
              }
            }}
          />
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="icon-search">
        <Search size={15} aria-hidden="true" />
        <input
          className="input"
          type="text"
          placeholder={`Search ${ICON_SET.length} icons`}
          aria-label="Search icons"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          data-autofocus
        />
      </div>
      <div className="icon-grid-scroll">
        {shown.length === 0 ? (
          <p className="icon-empty">No icons match “{query.trim()}”.</p>
        ) : (
          <div className="icon-grid" style={{ '--tile': color } as CSSProperties}>
            {shown.map(([id, label, , Glyph]) => (
              <button
                key={id}
                type="button"
                className="icon-cell"
                aria-label={label}
                title={label}
                onClick={(e) => {
                  const svg = e.currentTarget.querySelector('svg');
                  if (!svg) return;
                  onPick(renderGlyph(svg, color));
                  onClose();
                }}
              >
                <Glyph size={20} strokeWidth={2} />
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
