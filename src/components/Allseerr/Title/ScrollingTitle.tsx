import { useEffect, useRef, useState } from 'react';

// Scroll speed in pixels per second, and the rest at each end of a pass
const SPEED = 40;
const PAUSE_MS = 2000;
// Width of the fade on the trailing edge; a pass ends with the title clear of it
const FADE = 24;

// Fades the trailing edge while the title moves
const fadeMask = `linear-gradient(to right, #000 calc(100% - ${FADE}px), transparent)`;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A page title kept on one line. A title too long for its space rests at the
 * start, slides to its end, rests and slides back, with a faded edge. With
 * reduced motion it stays still and can be swiped sideways instead.
 */
const ScrollingTitle = ({
  text,
  className,
  testId,
}: {
  text: string;
  className?: string;
  testId?: string;
}) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    setReduceMotion(prefersReducedMotion());
  }, []);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;

    if (!outer || !inner) {
      return;
    }

    const measure = () =>
      setOverflow(
        Math.max(0, Math.ceil(inner.scrollWidth - outer.clientWidth))
      );

    measure();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);

    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    const inner = innerRef.current;

    if (!inner || overflow === 0 || reduceMotion || !inner.animate) {
      return;
    }

    const distance = overflow + FADE;
    const travel = (distance / SPEED) * 1000;
    const total = 2 * PAUSE_MS + 2 * travel;
    const end = `translateX(-${distance}px)`;
    const animation = inner.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        {
          transform: 'translateX(0)',
          offset: PAUSE_MS / total,
          easing: 'ease-in-out',
        },
        { transform: end, offset: (PAUSE_MS + travel) / total },
        {
          transform: end,
          offset: (2 * PAUSE_MS + travel) / total,
          easing: 'ease-in-out',
        },
        { transform: 'translateX(0)', offset: 1 },
      ],
      { duration: total, iterations: Infinity }
    );

    return () => animation.cancel();
  }, [overflow, reduceMotion]);

  const overflowing = overflow > 0;

  return (
    <div
      ref={outerRef}
      className={`min-w-0 max-w-full ${
        overflowing && reduceMotion
          ? 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
          : 'overflow-hidden'
      }`}
      style={
        overflowing && !reduceMotion
          ? {
              maskImage: fadeMask,
              WebkitMaskImage: fadeMask,
            }
          : undefined
      }
    >
      <h1
        className={`m-0 whitespace-nowrap ${className ?? ''}`}
        data-testid={testId}
        title={overflowing ? text : undefined}
      >
        <span ref={innerRef} className="inline-block whitespace-nowrap">
          {text}
        </span>
      </h1>
    </div>
  );
};

export default ScrollingTitle;
