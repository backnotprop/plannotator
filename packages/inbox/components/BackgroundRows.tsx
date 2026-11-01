/**
 * Settings → General → Appearance → Background (art.tsx): the same choices
 * and names as Workspaces' Settings → Appearance → Background, None first,
 * each with a still thumbnail of its art, and a City row under it while Lofi
 * is the choice. Reduce motion in the system is the only motion switch, so
 * there is none here.
 */

import { ART_CITY_IDS, ART_CITY_LABELS, ART_THEME_IDS, ART_THEME_LABELS, useArtThumbnails } from '@plannotator/ui/art';
import { chooseArtCity, chooseArtTheme, createInboxArtWorker, useInboxArt } from '../art';
import { Icon } from '../icons';

/** A name stays whole beside its 64 px thumbnail ("Downtown" may run into the check's room, never break mid-word). */
const NAME = { overflowWrap: 'normal', wordBreak: 'normal' } as const;

function Tile({ name, value, label, on, thumb, onPick }: { name: string; value: string; label: string; on: boolean; thumb: ((el: HTMLCanvasElement | null) => void) | null; onPick: () => void }) {
  return (
    <label className="ib-pal" data-on={on ? '' : undefined} data-background={value}>
      <input type="radio" name={name} value={value} checked={on} onChange={onPick} />
      {thumb === null ? (
        <span aria-hidden="true" className="h-10 w-16 shrink-0 rounded-sm border border-border bg-background" />
      ) : (
        <canvas ref={thumb} aria-hidden="true" width={128} height={80} className="h-10 w-16 shrink-0 rounded-sm border border-border bg-background" />
      )}
      <span className="ib-pal-n" style={NAME}>
        {label}
      </span>
      {on && <Icon name="check" size={14} className="ib-pal-ck" />}
    </label>
  );
}

export function BackgroundRows() {
  const { theme, city } = useInboxArt();
  const thumb = useArtThumbnails(createInboxArtWorker);
  return (
    <>
      <div className="ib-palrow" data-settings-background={theme}>
        <div className="ib-prow ib-palhead">
          <span className="ib-txt">
            <span className="ib-l" id="ib-background-label">
              Background
            </span>
            <span className="ib-desc">Animated art behind the Inbox and Settings. Turn on Reduce motion in your system settings to hold it still.</span>
          </span>
        </div>
        <div className="ib-pals" role="radiogroup" aria-labelledby="ib-background-label" data-background-choices="">
          {ART_THEME_IDS.map((id) => (
            <Tile key={id} name="ib-background" value={id} label={ART_THEME_LABELS[id]} on={theme === id} thumb={id === 'none' ? null : thumb(id)} onPick={() => chooseArtTheme(id)} />
          ))}
        </div>
      </div>
      {theme === 'lofi' && (
        <div className="ib-palrow" data-settings-background-city={city}>
          <div className="ib-prow ib-palhead">
            <span className="ib-txt">
              <span className="ib-l" id="ib-background-city-label">
                City
              </span>
              <span className="ib-desc">The city Lofi draws along the bottom of the background.</span>
            </span>
          </div>
          <div className="ib-pals" role="radiogroup" aria-labelledby="ib-background-city-label" data-background-cities="">
            {ART_CITY_IDS.map((id) => (
              <Tile key={id} name="ib-background-city" value={id} label={ART_CITY_LABELS[id]} on={city === id} thumb={thumb('city:' + id)} onPick={() => chooseArtCity(id)} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
