# DevOps Configuration Guide

The DevOps TUI (`hester devops tui`) manages local development services defined in `.lee/config.yaml`. This guide covers everything from basic service definitions to multi-environment setups and composable macros.

## Quick Start

Add a `services:` block to `.lee/config.yaml`:

```yaml
services:
  - name: Docker
    detect: docker
    ports: [5432, 6379]
    actions:
      - name: up
        command: docker-compose up -d
        shortcut: ctrl+u
      - name: down
        command: docker-compose down
        shortcut: ctrl+d
```

Launch with `hester devops tui`.

## Service Definition

Each service is a named group of actions with status detection.

```yaml
services:
  - name: Docker              # Display name in TUI
    description: "Containers"  # Optional description
    detect: docker             # Status detection method
    cwd: ./infra              # Working directory (relative to workspace)
    ports: [5432, 6379]        # Ports to monitor
    health_checks:             # HTTP endpoints to probe
      - http://localhost:5432/health
    actions:
      - name: up
        command: docker-compose up -d
        shortcut: ctrl+u      # Ctrl+key binding in TUI
      - name: down
        command: docker-compose down
      - name: rebuild
        command: docker-compose up -d --build
```

### Detection Methods

| `detect` value | How it checks status |
|---------------|---------------------|
| `docker` | Queries `docker ps` for running containers |
| `supabase` | Runs `npx supabase status` |
| `port` | Checks if any listed port is listening (default) |
| `flutter` | Port-based, with Flutter hot-reload support |

### Action Shortcuts

Actions can bind to `Ctrl+<key>` in the TUI:

```yaml
actions:
  - name: up
    command: docker-compose up -d
    shortcut: ctrl+u    # Ctrl+U in the TUI
  - name: flush
    command: docker exec redis redis-cli FLUSHALL
    shortcut: ctrl+f    # Ctrl+F in the TUI
```

The TUI's Quick Actions panel shows all bound shortcuts. Unbound actions are accessible by selecting the service and pressing Enter (runs the first/default action).

### Flutter Services

Services with Flutter commands get special treatment -- the TUI captures the PTY and exposes hot-reload keys:

| Key | Action |
|-----|--------|
| `r` | Hot reload |
| `R` | Hot restart |
| `q` | Quit Flutter |
| `p` | Toggle widget inspector |
| `o` | Toggle platform |

```yaml
  - name: App
    detect: flutter
    cwd: ./app
    actions:
      - name: web
        command: flutter run -d chrome
        shortcut: ctrl+f
      - name: ios
        command: flutter run -d iPhone
```

## Environments

For projects that span local, staging, and production contexts, wrap services inside named environments:

```yaml
active_environment: local    # Which env to start on

environments:
  local:
    description: "Local development"
    docker_context: desktop-linux       # Runs `docker context use` on switch
    kubectl_context: minikube           # Runs `kubectl config use-context` on switch
    services:
      - name: Docker
        detect: docker
        ports: [5432, 6379]
        actions:
          - name: up
            command: docker-compose up -d
            shortcut: ctrl+u
          - name: down
            command: docker-compose down
          - name: flush-redis
            command: docker exec redis redis-cli FLUSHALL

  staging:
    description: "Staging environment"
    docker_context: staging-remote
    kubectl_context: staging-cluster
    confirm_actions: true               # Prompt [y/N] before every action
    services:
      - name: API
        detect: port
        ports: [8080]
        actions:
          - name: restart
            command: kubectl rollout restart deploy/api
          - name: flush-redis
            command: kubectl exec svc/redis -- redis-cli FLUSHALL
          - name: logs
            command: kubectl logs -f deploy/api
```

### Environment Properties

| Property | Type | Description |
|----------|------|-------------|
| `description` | string | Shown in TUI header and `hester devops env` |
| `docker_context` | string | Auto-runs `docker context use <value>` on switch |
| `kubectl_context` | string | Auto-runs `kubectl config use-context <value>` on switch |
| `confirm_actions` | bool | Require `y` confirmation before any action (default: false) |
| `services` | list | Service definitions scoped to this environment |

