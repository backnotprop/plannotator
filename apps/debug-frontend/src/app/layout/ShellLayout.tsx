import { Link, Outlet } from "@tanstack/react-router";

export function ShellLayout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local runtime shell</p>
          <h1>Plannotator</h1>
        </div>
        <nav aria-label="Primary">
          <Link to="/" activeProps={{ "aria-current": "page" }}>
            Sessions
          </Link>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
