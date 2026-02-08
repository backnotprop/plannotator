import { useEffect, useState, useRef } from 'react';

/**
 * Track which heading section is currently visible in the viewport
 * Uses Intersection Observer to detect when headings enter/leave view
 */
export function useActiveSection(containerRef: React.RefObject<HTMLElement>, headingCount: number) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    // Find all heading elements with data-block-id
    const headings = container.querySelectorAll('[data-block-type="heading"]');
    if (headings.length === 0) return;
    
    // Track which headings are currently intersecting
    const intersectingHeadings = new Map<Element, boolean>();
    
    // Create observer with configuration to detect headings near top of viewport
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Update intersection state
        entries.forEach(entry => {
          intersectingHeadings.set(entry.target, entry.isIntersecting);
        });
        
        // Find the first intersecting heading (topmost in viewport)
        let topHeading: Element | null = null;
        let topPosition = Infinity;
        
        for (const [heading, isIntersecting] of intersectingHeadings) {
          if (isIntersecting) {
            const rect = heading.getBoundingClientRect();
            if (rect.top < topPosition) {
              topPosition = rect.top;
              topHeading = heading;
            }
          }
        }
        
        // Update active ID
        if (topHeading) {
          const blockId = topHeading.getAttribute('data-block-id');
          if (blockId) {
            setActiveId(blockId);
          }
        }
      },
      {
        root: container,
        rootMargin: '-80px 0px -80% 0px', // Activate when heading is near top
        threshold: [0, 0.1, 0.5, 1.0],
      }
    );
    
    // Observe all headings
    headings.forEach(heading => {
      observerRef.current?.observe(heading);
    });
    
    // Cleanup
    return () => {
      observerRef.current?.disconnect();
    };
  }, [containerRef, headingCount]);
  
  return activeId;
}
