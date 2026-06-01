# Rector System Specification & Architectural Diagrams (Rector-Specs-1)

This document contains high-fidelity visual and technical specifications for the local-first **Rector** MVP. It outlines the overall system architecture, state transition lifecycle, operational event flows, data models, and the internal mechanics of the validation and self-healing subsystem.

---

## 1. High-Level System Architecture

The Rector MVP is a modular, single-node application written in Node.js/TypeScript. It decouples the core state machine orchestration (`TaskManager` / `Thalamus Router`) from external systems using clean provider boundaries.

```mermaid
graph TB
    subgraph Client Layer
        UI[Vanilla HTML5/CSS3/JS UI]
        REST[REST Clients / curl]
    end

    subgraph Express Application [API & Static Host]
        Server[Express Server]
        Static[Static Assets Public Server]
        Setup[Setup Checklist Masker]
    end

    subgraph Core Orchestration [Thalamus & State Engine]
        Manager[TaskManager Router]
        Trans[Transition Validator]
        Pipeline[Worker Pipeline Dispatcher]
    end

    subgraph Adaptation & Storage
        Repo[(InMemoryTaskRepository)]
        Bus[InMemoryEventBus]
        Tel[Local Telemetry Event Store]
    end

    subgraph Simulation & Providers [Local Adapters]
        Planner[Deterministic Planner]
        SLM[SLM Execution Engine]
        Sandbox[Sandbox Validator]
        Healer[Self-Healing Solver]
    end

    %% Client Interactions
    UI <-->|HTTP REST / SSE Poll| Server
    REST <-->|HTTP REST / JSON| Server
    Server <-->|Static UI Files| Static

    %% Express to Core
    Server <-->|Controller Invocation| Manager
    Server -.->|Sensitive Scan| Setup

    %% Core Orchestration Connections
    Manager <-->|Read/Write State| Repo
    Manager <-->|Transition Logic| Trans
    Manager <-->|Execute Steps| Pipeline
    
    %% Pipeline to Simulation Local Adapters
    Pipeline <-->|Plan Structure| Planner
    Pipeline <-->|Generate Code| SLM
    Pipeline <-->|Run Validation| Sandbox
    Pipeline <-->|Repair Subtasks| Healer

    %% Adapters and Core to Infrastructure
    Pipeline -.->|Record Telemetry| Tel
    Pipeline -.->|Publish Messages| Bus
    Manager -.->|Publish Transition Events| Bus
```

---

## 2. Deterministic State Machine Transition Lifecycle

Rector coordinates all build loops using a strict, single-step deterministic state machine. Manual interventions can pause or abort running tasks, and paused tasks can be retried starting from the intake state.

```mermaid
stateDiagram-v2
    [*] --> 1_INTAKE : Task Created via UI/API
    
    state Pipeline_Execution_Cycle {
        1_INTAKE --> 2_ARCHITECTURAL_PLAN : Advance (Distill Context)
        2_ARCHITECTURAL_PLAN --> 3_SLM_EXECUTION_FANOUT : Advance (Define Subtasks)
        3_SLM_EXECUTION_FANOUT --> 4_SANDBOX_VALIDATION : Advance (Run SLMs)
        
        4_SANDBOX_VALIDATION --> 6_FINAL_SYNTHESIS : Validation Passes
        4_SANDBOX_VALIDATION --> 5_HEALING_LOOP : Validation Fails
        
        5_HEALING_LOOP --> 4_SANDBOX_VALIDATION : Healing Rerun (Attempt 1)
        5_HEALING_LOOP --> ABORTED : Healing Fails (Unhealable)
        
        6_FINAL_SYNTHESIS --> 7_HUMAN_HANDOFF : Advance (Assemble Output)
    }

    state Manual_Control_Overlays {
        Any_State --> PAUSED : Post /pause
        PAUSED --> 1_INTAKE : Post /retry
        PAUSED --> ABORTED : Post /abort
        Any_NonTerminal_State --> ABORTED : Post /abort
    }

    7_HUMAN_HANDOFF --> [*] : Post /approve (approved = true)
    ABORTED --> [*] : Terminal state reached

    note right of 5_HEALING_LOOP
        Healing is currently single-pass:
        If validation fails a second time,
        the pipeline transitions to ABORTED.
    end note
```

