# Workstream Architecture: Orchestrating Agentic Development

## Introduction

As agentic capabilities grow, managing complex development objectives requires more than just individual tasks. The Workstream Architecture introduces a hierarchical, context-aware system in Hester to orchestrate multi-agent workflows, moving beyond atomic tasks to manage overarching objectives, dynamic plans, and comprehensive knowledge bases. This system transforms Hester into a **Technical Product Manager (TPM)**, guiding various agents (like Claude Code and Hester's internal agents) through a structured development lifecycle.

The primary goal is to address the challenges of:
*   **Context Management:** Ensuring agents receive only relevant information for their current task, preventing "context overload" and reducing hallucinations.
*   **Workflow Orchestration:** Providing a clear, dynamic plan (Runbook) that adapts to progress and new discoveries.
*   **Observability:** Offering a unified view of all active agents and their contributions to an objective.
*   **Proactive Assistance:** Hester actively guiding the user and agents through the development process with intelligent suggestions.

## Core Concepts

### 1. Workstream
The `Workstream` is the central, top-level entity representing a significant development objective or "project." It encapsulates everything related to achieving a specific goal, from initial ideas to final implementation.

*   **Objective:** The "North Star" goal (e.g., "Migrate User Authentication to Clerk").
*   **State:** The current phase of the Workstream lifecycle (Exploration, Design & Validation, Planning, Execution, Review, Done).
*   **Agents:** A registry of all agents (Claude Code instances, Hester internal agents) currently contributing to this Workstream.

### 2. Context Warehouse
This is the Workstream's unified knowledge base, a comprehensive repository of all information relevant to the objective. It acts as the "library" from which Hester can draw context for specific tasks.

*   **Contents:** Project documentation, relevant code files, context bundles, web research findings, design specifications, user stories, API documentation, etc.
*   **Purpose:** To provide a single, authoritative source of truth for the Workstream, which Hester can intelligently "slice" for individual tasks.

### 3. Runbook
The `Runbook` is a dynamic, ordered sequence of `Tasks` (or sub-objectives) required to achieve the Workstream's objective. Unlike a static checklist, the Runbook is actively managed and updated by Hester, adapting to progress, new discoveries, and agent feedback.

*   **Structure:** A directed graph of `Tasks`, allowing for dependencies and conditional paths.
*   **Dynamic Nature:** Hester can add, remove, or reorder tasks based on real-time execution outcomes and proactive analysis.
*   **Proactive Suggestions:** Hester will automatically suggest next steps, validation checks, documentation updates, or new research items.

### 4. Agents
These are the entities performing the actual work.
*   **Claude Code:** Primarily responsible for code generation, modification, and technical implementation.
*   **Hester Internal Agents:** Responsible for orchestration, context management, documentation, testing, and proactive suggestions.

## The Workstream Lifecycle

A Workstream progresses through distinct phases, each with specific inputs, activities, and outputs.

### Phase 1: Exploration (The "Product Owner" Phase)
*   **Input:** User's initial idea, vague requirements, chat conversations with Hester.
*   **Activity:** Brainstorming, high-level goal definition, clarifying initial intent. Hester acts as an ideation partner.
*   **Output:** **The Brief**. A high-level, natural language statement outlining *what* needs to be accomplished and *why*. This is promoted from an "Idea" to a new "Workstream" instance.

### Phase 2: Design & Validation (The "Staff Engineer" Phase)
This is a critical grounding phase, preventing agents from confidently hallucinating or implementing incompatible solutions.
*   **Input:** The Brief.
*   **Activity:** Hester (as the Staff Engineer) performs deep analysis:
    *   **Grounding:** Scans the existing codebase to identify relevant files, modules, and architectural constraints. Maps the brief to concrete code locations.
    *   **Research:** Conducts web searches, documentation lookups (internal and external) to validate approaches, identify best practices, and uncover potential issues.
    *   **Adversarial Challenging (Red Teaming):** Hester proactively identifies potential conflicts, breaking changes, security implications, or architectural incompatibilities. It challenges the user with questions like: "This approach might break API compatibility for mobile clients; how should we handle that?"
*   **Output:** **The Design Doc**. A structured markdown specification (stored in the Context Warehouse) that becomes the authoritative "Source of Truth" for the Workstream. This document includes validated approaches, identified constraints, and key decisions.

### Phase 3: Planning (The "Project Manager" Phase)
*   **Input:** The Design Doc.
*   **Activity:** Hester (as the Project Manager) decomposes the Design Doc into actionable steps.
*   **Output:** **The Initial Runbook**. A dynamic graph of atomic `Tasks` (e.g., "Create migration file," "Update `User` model," "Implement API endpoint"). These tasks are initially in a `Pending` state.

### Phase 4: Execution (The "Dev Team" Phase)
This is where the actual development work happens, with Hester intelligently managing context.
1.  **Task Selection:** Hester identifies the next `Pending` Task in the Runbook.
2.  **Context Slicing:** This is the core innovation. Hester accesses the comprehensive `Context Warehouse` and intelligently extracts *only the information relevant to the current Task*. Irrelevant files, research, or documentation are withheld to prevent context overload for the executing agent.
    *   *Example:* For a "Create migration file" task, Hester might inject the `db_schema` context bundle and relevant model definitions, but *not* frontend code or API gateway configurations.
3.  **Agent Dispatch:** Hester dispatches the Task along with its "sliced" context to the appropriate agent (e.g., `claude_code` for implementation, `hester` for documentation or testing).
4.  **Real-time Telemetry:** Agents (via CLI hooks) report their status, current focus, and tool usage back to Hester.
5.  **Review & Dynamic Update:**
    *   Upon Task completion, Hester reviews the outcome (e.g., code changes, test results).
    *   Hester dynamically updates the Runbook:
        *   Marks tasks as `Completed` or `Failed`.
        *   **Proactively suggests new tasks:** "The new API endpoint requires updated documentation. Adding 'Update API Docs' to the Runbook."
        *   **Revises existing tasks:** "The test run failed. Re-opening 'Implement API endpoint' with a hint about the error."

## User Experience: The "Workstream" Tab in Lee

A new dedicated "Workstream" tab in the Lee IDE will serve as the central control panel for this architecture.

### 1. Workstream Overview
*   A list of all active Workstreams, showing their Objective, current Phase, and overall progress.
*   Ability to create new Workstreams (e.g., "Promote Idea to Workstream").

### 2. Individual Workstream View
When a user selects a Workstream, the tab will subdivide into three main panels:

#### Left Panel: The Runbook View
*   **Dynamic Checklist:** A visual representation of the Runbook, showing tasks as:
    *   `Pending`: Waiting to be started.
    *   `Active`: Currently being worked on by an agent.
    *   `Completed`: Successfully finished.
    *   `Failed`: Encountered an issue.
*   **Hester's Proactive Suggestions:** New items dynamically appear in the Runbook, clearly marked as Hester's suggestions (e.g., "Hester: Run integration tests," "Hester: Create `auth-system` context bundle").
*   **Task Details:** Expanding a task reveals its specific prompt, assigned agent, and any sliced context injected.

#### Center Panel: The Agent Workspace
*   **Live Agent Telemetry:** Real-time updates from the active agent(s) on this Workstream (via CLI hooks).
    *   **Current Focus:** What the agent is actively thinking about or working on (e.g., "Claude Code: Refactoring `auth.py` to use Clerk SDK").
    *   **Active Tool:** Which tool the agent is currently using (e.g., "Claude Code: `read_file('src/auth.py')`").
    *   **Streaming Logs/Diffs:** Live output from agent execution, including code changes, test results, or research findings.
*   **Intervention Points:** Controls to pause, resume, or provide direct input to an active agent.

#### Right Panel: The Context Warehouse View
*   **Workstream Library:** A navigable list of all files, documents, and context bundles stored in the Workstream's Context Warehouse.
*   **Context Transparency:** A visual indicator highlighting *which specific pieces of context* from the warehouse are currently being "injected" into the active agent for its current task. This provides crucial transparency into what the agent "knows."
*   **Context Management:** Tools to add new files, link external documentation, or create new context bundles directly within the Workstream.

## Terminology Glossary

*   **Workstream:** The overarching development objective or project.
*   **Context Warehouse:** The comprehensive knowledge base for a Workstream.
*   **Runbook:** The dynamic, agent-managed plan of tasks for a Workstream.
*   **The Brief:** The high-level objective and rationale from the Exploration phase.
*   **The Design Doc:** The validated, detailed specification produced during the Design & Validation phase.
*   **Context Slicing:** Hester's intelligent process of selecting only relevant context for an agent's current task.
*   **Agent Telemetry:** Real-time status updates from agents via CLI hooks.

## Benefits

*   **Reduced Agent Hallucinations:** By providing tightly scoped, validated context, agents are less likely to generate irrelevant or incorrect code.
*   **Improved Context Management:** Eliminates the need for users to manually curate context for each agent interaction.
*   **Enhanced Observability:** Provides a clear, real-time overview of complex, parallel agentic workflows.
*   **Proactive Assistance:** Hester acts as an intelligent assistant, guiding the development process, suggesting next steps, and ensuring comprehensive coverage (e.g., testing, documentation).
*   **Hierarchical Problem Solving:** Enables breaking down large objectives into manageable, traceable steps.
*   **Better User Experience:** A centralized, intuitive interface for managing sophisticated agentic development.
