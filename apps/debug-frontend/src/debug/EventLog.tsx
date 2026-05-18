import type { ShellDaemonEvent } from "../daemon/contracts";
import { useDaemonDebugStore } from "../daemon/events/event-store";

export function EventLog() {
  const events = useDaemonDebugStore((state) => state.events);
  const connectionState = useDaemonDebugStore((state) => state.connectionState);

  if (events.length === 0 && connectionState === "idle") return null;

  return (
    <section className="event-log-section">
      <div className="event-log-header">
        <h3>Event log</h3>
        <span className={`status-pill status-${connectionState}`}>{connectionState}</span>
      </div>
      {events.length === 0 ? (
        <p className="muted-line">Waiting for events...</p>
      ) : (
        <ol className="event-log">
          {events.slice(0, 30).map((event, index) => (
            <EventRow key={`${event.at}-${index}`} event={event} />
          ))}
        </ol>
      )}
    </section>
  );
}

function EventRow({ event }: { event: ShellDaemonEvent }) {
  const time = formatEventTime(event.at);

  if (event.type === "debug-log") {
    return (
      <li className="event-row event-row-debug">
        <time>{time}</time>
        <span className="event-source">{event.source}</span>
        <span>{event.message}</span>
      </li>
    );
  }

  if (event.type === "session-created" || event.type === "session-updated") {
    return (
      <li className="event-row event-row-session">
        <time>{time}</time>
        <span className="event-type">{event.type}</span>
        <code>{event.session.id}</code>
      </li>
    );
  }

  if (event.type === "daemon-status" || event.type === "snapshot") {
    return (
      <li className="event-row event-row-status">
        <time>{time}</time>
        <span className="event-type">{event.type}</span>
        <span className="muted-line">
          {event.status.activeSessionCount} active, pid {event.status.pid}
        </span>
      </li>
    );
  }

  return (
    <li className="event-row">
      <time>{time}</time>
      <span className="event-type">{event.type}</span>
    </li>
  );
}

function formatEventTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 2,
  });
}
