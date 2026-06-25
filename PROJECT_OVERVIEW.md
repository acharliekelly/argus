# Project: Argus

## Core Idea

An AI-assisted maintenance system that safely updates WordPress sites by cloning/staging them, applying updates, running automated visual and functional checks, detecting regressions, and producing a human-readable report or rollback plan.

## MVP Version

MVP version is CLI tool.

### Flow:

- User provides WordPress site info.
- Agent creates or uses a staging copy.
- Agent records current plugin/theme/core versions.
- Agent updates one thing at a time.
- Agent runs Playwright tests.
- Agent captures before/after screenshots.
- Agent detects visual differences.
- Agent summarizes:
  - what changed
  - what passed
  - what failed
  - likely cause
  - suggested next action
- Human approves deploy or rollback.

### Architecture Sketch

CLI / Web UI
   |
Maintenance Orchestrator
   |
   +-- WordPress Adapter
   |     - WP-CLI commands
   |     - plugin/theme/core inventory
   |     - update execution
   |
   +-- Test Runner
   |     - Playwright
   |     - smoke tests
   |     - login checks
   |     - form checks
   |
   +-- Visual Regression Engine
   |     - screenshots
   |     - pixel diff
   |     - threshold rules
   |
   +-- AI Analysis Layer
   |     - summarize diffs
   |     - classify failures
   |     - draft report
   |     - suggest rollback/deploy
   |
   +-- GitHub Integration
         - open issue
         - create PR
         - attach report artifacts


## Stack

- Node.js + TypeScript for orchestration
- Playwright for browser automation
- WP-CLI for WordPress operations
- Docker Compose for local/staging WordPress
- GitHub Actions for CI
- LLM API for report generation and failure classification

## Feature phases

### Phase 1: Deterministic automation

- inventory plugins
- run updates
- run Playwright
- capture screenshots
- diff screenshots
- produce JSON report

### Phase 2: AI reporting

- summarize JSON report
- classify failures
- suggest next actions
- generate client-friendly report

### Phase 3: GitHub integration

- create issue when update fails
- attach screenshots
- commit updated lock/config files if relevant
- add CI workflow

### Phase 4: Agentic mode

Only after guardrails exist:
- choose update order
- retry flaky tests
- isolate problematic plugin
- propose rollback
- never deploy without approval

## Demo scenario

Use a local WordPress site with a few plugins.

Record a demo where the agent:

- detects outdated plugins
- updates one plugin
- runs Playwright
- catches a visual regression
- explains the likely issue
- recommends rollback
- enerates a report