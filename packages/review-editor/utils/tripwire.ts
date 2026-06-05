/** Source identifier stamped onto tripwire annotations by the server. */
export const isTripwireAnnotation = (a: { source?: string }): boolean =>
  a.source === 'tripwire';
