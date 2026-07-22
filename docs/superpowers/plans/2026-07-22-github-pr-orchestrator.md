# GitHub PR Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GitHub-only web MVP for saving ordered PR workflows and tracking their PR readiness.

**Architecture:** A Next.js client consumes API routes backed by an in-memory GitHub-shaped provider. Pure domain functions own workflow transitions and notification decisions so they can later be reused with a GitHub App and persistent store.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS, Vitest.

---

### Task 1: Scaffold application and tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `app/layout.tsx`
- Create: `app/globals.css`
- Create: `vitest.config.ts`

- [ ] Add Next.js scripts for development, build, lint, and tests.
- [ ] Configure TypeScript path aliases and Vitest.
- [ ] Verify `npm test` can discover tests.

### Task 2: Model the workflow state machine with tests

**Files:**
- Create: `src/lib/domain.ts`
- Create: `src/lib/domain.test.ts`

- [ ] Write a failing test proving an unopened stage cannot be actioned before the previous stage is merged and post-merge checks pass.
- [ ] Implement the minimum domain transition logic.
- [ ] Write and pass tests for GitHub compare and native PR URLs and actionable notification transitions.

### Task 3: Create a GitHub provider seam and API routes

**Files:**
- Create: `src/lib/github-provider.ts`
- Create: `src/lib/mock-github-provider.ts`
- Create: `app/api/dashboard/route.ts`
- Create: `app/api/workflows/route.ts`
- Create: `app/api/workflows/[id]/route.ts`

- [ ] Return repositories, real branch options, workflow runs, and action results through route handlers.
- [ ] Seed two repositories with workflows in different states.

### Task 4: Build dashboard and detail interactions

**Files:**
- Create: `app/page.tsx`
- Create: `app/workflows/[id]/page.tsx`
- Create: `src/components/*`

- [ ] Render a multi-repository dashboard with current action and status.
- [ ] Render a stage timeline with checks, approvals, next-step gating, and GitHub links.
- [ ] Add a workflow editor that uses repository branches and creates an ordered flow.

### Task 5: Add browser notifications and verify

**Files:**
- Create: `src/lib/browser-notifications.ts`
- Modify: `src/components/workflow-monitor.tsx`

- [ ] Poll active workflows while the page is open.
- [ ] Send browser notifications only for actionable state changes.
- [ ] Run tests, lint, and production build.
