# GitHub PR Orchestrator Design

## Goal

Build a GitHub-only web application that lets a user save a repository-specific sequence of real source and target branches, create each pull request in order, and track the approvals and checks that determine the next action.

## Scope

The MVP includes a local demo data layer, a workflow list, workflow creation, workflow detail, GitHub-native PR links, and browser notifications while the page is open. It deliberately does not include GitHub OAuth, server-side webhooks, persisted credentials, closed-browser push, or Codex automation.

## Product model

`WorkflowTemplate` is a saved, repository-specific ordered list of stages. Every stage stores an existing GitHub branch as `sourceBranch` and `targetBranch`.

`WorkflowRun` is a live execution of one template. Each stage has a PR state and check/review state. A later stage is locked until its prerequisite is merged and its post-merge checks are successful. The detail page communicates the current action rather than asking users to infer it from GitHub tabs.

## UI

The dashboard lists workflow runs across repositories and displays the current stage, status, and next action. The workflow editor selects a repository and its real branches from a GitHub-shaped provider interface, then adds ordered stages. The detail page renders a timeline of steps, each showing PR state, Actions/checks, approvals, and context-sensitive buttons:

- Create PR opens a confirmation and creates a draft in the demo provider.
- Open GitHub opens the native compare/new-PR URL before a PR exists and the native PR URL after creation.
- Confirm preview unlocks the release PR after a merged feature step has passed its post-merge checks.

## State and notifications

The browser client polls the provider for active workflow runs. When a user-actionable state transition occurs (checks passed, checks failed, approvals satisfied, PR merged, or the next stage unlocked), it creates an in-app notification and invokes the browser Notification API if permission is granted. Notifications intentionally work only while the application is open in this MVP.

## Architecture

Use Next.js with TypeScript and App Router. Keep domain types and workflow transition logic in framework-independent modules, backed initially by an in-memory GitHub provider containing realistic repository, branch, PR, and check data. Route handlers form the seam where a GitHub App-backed provider and database will be introduced later. React pages poll the route handlers and render the returned workflow data.

## Validation

Unit tests cover branch selection, native GitHub URLs, stage locking/unlocking, and actionable notifications. Build and lint validate the application boundary.
