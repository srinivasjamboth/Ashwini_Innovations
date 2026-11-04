'use client';
import React, { useRef } from 'react';
import {
  useScroll,
  useTransform,
  motion,
  type MotionValue,
} from 'framer-motion';

import { cn } from '@/lib/utils';

/**
 * Aceternity "Container Scroll" — a header that parallaxes up while a
 * perspective-tilted card straightens as the page scrolls.
 *
 * Integrated as-published (scroll-driven, `h-[60rem]` frame) plus three
 * OPTIONAL overrides on `Card`/`Header` — `className` and `innerClassName`
 * merged through `cn`, and `slide` for hosts that fly the card in instead of
 * revealing it on scroll. With none passed the rendered markup and the
 * animation are identical to the original, so existing usage is untouched; the
 * overrides exist because a modal-style consumer (the pricing "Billing"
 * scroller, `components/plans/checkout-scroll-overlay.tsx`) needs the card
 * to size to its content instead of a fixed 30/40rem, must scroll
 * inside the frame instead of clipping with `overflow-hidden`, and must not
 * overlap the header with the published `-mt-12`.
 *
 * `translate` became optional on `Card` — the original never read it.
 */

export const ContainerScroll = ({
  titleComponent,
  children,
}: {
  titleComponent: string | React.ReactNode;
  children: React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
  });
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => {
      window.removeEventListener('resize', checkMobile);
    };
  }, []);

  const scaleDimensions = () => {
    return isMobile ? [0.7, 0.9] : [1.05, 1];
  };

  const rotate = useTransform(scrollYProgress, [0, 1], [20, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], scaleDimensions());
  const translate = useTransform(scrollYProgress, [0, 1], [0, -100]);

  return (
    <div
      className="relative flex h-[60rem] items-center justify-center p-2 md:h-[80rem] md:p-20"
      ref={containerRef}
    >
      <div
        className="relative w-full py-10 md:py-40"
        style={{
          perspective: '1000px',
        }}
      >
        <Header translate={translate} titleComponent={titleComponent} />
        <Card rotate={rotate} translate={translate} scale={scale}>
          {children}
        </Card>
      </div>
    </div>
  );
};

/**
 * The published snippet typed this prop bag as `any`; this repo's lint
 * (`@typescript-eslint/no-explicit-any`) does not allow it, so the props are
 * spelled out. Behaviour and markup are unchanged.
 */
export const Header = ({
  translate,
  titleComponent,
  className,
}: {
  translate?: MotionValue<number>;
  titleComponent: string | React.ReactNode;
  className?: string;
}) => {
  return (
    <motion.div
      style={{
        translateY: translate,
      }}
      className={cn('div mx-auto max-w-5xl text-center', className)}
    >
      {titleComponent}
    </motion.div>
  );
};

export const Card = ({
  rotate,
  scale,
  children,
  className,
  innerClassName,
  slide,
}: {
  rotate: MotionValue<number>;
  scale: MotionValue<number>;
  translate?: MotionValue<number>;
  children: React.ReactNode;
  /** Overrides the frame's own classes (size, border, surface). */
  className?: string;
  /** Overrides the inner surface (height / scrolling of the content). */
  innerClassName?: string;
  /**
   * Vertical travel, for hosts that animate the card in from off-screen
   * instead of revealing it with page scroll. Deliberately NOT the published
   * `translate` prop: `ContainerScroll` passes its scroll-linked -100px
   * translate straight through, and reading it here would move the card on
   * scroll too — i.e. a second, undocumented change to the published
   * behaviour. Left undefined, nothing is applied.
   *
   * A string MotionValue is accepted so a host can travel relative to the
   * card's own height (`'100%'` = exactly one card-height, i.e. fully
   * off-screen), which survives a viewport resize without any measurement.
   */
  slide?: MotionValue<number> | MotionValue<string>;
}) => {
  return (
    <motion.div
      style={{
        rotateX: rotate,
        scale,
        // Spread conditionally rather than passing `translateY: undefined`: a
        // host that does not use `slide` must render byte-identical markup to
        // the published card, and building the key out is stronger evidence of
        // that than relying on the animation library skipping an undefined
        // transform.
        ...(slide ? { translateY: slide } : {}),
        boxShadow:
          '0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003',
      }}
      className={cn(
        'mx-auto -mt-12 h-[30rem] w-full max-w-5xl rounded-[30px] border-4 border-[#6C6C6C] bg-[#222222] p-2 shadow-2xl md:h-[40rem] md:p-6',
        className
      )}
    >
      <div
        className={cn(
          'h-full w-full overflow-hidden rounded-2xl bg-gray-100 md:rounded-2xl md:p-4 dark:bg-zinc-900',
          innerClassName
        )}
      >
        {children}
      </div>
    </motion.div>
  );
};
