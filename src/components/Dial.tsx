import { useEffect, useRef } from 'react';
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { Check, Lock, X } from 'lucide-react';

/**
 * idle: waiting for input. ready: setup requirements met (green).
 * busy: checking the password. success: verified (green). error: declined (red).
 */
export type DialState = 'idle' | 'ready' | 'busy' | 'success' | 'error';

const C = 100;
const TICKS = Array.from({ length: 60 }, (_, i) => i);
const KNURL = Array.from({ length: 72 }, (_, i) => i);
const DEG_PER_KEY = 6; // one tick per character

const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};

/** Arc path from `start` to `end` degrees (clockwise, 0 = top). */
function arc(r: number, start: number, end: number) {
  const [x1, y1] = polar(r, start);
  const [x2, y2] = polar(r, end);
  return `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}`;
}

/**
 * Line-art combination dial. The numbered face turns one tick per character typed
 * (back on delete), spins while the key is derived, turns green and swings open on
 * success, and turns red with a short wobble when the password is declined.
 * It never reveals what was typed: every key turns it by the same amount.
 */
export function Dial({ turns, state, size = 176 }: { turns: number; state: DialState; size?: number }) {
  const rotate = useMotionValue(-120);
  const reduce = useReducedMotion();
  const entered = useRef(false);

  useEffect(() => {
    if (reduce) {
      rotate.set(0);
      return;
    }
    if (state === 'busy') {
      const c = animate(rotate, rotate.get() + 360 * 20, { duration: 24, ease: 'linear' });
      return () => c.stop();
    }
    if (state === 'success') {
      const c = animate(rotate, rotate.get() + 200, { duration: 0.8, ease: [0.2, 0, 0, 1] });
      return () => c.stop();
    }
    if (state === 'error') {
      const r = rotate.get();
      const c = animate(rotate, [r, r - 10, r + 8, r - 5, r + 2, r], { duration: 0.45, ease: 'easeOut' });
      return () => c.stop();
    }
    // The first settle is the dial's entrance; after that each key is a short, smooth turn.
    const c = animate(rotate, turns * DEG_PER_KEY, { duration: entered.current ? 0.3 : 1, ease: [0.2, 0, 0, 1] });
    entered.current = true;
    return () => c.stop();
  }, [turns, state, rotate, reduce]);

  return (
    <div className="dial" data-state={state} style={{ width: size, height: size }} aria-hidden="true">
      {/* Fixed: double outer ring with a gap for the pointer. */}
      <svg className="dial-layer" viewBox="0 0 200 200">
        <path className="dial-ring" d={arc(97, 6, 354)} />
        <path className="dial-ring dial-ring-inner" d={arc(92.5, 4.5, 355.5)} />
        <path className="dial-pointer" d={`M ${C - 6.5} 0.5 L ${C + 6.5} 0.5 L ${C} 10 Z`} />
      </svg>

      {/* Turning face: ticks and the knurled edge of the knob. */}
      <motion.div className="dial-layer" style={{ rotate }}>
        <svg viewBox="0 0 200 200">
          {TICKS.map((i) => {
            const major = i % 5 === 0;
            const cardinal = i % 15 === 0;
            const [x1, y1] = polar(86, i * 6);
            const [x2, y2] = polar(cardinal ? 74 : major ? 77 : 81.5, i * 6);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={cardinal ? 'dial-tick dial-tick-cardinal' : major ? 'dial-tick dial-tick-major' : 'dial-tick'} />;
          })}
          <circle cx={C} cy={C} r={35.5} className="dial-knob-edge" />
          {KNURL.map((i) => {
            const [x1, y1] = polar(35.5, i * 5);
            const [x2, y2] = polar(30, i * 5);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="dial-knurl" />;
          })}
          <circle cx={C} cy={C} r={30} className="dial-knob-edge" />
        </svg>
      </motion.div>

      {/* Fixed: the knob face and its status icon. */}
      <div className="dial-face">
        <motion.span
          key={state === 'success' ? 'ok' : state === 'error' ? 'no' : 'lock'}
          className="dial-icon"
          initial={reduce ? false : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
        >
          {state === 'success' ? <Check size={22} strokeWidth={2.4} /> : state === 'error' ? <X size={22} strokeWidth={2.4} /> : <Lock size={19} strokeWidth={2} />}
        </motion.span>
      </div>
    </div>
  );
}
