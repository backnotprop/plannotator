import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import {
  Card,
  CardArrival,
  CardFaceDocument,
  CardGroup,
  CardGroups,
  CardGrid,
  CardRow,
  CardUpdatesPill,
  settleBatch,
  type CardImageFace,
  type CardKind,
} from "../components/frame";

/**
 * A home of plans drawn with the frame's card: the work in progress as large
 * cards, then each project's plans as regular ones, and the same plans as a
 * list. Every face here is made up; a host draws a face only from what the
 * viewer may read.
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

interface Plan {
  readonly id: string;
  readonly kind: CardKind;
  readonly title: string;
  readonly project: string;
  readonly face?: ReactNode | CardImageFace;
  readonly fact?: string;
  readonly working?: boolean;
  readonly unread?: boolean;
  readonly time?: Date;
}

const NOW: readonly Plan[] = [
  {
    id: "redis",
    kind: "document",
    title: "Move sessions from signed cookies to Redis",
    project: "tidepool-api",
    fact: "Your move",
    unread: true,
    face: <RedisFace />,
  },
  {
    id: "checkout",
    kind: "page",
    title: "Rebuild checkout as one page, with the order summary beside the form",
    project: "kestrel-web",
    fact: "Maya Chen is working",
    working: true,
    face: <CheckoutFace />,
  },
  {
    id: "limits",
    kind: "data",
    title: "Rate limits per API key",
    project: "tidepool-api",
    fact: "Alex Rivera is working",
    working: true,
    face: <RowsFace />,
  },
];

const EARLIER: readonly Plan[] = [
  { id: "retry", kind: "document", title: "Retry policy for webhook delivery", project: "tidepool-api", unread: true, time: ago(0), face: <RetryFace /> },
  {
    id: "flags",
    kind: "document",
    title: "Per-tenant feature flags, so a beta can ship to one customer without reaching every other tenant on the shared cluster",
    project: "kestrel-web",
    time: ago(1),
    face: (
      <CardFaceDocument title="Per-tenant feature flags">
        <h1>Per-tenant feature flags</h1>
        <p>A beta should reach one customer without touching every other tenant on the shared cluster.</p>
      </CardFaceDocument>
    ),
  },
  { id: "tokens", kind: "image", title: "Dark mode tokens for the dashboard", project: "kestrel-web", time: ago(4), face: { src: SWATCHES } },
  { id: "search", kind: "document", title: "Search index for the docs site", project: "kestrel-web", time: ago(6) },
];

function PinMark({ on }: { readonly on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4">
      <path d="M6 2h4l-.5 4 2.5 2.5V10H4V8.5L6.5 6 6 2Zm2 8v4" strokeLinejoin="round" />
    </svg>
  );
}

function PinButton({ title, pinned, onToggle }: { readonly title: string; readonly pinned: boolean; readonly onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Pin ${title}`}
      aria-pressed={pinned}
      onClick={onToggle}
      className="grid size-7 place-items-center rounded-md bg-card text-frame-muted-fg shadow-[0_0_0_1px_var(--frame-card-ring)] hover:text-foreground aria-pressed:text-primary"
    >
      <PinMark on={pinned} />
    </button>
  );
}

export function PlansHomeCardsExample() {
  const [pins, setPins] = useState<ReadonlySet<string>>(() => new Set(["limits"]));
  const [updates, setUpdates] = useState(2);
  const [now, setNow] = useState<readonly Plan[]>(NOW);
  const grid = useRef<HTMLUListElement>(null);
  const pinned = (plan: Plan) => pins.has(plan.id);
  const togglePin = (id: string) =>
    setPins((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const action = (plan: Plan) => <PinButton title={plan.title} pinned={pinned(plan)} onToggle={() => togglePin(plan.id)} />;
  const showUpdates = () => {
    const apply = () =>
      flushSync(() => {
        setNow((current) => [...current.slice(1), current[0]!]);
        setUpdates(0);
      });
    if (grid.current === null) apply();
    else settleBatch(grid.current, apply);
  };
  const card = (plan: Plan, size: "large" | "regular") => (
    <Card
      key={plan.id}
      kind={plan.kind}
      size={size}
      title={plan.title}
      href={`#${plan.id}`}
      fact={plan.fact}
      factMark={plan.working ? <AgentMark /> : undefined}
      working={plan.working}
      unread={plan.unread}
      time={plan.time}
      face={plan.face}
      pinned={pinned(plan)}
      action={action(plan)}
    />
  );
  const row = (plan: Plan) => (
    <CardRow
      key={plan.id}
      kind={plan.kind}
      title={plan.title}
      href={`#${plan.id}`}
      fact={plan.fact}
      factMark={plan.working ? <AgentMark /> : undefined}
      working={plan.working}
      unread={plan.unread}
      time={plan.time}
      face={plan.face}
      secondary={plan.project}
      pinned={pinned(plan)}
      action={action(plan)}
    />
  );
  return (
    <div className="flex flex-col gap-14 p-6 sm:p-12">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[13px] font-medium leading-5 text-frame-muted-fg">Now</h2>
          <CardUpdatesPill count={updates} onShow={showUpdates} />
        </div>
        <CardGrid label="Now" ref={grid}>
          {now.map((plan) => card(plan, "large"))}
        </CardGrid>
      </section>
      <CardGroups>
        <CardGroup label="tidepool-api">{EARLIER.filter((plan) => plan.project === "tidepool-api").map((plan) => card(plan, "regular"))}</CardGroup>
        <CardGroup label="kestrel-web">{EARLIER.filter((plan) => plan.project === "kestrel-web").map((plan) => card(plan, "regular"))}</CardGroup>
      </CardGroups>
      <section className="flex max-w-[960px] flex-col gap-1">
        <h2 className="px-2 text-[13px] font-medium leading-7 text-frame-muted-fg">The same plans as a list</h2>
        <div role="list" aria-label="All plans" className="flex flex-col">
          {[...NOW, ...EARLIER].map((plan) => (
            <div role="listitem" key={plan.id}>
              {row(plan)}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
