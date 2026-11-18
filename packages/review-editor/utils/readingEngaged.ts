const readings = new WeakMap<Element, { views: number; engaged: boolean }>();

export interface Reading {
  engage(): void;
  engaged(): boolean;
  leave(): void;
}

export function joinReading(page: Element): Reading {
  const reading = readings.get(page) ?? { views: 0, engaged: false };
  readings.set(page, reading);
  reading.views++;
  let left = false;
  return {
    engage: () => void (reading.engaged = true),
    engaged: () => reading.engaged,
    leave: () => {
      if (left) return;
      left = true;
      reading.views--;
      if (reading.views === 0) readings.delete(page);
    },
  };
}
