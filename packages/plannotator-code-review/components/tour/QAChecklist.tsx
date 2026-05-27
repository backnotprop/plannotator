import React from 'react';
import { motion } from 'motion/react';
import * as Checkbox from '@radix-ui/react-checkbox';
import type { TourQAItem, TourStop } from '../../hooks/tour/useTourData';

interface QAChecklistProps {
  items: TourQAItem[];
  stops: TourStop[];
  checked: boolean[];
  onToggle: (index: number) => void;
  onScrollToStop?: (index: number) => void;
}

export const QAChecklist: React.FC<QAChecklistProps> = ({
  items,
  checked,
  onToggle,
  onScrollToStop,
}) => {
  return (
    <motion.div
      className="space-y-0.5"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
      }}
    >
      {items.map((item, i) => (
        <motion.label
          key={i}
          className="flex items-start gap-3 py-2 px-1 rounded-md hover:bg-muted/20 transition-colors cursor-pointer"
          variants={{
            hidden: { opacity: 0, y: 4 },
            visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 220, damping: 24 } },
          }}
        >
          <Checkbox.Root
            checked={checked[i] ?? false}
            onCheckedChange={() => onToggle(i)}
            className="tour-checkbox mt-0.5 w-[18px] h-[18px] rounded-[4px] flex-shrink-0 border border-foreground/25 dark:border-border/50 bg-muted/40 dark:bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)] dark:shadow-none data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:shadow-none flex items-center justify-center"
          >
            <Checkbox.Indicator>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2.5 6L5 8.5L9.5 3.5"
                  stroke="white"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Checkbox.Indicator>
          </Checkbox.Root>

          <div className="flex-1 min-w-0">
            <span
              className={`text-sm leading-relaxed transition-[opacity,text-decoration] duration-150 ${
                checked[i] ? 'line-through opacity-50 text-foreground/50' : 'text-foreground'
              }`}
            >
              {item.question}
            </span>
            {item.stop_indices.length > 0 && (
              <span className="ml-2 text-[10px] text-muted-foreground/50">
                {item.stop_indices.map((si, j) => (
                  <React.Fragment key={si}>
                    {j > 0 && ', '}
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onScrollToStop?.(si);
                      }}
                      className="hover:text-primary transition-colors"
                    >
                      Stop {si + 1}
                    </button>
                  </React.Fragment>
                ))}
              </span>
            )}
          </div>
        </motion.label>
      ))}
    </motion.div>
  );
};