### Switching Environments

**TUI**: Press `e` to cycle forward, `E` to cycle backward. The header shows all environments with the active one highlighted:

```
┌── Hester DevOps  ~/project ──────────────────────────────────────────┐
│  Env: [local]  staging                          2/3 services running  │
└──────────────────────────────────────────────────────────────────────┘
```

**CLI**:
```bash
hester devops env              # Show all environments
hester devops env staging      # Switch to staging
```

When you switch, the TUI reloads the services panel for that environment and runs any configured Docker/kubectl context switches.

### Backwards Compatibility

A bare `services:` list (no `environments:` key) works exactly as before. The TUI treats it as an implicit "default" environment and hides the environment switcher.

## Macros

Macros chain multiple steps into a single command. They can reference service actions across environments, run raw shell commands, and switch contexts.

```yaml
macros:
  - name: flush-all-redis
    description: "Flush Redis on local and staging"
    shortcut: ctrl+x          # Ctrl+key binding in TUI
    confirm: true              # Prompt before running
    steps:
      - service: Docker
        action: flush-redis
        environment: local
      - service: API
        action: flush-redis
        environment: staging

  - name: fresh-local
    description: "Nuke and rebuild local dev"
    steps:
      - service: Docker
        action: down
        environment: local
      - command: docker volume prune -f
      - service: Docker
        action: up
        environment: local

  - name: deploy-staging
    description: "Build, push, and restart staging"
    steps:
      - command: >-
          docker-compose -f docker-compose.staging.yml build &&
          docker-compose -f docker-compose.staging.yml push
      - context: staging
      - service: API
        action: restart
        environment: staging
```

### Step Types

Each step in a macro is one of three patterns:

**1. Service action** -- runs a named action from a service:

```yaml
- service: Docker        # Service name
  action: up             # Action name on that service
  environment: local     # Optional; uses active environment if omitted
```

**2. Shell command** -- runs an arbitrary command:

```yaml
- command: docker volume prune -f
  cwd: ./infra           # Optional working directory
```

**3. Context switch** -- switches the active environment (and its Docker/kubectl contexts):

```yaml
- context: staging       # Environment name to switch to
```

### Macro Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Identifier, used in CLI and TUI |
| `description` | string | Shown in macros panel |
| `shortcut` | string | `ctrl+<key>` binding in TUI (e.g., `ctrl+x`) |
| `confirm` | bool | Prompt before running (default: false) |
| `steps` | list | Ordered list of steps to execute |

### Running Macros

**TUI**: Macros appear in a dedicated panel below services:

```
┌── Macros ────────────────────────────────────────────────────────────┐
│  [Ctrl+X] flush-all-redis      Flush Redis on local and staging   ⚠  │
│  [m1]     fresh-local          Nuke and rebuild local dev            │
│  [m2]     deploy-staging       Build, push, and restart staging      │
└──────────────────────────────────────────────────────────────────────┘
```

- Macros with `shortcut` use their Ctrl+key binding directly
- Macros without shortcuts: press `m` then `1`-`9`
- The `⚠` indicator marks macros that require confirmation

The header shows macro progress while running: `[Macro: fresh-local 2/3]`

**CLI**:
```bash
hester devops macro                         # List all macros
hester devops macro flush-all-redis         # Run a macro
hester devops macro deploy-staging --dry-run # Preview steps without executing
```

### Execution Behavior

- Steps run **sequentially** -- each must succeed before the next starts
- On failure, execution **stops immediately** and reports which step failed
- Context switches performed during a macro persist after it completes
- Service action steps temporarily switch to the target environment if needed, then restore the original

## CLI Reference

