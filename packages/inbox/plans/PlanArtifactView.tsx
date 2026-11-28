/**
 * An artifact in the middle of a plan's page, by what it is: a raster picture as itself (the Inbox serves its bytes);
 * an SVG drawn as a picture from its text (a `data:` picture runs nothing and loads nothing); an HTML page in the
 * plan's frame that runs nothing (planContent.tsx); any other file (a PDF, a film, anything) as its name, kind and
 * size with Download. The bytes come from `GET /api/plans/:id/files/<path>`, which serves nothing that could run.
 */
import { useState } from 'react';
import type { PlanArtifact } from '@plannotator/core/plans';
import { Icon } from '../icons';
import { plansApi } from './client';
import { PlanHtmlFrame } from './planContent';
import { useArtifactText } from './store';
import { artifactKind, artifactKindLabel, artifactName, sizeWords } from './words';

export function PlanArtifactView({ id, artifact }: { id: string; artifact: PlanArtifact }) {
  const kind = artifactKind(artifact.content_type);
  const name = artifactName(artifact);
  const [retry, setRetry] = useState(0);
  const needsText = kind === 'svg' || kind === 'html';
  const { text, error } = useArtifactText(id, needsText ? artifact.asset_path : null, artifact.content_hash, retry);
  if (needsText && error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>
          {name} could not be read. {error}
        </p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (needsText && text === null) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading {name}…</p>
      </div>
    );
  }
  if (kind === 'html') {
    return (
      <div className="ib-plan-docscroll ib-plan-framewrap" data-plan-artifact={artifact.asset_path}>
        <PlanHtmlFrame html={text!} title={name} />
      </div>
    );
  }
  if (kind === 'image' || kind === 'svg') {
    const src = kind === 'svg' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text!)}` : plansApi.fileUrl(id, artifact.asset_path);
    return (
      <div className="ib-plan-docscroll ib-plan-picture" data-plan-artifact={artifact.asset_path}>
        <img src={src} alt={name} />
      </div>
    );
  }
  return (
    <div className="ib-plan-docscroll" data-plan-artifact={artifact.asset_path}>
      <div className="ib-plan-filecard">
        <Icon name="clip" />
        <p className="ib-plan-filecard-n" dir="auto">
          {name}
        </p>
        <p className="ib-plan-filecard-k">
          {artifactKindLabel(artifact.content_type)} · {artifact.content_type} · {sizeWords(artifact.size)}
        </p>
        <a className="ib-plans-quiet" href={plansApi.fileUrl(id, artifact.asset_path)} download={artifact.asset_path.split('/').pop()} data-plan-artifact-download="">
          <Icon name="download" />
          Download
        </a>
      </div>
    </div>
  );
}
