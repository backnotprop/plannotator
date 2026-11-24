import { Switch } from '../components/SoundRow';

export function DiagramCapabilityRow({ on, onToggle }: { on: boolean; onToggle: (value: boolean) => void }) {
  return (
    <div className="ib-prow" data-settings-diagrams="">
      <span className="ib-txt">
        <span className="ib-l" id="ib-native-diagrams-label">Diagrams</span>
        <span className="ib-desc">Preview diagram files in threads and leave comments on their parts.</span>
      </span>
      <Switch on={on} labelledBy="ib-native-diagrams-label" onClick={() => onToggle(!on)} />
    </div>
  );
}