```bash
# TUI
hester devops tui [--dir PATH]

# Service management
hester devops status [--env NAME]
hester devops start SERVICE [--env NAME]
hester devops stop SERVICE [--env NAME]
hester devops logs SERVICE [-f] [-n LINES]
hester devops health [--env NAME] [--service NAME]

# Environments
hester devops env                   # List environments
hester devops env NAME              # Switch environment

# Macros
hester devops macro                 # List macros
hester devops macro NAME            # Run macro
hester devops macro NAME --dry-run  # Preview steps

# Docker Compose shortcuts
hester devops up [SERVICES] [--build] [--no-cache]
hester devops down [-v] [--rmi all|local]
hester devops rebuild [SERVICES] [--no-cache]
hester devops build [SERVICES] [--no-cache]
hester devops ps
hester devops docker [--logs CONTAINER]
```

## TUI Keyboard Reference

### Dashboard Mode

| Key | Action |
|-----|--------|
| `Ctrl+<key>` | Run action or macro bound to that shortcut |
| `Up/Down` | Navigate services |
| `Enter` | Run default action on selected service |
| `e` / `E` | Cycle environment forward / backward |
| `m` + `1-9` | Run macro by number |
| `q` | Quit |

### Command/Output Mode

| Key | Action |
|-----|--------|
| `1-9` | Switch output tab |
| `Esc` | Return to dashboard (processes continue in background) |
| `q` | Dismiss output (only when nothing is running) |

### Flutter Mode (when Flutter service is running)

| Key | Action |
|-----|--------|
| `r` | Hot reload |
| `R` | Hot restart |
| `q` | Quit Flutter |
| `p` | Toggle widget inspector |
| `o` | Toggle platform |

## Hester Integration

Hester (the AI daemon) can control DevOps via its tool system:

- `devops_list_services(environment=)` -- list services
- `devops_start_service(service, environment=)` -- start a service
- `devops_stop_service(service, environment=)` -- stop a service
- `devops_switch_environment(name)` -- switch environment
- `devops_list_environments()` -- list environments
- `devops_run_macro(name, dry_run=)` -- run or preview a macro
- `devops_list_macros()` -- list macros

This means you can ask Hester things like "flush Redis on staging" or "run the deploy macro" and it can execute them through the tool system.

## Full Example

```yaml
active_environment: local

environments:
  local:
    description: "Local development"
    docker_context: desktop-linux
    services:
      - name: Infra
        detect: docker
        ports: [5432, 6379, 9200]
        actions:
          - name: up
            command: docker-compose up -d
            shortcut: ctrl+u
          - name: down
            command: docker-compose down
            shortcut: ctrl+d
          - name: flush-redis
            command: docker exec redis redis-cli FLUSHALL

      - name: API
        detect: port
        cwd: ./api
        ports: [8000]
        health_checks:
          - http://localhost:8000/health
        actions:
          - name: dev
            command: uvicorn main:app --reload
            shortcut: ctrl+a
          - name: test
            command: pytest -x

      - name: App
        detect: flutter
        cwd: ./app
        actions:
          - name: web
            command: flutter run -d chrome
            shortcut: ctrl+f
          - name: ios
            command: flutter run -d iPhone

  staging:
    description: "Staging (GKE)"
    docker_context: gke-staging
    kubectl_context: gke_project_staging
    confirm_actions: true
    services:
      - name: API
        detect: port
        ports: [8080]
        actions:
          - name: restart
            command: kubectl rollout restart deploy/api
          - name: logs
            command: kubectl logs -f deploy/api --tail=100
          - name: flush-redis
            command: kubectl exec svc/redis -- redis-cli FLUSHALL

macros:
  - name: fresh-start
    description: "Reset local: down, prune, up"
    steps:
      - service: Infra
        action: down
        environment: local
      - command: docker volume prune -f
      - service: Infra
        action: up
        environment: local

  - name: deploy
    description: "Build and deploy to staging"
    confirm: true
    shortcut: ctrl+p
    steps:
      - command: docker build -t gcr.io/project/api:latest ./api && docker push gcr.io/project/api:latest
      - context: staging
      - service: API
        action: restart
        environment: staging
```
