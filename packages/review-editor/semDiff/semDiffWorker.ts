import { configure, languageForPath, semanticDiffFile } from '@plannotator/sem-diff';
import type { SemDiffReply, SemDiffRequest } from './protocol';

let configuredFor: string | null = null;

function setUp(request: SemDiffRequest): void {
  const key = request.origin + JSON.stringify(request.advert);
  if (configuredFor === key) return;
  const { advert, origin } = request;
  configure({
    locateRuntime: () => new URL(advert.runtime, origin).href,
    locateGrammar: (file) => {
      const served = advert.grammars[file.split('/').pop() ?? file];
      if (!served) throw new Error(`no grammar served for ${file}`);
      return new URL(served, origin).href;
    },
  });
  configuredFor = key;
}

self.onmessage = async (event: MessageEvent<SemDiffRequest>) => {
  const request = event.data;
  let reply: SemDiffReply;
  try {
    setUp(request);
    const language = languageForPath(request.path);
    if (!language) throw new Error('unsupported language');
    const result = await semanticDiffFile(language, request.oldText, request.newText, request.path);
    reply = { id: request.id, ok: true, semanticOperations: result.semanticOperations, semanticFolds: result.semanticFolds, patch: result.patch };
  } catch (err) {
    reply = { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
