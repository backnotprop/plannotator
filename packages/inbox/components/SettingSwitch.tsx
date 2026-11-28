export function Switch({ on, labelledBy, disabled, onClick, label }: { on: boolean; labelledBy?: string; label?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      className="ib-sw"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    />
  );
}