---

## 3. Sequential Event & Pipeline Processing Loop

Every call to `/api/tasks/:id/advance` triggers an atomic, non-overlapping step forward. The diagram below illustrates the exact orchestration sequence between the client, router, workers, memory adapters, and event systems.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client (UI/API)
    participant Server as Express Server
    participant Router as TaskManager
    participant Repo as TaskRepository
    participant Worker as Worker Pipeline
    participant Prov as Provider Adapters
    participant Bus as EventBus
    participant Tel as Telemetry Store

    Client->>Server: POST /api/tasks/:id/advance
    Server->>Router: advance(taskId)
    Router->>Repo: get(taskId)
    Repo-->>Router: return Task Document
    Router->>Worker: advancePipeline(task, dependencies)
    
    alt State is 3_SLM_EXECUTION_FANOUT
        loop For each Subtask
            Worker->>Prov: executeSLM(subtask)
            Prov-->>Worker: return Code Patches / Success
            Worker->>Tel: record({ type: 'model.invocation', ... })
        end
    else State is 4_SANDBOX_VALIDATION
        Worker->>Prov: validateResults(subtasks)
        Prov-->>Worker: return { passed: boolean, errors: string[] }
        Worker->>Tel: record({ type: 'validation.run' })
    end

    Worker->>Bus: publish(topic, payload)
    Worker-->>Router: return Updated Task Document
    Router->>Repo: save(updatedTask)
    Repo-->>Router: return Saved Task
    Router-->>Server: return Task JSON
    Server-->>Client: 200 OK (State updated)
```

---

## 4. Logical Data Schemas & Model Relations

The task document contains nested subtask states and a complete appended array of transition and execution events. Local telemetry aggregates metrics separately.

```mermaid
classDiagram
    class Task {
        +string id
        +string description
        +string state
        +string previousState
        +Subtask[] subtasks
        +Event[] events
        +string output
        +boolean approved
        +ValidationResult validationResult
        +Record metadata
        +number createdAt
        +number updatedAt
    }

    class Subtask {
        +string id
        +string title
        +string status
        +string result
        +string error
        +number createdAt
        +number updatedAt
        +number completedAt
    }

    class Event {
        +string id
        +string topic
        +Record payload
        +number timestamp
    }

    class ValidationResult {
        +boolean passed
        +string[] errors
    }

    class TelemetryEvent {
        +string type
        +number cost
        +number latencyMs
        +string model
        +string detail
    }

    Task "1" *-- "many" Subtask : contains
    Task "1" *-- "many" Event : records
    Task "1" *-- "0..1" ValidationResult : validates
    TelemetryEvent ..> Task : monitors activity of
```

---

## 5. Inner Mechanics of Validation & Healing

The healing subsystem acts as a localized feedback loop to automatically rectify test or compilation failures before final synthesis.

```mermaid
graph TD
    start([Sandbox Validation Node]) --> inspect{Do subtasks have failures?}
    inspect -->|No: All green| pass[State -> 6_FINAL_SYNTHESIS]
    inspect -->|Yes: Failures detected| fail[State -> 5_HEALING_LOOP]
    
    fail --> heal[applyHealing: Flag failed subtasks as 'running' & empty errors]
    heal --> reexec[reexecHealed: Substitute failure triggers and rerun SLM worker]
    reexec --> reval[validateResults: Re-run sandbox validator]
    
    reval --> check{Did the healed rerun pass?}
    check -->|Yes: Clean validation| healedPass[State -> 4_SANDBOX_VALIDATION]
    healedPass --> recordHeal[Publish 'healing.applied' event]
    recordHeal --> finalPlan[Advance -> 6_FINAL_SYNTHESIS]
    
    check -->|No: Secondary failure| healedFail[State -> ABORTED]
    healedFail --> recordAbort[Publish 'healing.failed' event]

    style fail fill:#ffe3e3,stroke:#ff8585,stroke-width:2px;
    style healedPass fill:#e3ffe3,stroke:#85ff85,stroke-width:2px;
    style healedFail fill:#fff1e3,stroke:#ffb885,stroke-width:2px;
```
