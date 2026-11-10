/** Item icons are stored as small square PNGs so the vault stays light. */
export const ICON_SIZE = 128;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Couldn’t read that file'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image couldn’t be opened'));
    img.src = src;
  });
}

/**
 * Turns an uploaded file or a fetched data URL into a square PNG data URL,
 * scaled to fit without cropping. Re-encoding also strips anything that isn't pixels.
 */
export async function normalizeIcon(source: Blob | string): Promise<string> {
  if (typeof source !== 'string' && source.size > 5 * 1024 * 1024) throw new Error('That image is larger than 5 MB');
  const img = await loadImage(typeof source === 'string' ? source : await readAsDataUrl(source));
  const w = img.naturalWidth || ICON_SIZE;
  const h = img.naturalHeight || ICON_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t process images');
  const scale = Math.min(ICON_SIZE / w, ICON_SIZE / h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (ICON_SIZE - w * scale) / 2, (ICON_SIZE - h * scale) / 2, w * scale, h * scale);
  return canvas.toDataURL('image/png');
}

/**
 * Draws a line icon (a Lucide <svg>, 24×24 viewBox) in white on a coloured
 * square and returns it as a PNG data URL. The shapes are drawn as canvas
 * paths rather than by loading the SVG as an image, so the canvas is never
 * "tainted" (Safari refuses to export a canvas that has drawn an SVG image).
 */
export function renderGlyph(svg: SVGSVGElement, background: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t process images');
  // Light tint of the colour on a see-through tile, so it suits light and dark themes.
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.globalAlpha = 1;

  const glyph = ICON_SIZE * 0.5;
  const scale = glyph / 24;
  ctx.translate((ICON_SIZE - glyph) / 2, (ICON_SIZE - glyph) / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = background;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const num = (el: Element, name: string) => Number(el.getAttribute(name) ?? 0);
  for (const el of svg.querySelectorAll('path, circle, ellipse, rect, line, polyline, polygon')) {
    let p: Path2D;
    switch (el.tagName.toLowerCase()) {
      case 'path':
        p = new Path2D(el.getAttribute('d') ?? '');
        break;
      case 'circle':
        p = new Path2D();
        p.arc(num(el, 'cx'), num(el, 'cy'), num(el, 'r'), 0, Math.PI * 2);
        break;
      case 'ellipse':
        p = new Path2D();
        p.ellipse(num(el, 'cx'), num(el, 'cy'), num(el, 'rx'), num(el, 'ry'), 0, 0, Math.PI * 2);
        break;
      case 'rect': {
        p = new Path2D();
        const rx = num(el, 'rx') || num(el, 'ry');
        p.roundRect(num(el, 'x'), num(el, 'y'), num(el, 'width'), num(el, 'height'), rx);
        break;
      }
      case 'line':
        p = new Path2D();
        p.moveTo(num(el, 'x1'), num(el, 'y1'));
        p.lineTo(num(el, 'x2'), num(el, 'y2'));
        break;
      default: {
        const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
        p = new Path2D();
        for (let i = 0; i + 1 < pts.length; i += 2) (i ? p.lineTo : p.moveTo).call(p, pts[i]!, pts[i + 1]!);
        if (el.tagName.toLowerCase() === 'polygon') p.closePath();
      }
    }
    ctx.stroke(p);
  }
  return canvas.toDataURL('image/png');
}
