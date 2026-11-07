/**
 * Settings → Capabilities → Board style (approval "shape-board-style-switch"): Rounded or Sharp, under the Shape
 * switch while Shape is on. A pick shows on every board at once and is saved to config.json (`shapeStyle.ts`).
 */
import { chooseShapeStyle, useShapeStyle } from '../shapeStyle';

const SHAPE_STYLE_CHOICES = [
  { id: 'rounded', label: 'Rounded' },
  { id: 'sharp', label: 'Sharp' },
] as const;

export function ShapeStyleRow() {
  const style = useShapeStyle();
  return (
    <div className="ib-prow" data-settings-shape-style={style}>
      <span className="ib-txt">
        <span className="ib-l" id="ib-shape-style-label">
          Board style
        </span>
        <span className="ib-desc">Sharp has thin lines and small corners; Rounded is the earlier look. Every board follows, old ones too.</span>
      </span>
      <span className="ib-ctl">
        <span className="ib-seg" role="radiogroup" aria-labelledby="ib-shape-style-label">
          {SHAPE_STYLE_CHOICES.map((choice) => (
            <label key={choice.id} className="ib-seg-o" data-on={style === choice.id ? '' : undefined}>
              <input type="radio" name="ib-shape-style" value={choice.id} checked={style === choice.id} onChange={() => void chooseShapeStyle(choice.id)} />
              {choice.label}
            </label>
          ))}
        </span>
      </span>
    </div>
  );
}

