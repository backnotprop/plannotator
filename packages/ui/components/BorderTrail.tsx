import { motion, type Transition } from 'motion/react';

export interface BorderTrailProps {
  className?: string;
  size?: number;
  transition?: Transition;
  style?: React.CSSProperties;
}

export function BorderTrail({
  className,
  size = 60,
  transition,
  style,
}: BorderTrailProps) {
  const defaultTransition: Transition = {
    repeat: Infinity,
    duration: 5,
    ease: 'linear',
  };

  return (
    <div className="pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]">
      <motion.div
        className={['absolute aspect-square bg-zinc-500', className].filter(Boolean).join(' ')}
        style={{
          width: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
          ...style,
        }}
        animate={{
          offsetDistance: ['0%', '100%'],
        }}
        transition={transition ?? defaultTransition}
      />
    </div>
  );
}
