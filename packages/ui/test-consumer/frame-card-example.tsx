import { Card, CardArrival, CardFaceDocument, CardGroup, CardGroups, CardGrid } from "../components/frame";

/**
 * A home of plans drawn with the frame's card: the work in progress as large
 * cards, then each project's plans as regular ones. Every face here is made
 * up; a host draws a face only from what the viewer may read.
 */

const ago = (days: number) => new Date(Date.UTC(2026, 10, 15 - days, 10, 0));

function AgentMark() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="var(--primary)" />
    </svg>
  );
}

function RedisFace() {
  return (
    <CardFaceDocument title="Move sessions from signed cookies to Redis">
      <h1>Move sessions from signed cookies to Redis</h1>
      <p>
        Sessions live in signed cookies today. That caps them at 4 KB and makes "sign out everywhere" impossible: a
        cookie we issued stays valid until it expires.
      </p>
      <h2>Session layout</h2>
      <table>
        <thead>
          <tr>
            <th>key</th>
            <th>holds</th>
            <th>expires</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>sess:{"{id}"}</td>
            <td>user, csrf</td>
            <td>14 d sliding</td>
          </tr>
          <tr>
            <td>sess:user:{"{uid}"}</td>
            <td>session ids</td>
            <td>with last</td>
          </tr>
        </tbody>
      </table>
    </CardFaceDocument>
  );
}

function CheckoutFace() {
  return (
    <div className="grid h-full grid-cols-[1.25fr_1fr] gap-4 px-[22px] py-[18px] text-[12px]">
      <div className="flex flex-col gap-[5px]">
        {["Contact", "Shipping", "Payment"].map((label) => (
          <div key={label} className="flex flex-col gap-[5px]">
            <b className="mt-1 font-semibold">{label}</b>
            <i className="block h-3.5 rounded shadow-[inset_0_0_0_1px_var(--frame-ink-3)]" />
          </div>
        ))}
        <span className="mt-2 grid h-[22px] place-items-center rounded-[5px] bg-foreground text-[11px] font-semibold text-background">
          Pay $86.40
        </span>
      </div>
      <div className="flex flex-col gap-2 self-start rounded-lg bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] p-3 text-[11px] text-[var(--frame-ink-2)]">
        <b className="text-foreground">Order summary</b>
        <span className="flex justify-between">
          Linen shirt <em className="font-mono not-italic text-foreground">$58.00</em>
        </span>
        <CardArrival>
          <span className="flex justify-between">
            Socks, 2 <em className="font-mono not-italic text-foreground">$18.00</em>
          </span>
        </CardArrival>
        <span className="flex justify-between border-t border-[var(--frame-ink-3)] pt-2 font-semibold text-foreground">
          Total <em className="font-mono not-italic">$86.40</em>
        </span>
      </div>
    </div>
  );
}

function RowsFace() {
  const rows = [
    ["key", "limit", "used"],
    ["acme-prod", "600", "512"],
    ["acme-ci", "120", "37"],
    ["beta-web", "300", "301"],
    ["beta-cron", "60", "12"],
  ];
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-4">
      <tbody>
        {rows.map((row, index) => (
          <tr key={row[0]}>
            {row.map((cell, column) => (
              <td
                key={column}
                className={
                  index === 0
                    ? "bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] px-2 py-1.5 text-[var(--frame-ink-2)]"
                    : "px-2 py-1.5 shadow-[inset_-1px_-1px_0_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
                }
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SWATCHES =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#f6f6f8"/>' +
      '<rect x="24" y="28" width="60" height="44" rx="6" fill="#0d1117"/><rect x="96" y="28" width="60" height="44" rx="6" fill="#161b22"/>' +
      '<rect x="168" y="28" width="60" height="44" rx="6" fill="#e6e8ef"/><rect x="240" y="28" width="60" height="44" rx="6" fill="#8b93a1"/>' +
      '<rect x="24" y="104" width="60" height="44" rx="6" fill="#58a6ff"/><rect x="96" y="104" width="60" height="44" rx="6" fill="#3fb950"/>' +
      '<rect x="168" y="104" width="60" height="44" rx="6" fill="#d29922"/><rect x="240" y="104" width="60" height="44" rx="6" fill="#f85149"/></svg>',
  );

function RetryFace() {
  return (
    <CardFaceDocument title="Retry policy for webhook delivery">
      <h1>Retry policy for webhook delivery</h1>
      <p>Failed deliveries retry five times over about fifteen hours, then stop.</p>
      <h2>Retry after</h2>
      <ol>
        <li>1 minute</li>
        <li>5 minutes</li>
        <li>30 minutes</li>
        <li>2 hours</li>
        <li>12 hours, then stop and tell the owner</li>
      </ol>
    </CardFaceDocument>
  );
}

export function PlansHomeCardsExample() {
  return (
    <div className="flex flex-col gap-14 p-6 sm:p-12">
      <section className="flex flex-col gap-4">
        <h2 className="text-[13px] font-medium leading-5 text-frame-muted-fg">Now</h2>
        <CardGrid label="Now">
          <Card
            kind="document"
            size="large"
            title="Move sessions from signed cookies to Redis"
            href="#redis"
            fact="Your move"
            unread
            face={<RedisFace />}
          />
          <Card
            kind="page"
            size="large"
            title="Rebuild checkout as one page, with the order summary beside the form"
            href="#checkout"
            fact="Maya Chen is working"
            factMark={<AgentMark />}
            working
            face={<CheckoutFace />}
          />
          <Card
            kind="data"
            size="large"
            title="Rate limits per API key"
            href="#limits"
            fact="Alex Rivera is working"
            factMark={<AgentMark />}
            working
            face={<RowsFace />}
          />
        </CardGrid>
      </section>
      <CardGroups>
        <CardGroup label="tidepool-api">
          <Card kind="document" size="regular" title="Retry policy for webhook delivery" href="#retry" unread time={ago(0)} face={<RetryFace />} />
        </CardGroup>
        <CardGroup label="kestrel-web">
          <Card
            kind="document"
            size="regular"
            title="Per-tenant feature flags, so a beta can ship to one customer without reaching every other tenant on the shared cluster"
            href="#flags"
            time={ago(1)}
            face={
              <CardFaceDocument title="Per-tenant feature flags">
                <h1>Per-tenant feature flags</h1>
                <p>A beta should reach one customer without touching every other tenant on the shared cluster.</p>
              </CardFaceDocument>
            }
          />
          <Card kind="image" size="regular" title="Dark mode tokens for the dashboard" href="#tokens" time={ago(4)} face={{ src: SWATCHES }} />
          <Card kind="document" size="regular" title="Search index for the docs site" href="#search" time={ago(6)} />
        </CardGroup>
      </CardGroups>
    </div>
  );
}
