import React from "react";
import logoImage from "../plannotator.webp";
import { ModeToggle } from "./ModeToggle";

interface LandingProps {
  onEnter?: () => void;
}

export const Landing: React.FC<LandingProps> = ({ onEnter }) => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 h-12 flex items-center justify-between px-6 bg-background/80 backdrop-blur-sm border-b border-border/30 z-50">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">
            Plannotator
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <a
              href="https://github.com/backnotprop/plannotator"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              GitHub
            </a>
            <span className="text-muted-foreground/50">|</span>
            <a
              href="https://github.com/backnotprop/plannotator/blob/main/apps/hook/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Install
            </a>
          </div>
          <ModeToggle />
        </div>
      </nav>

      {/* Content wrapper with vertical borders */}
      <div className="max-w-4xl mx-auto border-x border-border/30">
        {/* Hero */}
        <section className="pt-32 pb-20 px-8">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              For Claude Code & OpenCode
            </div>

            <div className="flex items-center gap-6 mb-4">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-[1.1]">
                Annotate plans.
                <br />
                <span className="text-muted-foreground">
                  Not in the terminal.
                </span>
              </h1>
              <img
                src={logoImage}
                alt="Plannotator logo"
                className="w-20 h-20 md:w-24 md:h-24 object-contain shrink-0 -scale-x-100"
              />
            </div>

            <p className="text-lg text-muted-foreground mb-8 max-w-lg">
              Interactive Plan Review for coding agents. Mark up and refine plans visually,
              share for team collaboration. Works with Claude Code and OpenCode.
            </p>

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                {/* YouTube button - Claude Code */}
                <a
                  href="https://www.youtube.com/watch?v=a_AT7cEN_9I"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-secondary text-white font-medium hover:opacity-90 transition-opacity"
                >
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                  </svg>
                  Watch for Claude Code
                </a>

                {/* Open Demo button */}
                {onEnter ? (
                  <button
                    onClick={onEnter}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
                  >
                    Open Demo
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  </button>
                ) : (
                  <a
                    href="https://share.plannotator.ai"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
                  >
                    Open Demo
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  </a>
                )}
              </div>

              {/* OpenCode video link */}
              <a
                href="https://youtu.be/_N7uo0EFI-U"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Also watch for OpenCode →
              </a>
            </div>
          </div>
        </section>

        {/* Problem → Solution */}
        <section className="py-16 px-8 border-t border-border/30">
          <div className="grid md:grid-cols-2 gap-8 max-w-2xl">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                The Problem
              </h3>
              <p className="text-foreground/90">
                Coding agents show plans in the terminal. You approve or deny, but
                giving specific feedback means typing everything out. Hard to
                reference exact sections. Zero collaboration features.
              </p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                The Solution
              </h3>
              <p className="text-foreground/90">
                Select the exact parts of the plan you want to change. Mark for
                deletion, add a comment, or suggest a replacement. Share plans
                with your team. Feedback flows back to your agent automatically.
              </p>
            </div>
          </div>
        </section>

        {/* Privacy & Sharing */}
        <section className="py-16 px-8 border-t border-border/30">
          <div className="grid md:grid-cols-2 gap-8 max-w-2xl">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0">
                <svg
                  className="w-5 h-5 text-secondary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Runs locally.</h3>
                <p className="text-muted-foreground text-sm">
                  Local plugin. No network requests. Plannotator runs entirely
                  in your browser. Plans never leave your machine.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <svg
                  className="w-5 h-5 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                  />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Share privately.</h3>
                <p className="text-muted-foreground text-sm">
                  Collaborate without a backend. Plans and annotations compress
                  into the URL itself — share a link. No accounts, no database,
                  no third parties. Inspired by{" "}
                  <a
                    href="https://github.com/antonmedv/textarea"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    textarea.my
                  </a>
                  .
                </p>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-[#7c3aed]/10 flex items-center justify-center shrink-0">
                <svg
                  className="w-5 h-5 text-[#7c3aed]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                  />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Save to Obsidian.</h3>
                <p className="text-muted-foreground text-sm">
                  Approved plans auto-save to your vault with frontmatter and
                  auto-extracted tags. Build a searchable archive of every plan
                  your agents create.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Preview */}
        <section className="py-16 px-8 border-t border-border/30">
          <h2 className="text-xl font-semibold mb-8 text-center">
            What it looks like
          </h2>

          {/* App Preview */}
          <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden shadow-2xl">
            {/* Mock Header */}
            <div className="h-10 bg-card/80 border-b border-border/30 flex items-center px-4 gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-destructive/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-accent/60" />
                <div className="w-2.5 h-2.5 rounded-full bg-secondary/60" />
              </div>
              <div className="flex-1 flex justify-center">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <div className="w-4 h-4 rounded bg-primary/20" />
                  <span>Plannotator</span>
                </div>
              </div>
              <div className="w-16" />
            </div>

            {/* Mock Content */}
            <div className="flex h-80">
              {/* Document Area */}
              <div className="flex-1 p-6 bg-background/50 flex items-start justify-center">
                <div className="w-full max-w-sm bg-card rounded-lg border border-border/30 p-5 shadow-lg">
                  {/* Mock heading */}
                  <div className="h-3 w-3/4 bg-foreground/80 rounded mb-4" />

                  {/* Mock paragraph */}
                  <div className="space-y-2 mb-4">
                    <div className="h-2 w-full bg-muted-foreground/30 rounded" />
                    <div className="h-2 w-5/6 bg-muted-foreground/30 rounded" />
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-1/4 bg-muted-foreground/30 rounded" />
                      <div className="h-2 w-1/3 bg-destructive/40 rounded line-through" />
                      <div className="h-2 w-1/6 bg-muted-foreground/30 rounded" />
                    </div>
                  </div>

                  {/* Mock subheading */}
                  <div className="h-2.5 w-1/2 bg-foreground/60 rounded mb-3 mt-5" />

                  {/* Mock list */}
                  <div className="space-y-2 mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-1 h-1 rounded-full bg-primary/60" />
                      <div className="h-2 w-4/5 bg-muted-foreground/30 rounded" />
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-1 h-1 rounded-full bg-primary/60" />
                      <div className="h-2 w-2/3 bg-accent/40 rounded border-b border-accent" />
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-1 h-1 rounded-full bg-primary/60" />
                      <div className="h-2 w-3/4 bg-muted-foreground/30 rounded" />
                    </div>
                  </div>

                  {/* Mock code block */}
                  <div className="bg-muted/50 rounded p-2 space-y-1.5">
                    <div className="h-1.5 w-1/2 bg-primary/40 rounded" />
                    <div className="h-1.5 w-2/3 bg-muted-foreground/30 rounded" />
                    <div className="h-1.5 w-1/3 bg-secondary/40 rounded" />
                  </div>
                </div>
              </div>

              {/* Mock Sidebar */}
              <div className="w-48 border-l border-border/30 bg-card/30 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3 flex items-center justify-between">
                  <span>Annotations</span>
                  <span className="bg-muted px-1.5 py-0.5 rounded text-[9px]">
                    2
                  </span>
                </div>

                {/* Mock annotation cards */}
                <div className="space-y-2">
                  <div className="p-2 rounded-md border border-destructive/30 bg-destructive/5">
                    <div className="flex items-center gap-1 mb-1.5">
                      <div className="w-3 h-3 rounded bg-destructive/20" />
                      <span className="text-[9px] font-semibold text-destructive uppercase">
                        Delete
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded" />
                  </div>

                  <div className="p-2 rounded-md border border-accent/30 bg-accent/5">
                    <div className="flex items-center gap-1 mb-1.5">
                      <div className="w-3 h-3 rounded bg-accent/20" />
                      <span className="text-[9px] font-semibold text-accent uppercase">
                        Comment
                      </span>
                    </div>
                    <div className="h-1.5 w-3/4 bg-muted rounded mb-1" />
                    <div className="h-1.5 w-full bg-accent/20 rounded" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="text-center text-sm text-muted-foreground mt-6">
            Select text → annotate → export feedback
          </p>
        </section>

        {/* How it works */}
        <section className="py-16 px-8 border-t border-border/30 bg-card/30">
          <h2 className="text-xl font-semibold mb-8">How it works</h2>

          <div className="space-y-6 max-w-2xl">
            <Step num={1} title="Agent triggers Plannotator">
              <span className="text-xs">
                <strong>Claude Code:</strong> ExitPlanMode hook opens UI<br />
                <strong>OpenCode:</strong> Agent calls submit_plan tool
              </span>
            </Step>

            <Step num={2} title="Annotate visually">
              Select text → choose action (delete, comment, replace) → annotations appear
              in the sidebar
            </Step>

            <Step num={3} title="Approve or request changes">
              Click approve to proceed, or provide feedback with annotations.
              Feedback flows back to your agent automatically.
            </Step>
          </div>
        </section>

        {/* Technical */}
        <section className="py-16 px-8 border-t border-border/30 bg-card/30">
          <h2 className="text-xl font-semibold mb-6">Technical details</h2>
          <ul className="space-y-2 text-sm text-muted-foreground max-w-2xl mb-6">
            <li className="flex items-center gap-2">
              <span className="text-primary">•</span>
              Single HTML file build — runs from Bun server on random port
            </li>
            <li className="flex items-center gap-2">
              <span className="text-primary">•</span>
              <strong>Claude Code:</strong> Binary + plugin with PermissionRequest hook
            </li>
            <li className="flex items-center gap-2">
              <span className="text-primary">•</span>
              <strong>OpenCode:</strong> npm package with submit_plan tool
            </li>
            <li className="flex items-center gap-2">
              <span className="text-primary">•</span>
              URL sharing via deflate compression — no backend required
            </li>
          </ul>

          <a
            href="https://github.com/backnotprop/plannotator"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="inline-flex items-center rounded overflow-hidden">
              <span className="bg-[#121011] text-white px-2 py-1 flex items-center gap-1.5">
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                <span className="text-xs font-medium">GitHub</span>
              </span>
            </span>
            <span className="underline underline-offset-2">
              View GitHub repository
            </span>
          </a>
        </section>

        {/* Footer */}
        <footer className="py-8 px-8 border-t border-border/30 text-center">
          <p className="text-xs text-muted-foreground inline-flex items-center justify-center gap-1">
            <a
              href="https://github.com/backnotprop"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-foreground hover:text-primary transition-colors"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              backnotprop
            </a>{" "}
            ·{" "}
            <a
              href="https://x.com/backnotprop"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:text-primary transition-colors"
            >
              @backnotprop
            </a>
          </p>
          <p className="text-xs text-muted-foreground/60 mt-2">
            &copy; 2025 backnotprop. All rights reserved.
          </p>
        </footer>
      </div>
    </div>
  );
};

const Step: React.FC<{
  num: number;
  title: string;
  children: React.ReactNode;
}> = ({ num, title, children }) => (
  <div className="flex gap-4">
    <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-semibold flex items-center justify-center shrink-0">
      {num}
    </div>
    <div>
      <h4 className="font-medium mb-1">{title}</h4>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  </div>
);
