export interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

export interface FixtureFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

export function createFixtureFetch(routes: Record<string, unknown | Response>): FixtureFetch {
  const requests: RecordedRequest[] = [];

  const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const normalized = normalizeFixtureUrl(url);
    requests.push({ url: normalized, init });

    const route = routes[normalized];
    if (route instanceof Response) return route;
    if (route === undefined) {
      return Response.json(
        {
          ok: false,
          protocol: "plannotator-daemon",
          protocolVersion: 1,
          error: {
            code: "session-not-found",
            message: `No fixture route for ${normalized}`,
          },
        },
        { status: 404 },
      );
    }
    return Response.json(route);
  };

  return { fetch: fixtureFetch as typeof fetch, requests };
}

function normalizeFixtureUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return new URL(url).pathname + new URL(url).search;
  }
  return url;
}
