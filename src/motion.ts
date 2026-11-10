import type { Transition } from 'motion/react';

// Short, critically damped tweens. Motion here only shows where something came
// from or went (dialogs, menus, tooltips, collapsing sections); nothing bounces.
export const ease: [number, number, number, number] = [0.2, 0, 0, 1];

export const quick: Transition = { duration: 0.15, ease };
export const smooth: Transition = { duration: 0.22, ease };
/** Height changes (collapsing sections). */
export const reveal: Transition = { duration: 0.24, ease };

/** Popovers, menus, tooltips: a small scale from their trigger. */
export const pop = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease } },
  transition: quick,
};

/** Dialog panels. */
export const dialog = {
  initial: { opacity: 0, scale: 0.97, y: 6 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 2, transition: { duration: 0.12, ease } },
  transition: smooth,
};

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0.1, ease } },
  transition: quick,
};

export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: reveal,
};

let latest: ViewTransition | undefined;

/** Runs a theme change as a browser snapshot transition; the flag marks <html> while it plays. */
export function viewTransition(apply: () => void) {
  if (!document.startViewTransition) return apply();
  const root = document.documentElement;
  root.dataset.themeSwitching = '';
  const t = document.startViewTransition(apply);
  latest = t;
  // A skipped transition (hidden tab, a newer one starting) rejects here, but `apply` has still run.
  t.ready.catch(() => {});
  // Only the newest clears the flag, or a skipped one would remove it before the next is captured.
  t.finished.catch(() => {}).finally(() => {
    if (latest === t) delete root.dataset.themeSwitching;
  });
}

/** Springs the star when it turns on. Done on click, as a CSS animation would replay on every mount. */
export function popStar(button: HTMLElement) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  button.querySelector('svg')?.animate(
    [{ transform: 'scale(0.6) rotate(-20deg)' }, { transform: 'scale(1.2) rotate(6deg)', offset: 0.6 }, { transform: 'none' }],
    { duration: 400, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  );
}
