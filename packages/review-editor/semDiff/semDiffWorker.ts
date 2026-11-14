import { configure, languageForPath, semanticDiffFile } from '@plannotator/sem-diff';
import { OpinionKeyError, type OpinionAnswer } from '@plannotator/sem-diff/opinions';
import type { Candidate } from '@plannotator/sem-diff/candidate';
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

function askServer(origin: string): (candidates: Candidate[]) => Promise<OpinionAnswer[]> {
  return async (candidates) => {
    const res = await fetch(new URL('/api/sem-diff/opinion', origin).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates }),
    });
    const reply = (await res.json()) as { ok: true; answers: OpinionAnswer[] } | { ok: false; state: string; reason: string };
    if (reply.ok) return reply.answers;
    if (reply.state === 'refusedKey') throw new OpinionKeyError('jev', 401, '');
    if (reply.state === 'noCredit') throw new OpinionKeyError('jev', 402, '');
    throw new Error(reply.reason);
  };
}

self.onmessage = async (event: MessageEvent<SemDiffRequest>) => {
  const request = event.data;
  let reply: SemDiffReply;
  try {
    setUp(request);
    const language = languageForPath(request.path);
    if (!language) throw new Error('unsupported language');
    const result = await semanticDiffFile(
      language,
      request.oldText,
      request.newText,
      request.path,
      request.opinion ? { secondOpinion: askServer(request.origin), rejectedCandidates: request.opinion.rejected } : {},
    );
    reply = {
      id: request.id,
      ok: true,
      semanticOperations: result.semanticOperations,
      semanticFolds: result.semanticFolds,
      patch: result.patch,
      secondOpinion: result.secondOpinion,
    };
  } catch (err) {
    reply = { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
