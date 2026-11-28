import { OptionPicker } from './OptionPicker';

export type InlinePickerOption = { value: string; label: string };

export function InlinePicker({
  label,
  value,
  options,
  onChange,
  keysStayInList = false,
  plainGroupLabels = false,
}: {
  label: string;
  value: string;
  options: InlinePickerOption[];
  onChange: (v: string) => void;
  keysStayInList?: boolean;
  plainGroupLabels?: boolean;
}) {
  return (
    <OptionPicker
      trigger="pill"
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      keysStayInList={keysStayInList}
      plainGroupLabels={plainGroupLabels}
    />
  );
}
