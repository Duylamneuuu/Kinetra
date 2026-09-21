import type {
  GameScript,
  GameScriptContext,
  PreparedScriptRestore,
} from "@kinetra/core";
import {
  ARENA_SFX_HIT_ASSET_ID,
  ARENA_SFX_WIN_ASSET_ID,
  ARENA_SFX_LOSE_ASSET_ID,
} from "./audio.js";

export class ArenaPlayerController implements GameScript {
  health = 3;
  moveCount = 0;
  lastAction?: string | undefined;

  onCreate(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", {
      phase: "onCreate",
      entityId: context.entityId,
    });
  }

  onStart(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", {
      phase: "onStart",
      entityId: context.entityId,
    });
  }

  onUpdate(context: GameScriptContext, _deltaSeconds: number): void {
    if (this.health <= 0) {
      return; // incapacitated
    }

    let dx = 0;
    let dz = 0;

    const moveRight = context.input?.getAction("player.moveRight") ?? 0;
    const moveLeft = context.input?.getAction("player.moveLeft") ?? 0;
    const moveForward = context.input?.getAction("player.moveForward") ?? 0;
    const moveBackward = context.input?.getAction("player.moveBackward") ?? 0;

    if (moveRight > 0) {
      dx += 1.0;
      this.lastAction = "player.moveRight";
    }
    if (moveLeft > 0) {
      dx -= 1.0;
      this.lastAction = "player.moveLeft";
    }
    if (moveForward > 0) {
      dz -= 1.0;
      this.lastAction = "player.moveForward";
    }
    if (moveBackward > 0) {
      dz += 1.0;
      this.lastAction = "player.moveBackward";
    }

    if (dx !== 0 || dz !== 0) {
      this.moveCount++;
      context.transform?.translate([dx, 0, dz]);
      context.log?.("info", "gameplay.move", {
        entityId: context.entityId,
        moveCount: this.moveCount,
        dx,
        dz,
        position: context.transform?.getPosition(),
      });
    }
  }

  onEvent(event: string, payload?: unknown, context?: GameScriptContext): void {
    if (event === "gameplay.damage") {
      const amount =
        typeof payload === "object" &&
        payload !== null &&
        "amount" in payload &&
        typeof (payload as { amount: unknown }).amount === "number"
          ? (payload as { amount: number }).amount
          : 1;

      const previous = this.health;
      this.health = Math.max(0, Math.min(3, this.health - amount));
      context?.log?.("info", "gameplay.playerDamaged", {
        entityId: context?.entityId,
        previousHealth: previous,
        currentHealth: this.health,
        damage: amount,
      });

      context?.emit?.("gameplay.playerHealthChanged", {
        health: this.health,
      });
    }
  }

  getState(): Record<string, unknown> {
    return {
      health: this.health,
      moveCount: this.moveCount,
      ...(this.lastAction ? { lastAction: this.lastAction } : {}),
    };
  }

  validateRestoreState(
    state: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return { valid: false, error: "State must be a non-null object" };
    }
    if ("health" in state) {
      if (
        typeof state.health !== "number" ||
        !Number.isFinite(state.health) ||
        state.health < 0 ||
        state.health > 3
      ) {
        return { valid: false, error: "health must be a finite number in [0, 3]" };
      }
    }
    if ("moveCount" in state) {
      if (
        typeof state.moveCount !== "number" ||
        !Number.isFinite(state.moveCount) ||
        state.moveCount < 0
      ) {
        return { valid: false, error: "moveCount must be a non-negative finite number" };
      }
    }
    if ("lastAction" in state && state.lastAction !== undefined) {
      if (typeof state.lastAction !== "string") {
        return { valid: false, error: "lastAction must be a string" };
      }
    }
    return { valid: true };
  }

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const validation = this.validateRestoreState(state);
    if (!validation.valid) {
      throw new Error(`Invalid ArenaPlayerController state: ${validation.error}`);
    }

    const priorHealth = this.health;
    const priorMoveCount = this.moveCount;
    const priorLastAction = this.lastAction;

    const nextHealth =
      typeof state.health === "number" ? state.health : this.health;
    const nextMoveCount =
      typeof state.moveCount === "number" ? state.moveCount : this.moveCount;
    const nextLastAction =
      typeof state.lastAction === "string" ? state.lastAction : this.lastAction;

    return {
      commit: () => {
        this.health = nextHealth;
        this.moveCount = nextMoveCount;
        this.lastAction = nextLastAction;
      },
      rollback: () => {
        this.health = priorHealth;
        this.moveCount = priorMoveCount;
        this.lastAction = priorLastAction;
      },
    };
  }

  restoreState(state: Record<string, unknown>): void {
    const prepared = this.prepareRestoreState(state);
    prepared.commit();
  }
}

export class ArenaEnemyController implements GameScript {
  state: "idle" | "chasing" | "attacking" = "chasing";
  damageCooldown = 0;
  targetName = "Player";
  attackRange = 1.6;
  speed = 0.8;

  onCreate(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", {
      phase: "onCreate",
      entityId: context.entityId,
    });
  }

  onStart(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", {
      phase: "onStart",
      entityId: context.entityId,
    });
  }

  onUpdate(context: GameScriptContext, _deltaSeconds: number): void {
    if (this.damageCooldown > 0) {
      this.damageCooldown--;
    }

    if (!context.transform || !context.scene) {
      return;
    }

    const enemyPos = context.transform.getPosition();
    const playerEntity = context.scene.findEntityByName?.(this.targetName);
    if (!playerEntity) {
      this.state = "idle";
      return;
    }

    const playerPos = context.scene.getEntityTransform(playerEntity.entityId);
    if (!playerPos) {
      this.state = "idle";
      return;
    }

    const dist = Math.hypot(playerPos[0] - enemyPos[0], playerPos[2] - enemyPos[2]);

    if (dist <= this.attackRange) {
      this.state = "attacking";
      context.emit?.("enemy.stateChanged", { state: this.state });

      if (this.damageCooldown <= 0) {
        context.emit?.("gameplay.damage", { amount: 1 });
        void context.audio?.play({ assetId: ARENA_SFX_HIT_ASSET_ID, bus: "sfx" });
        this.damageCooldown = 2; // deterministic simulation-step cooldown
        context.log?.("info", "enemy.attack", {
          entityId: context.entityId,
          targetId: playerEntity.entityId,
          dist,
          cooldown: this.damageCooldown,
        });
      }
    } else {
      this.state = "chasing";
      context.emit?.("enemy.stateChanged", { state: this.state });

      if (context.navigation) {
        const path = context.navigation.computePath(enemyPos, playerPos);
        if (path.success && path.points.length > 1) {
          const nextWaypoint = path.points[1]!;
          const dx = nextWaypoint[0] - enemyPos[0];
          const dz = nextWaypoint[2] - enemyPos[2];
          const distToWp = Math.hypot(dx, dz);

          if (distToWp > 0.001) {
            const stepDist = Math.min(this.speed, distToWp);
            const stepX = (dx / distToWp) * stepDist;
            const stepZ = (dz / distToWp) * stepDist;
            context.transform.translate([stepX, 0, stepZ]);
            context.log?.("debug", "enemy.step", {
              entityId: context.entityId,
              nextWaypoint,
              stepDist,
              newPos: context.transform.getPosition(),
            });
          }
        }
      }
    }
  }

  onEvent(event: string, payload?: unknown, context?: GameScriptContext): void {
    if (event === "gameplay.challengeStarted") {
      const multiplier =
        typeof payload === "object" &&
        payload !== null &&
        "multiplier" in payload &&
        typeof (payload as { multiplier: unknown }).multiplier === "number"
          ? (payload as { multiplier: number }).multiplier
          : 1.6;
      this.speed = Math.round(0.8 * multiplier * 100) / 100;
      context?.log?.("info", "enemy.frenzy", {
        entityId: context?.entityId,
        speed: this.speed,
        multiplier,
      });
    }
  }

  getState(): Record<string, unknown> {
    return {
      state: this.state,
      damageCooldown: this.damageCooldown,
      speed: this.speed,
    };
  }

  validateRestoreState(
    state: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return { valid: false, error: "State must be a non-null object" };
    }
    if ("state" in state) {
      if (
        state.state !== "idle" &&
        state.state !== "chasing" &&
        state.state !== "attacking"
      ) {
        return { valid: false, error: 'state must be "idle", "chasing", or "attacking"' };
      }
    }
    if ("damageCooldown" in state) {
      if (
        typeof state.damageCooldown !== "number" ||
        !Number.isFinite(state.damageCooldown) ||
        state.damageCooldown < 0
      ) {
        return { valid: false, error: "damageCooldown must be a non-negative finite number" };
      }
    }
    if ("speed" in state && state.speed !== undefined) {
      if (
        typeof state.speed !== "number" ||
        !Number.isFinite(state.speed) ||
        state.speed <= 0
      ) {
        return { valid: false, error: "speed must be a positive finite number" };
      }
    }
    return { valid: true };
  }

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const validation = this.validateRestoreState(state);
    if (!validation.valid) {
      throw new Error(`Invalid ArenaEnemyController state: ${validation.error}`);
    }

    const priorState = this.state;
    const priorCooldown = this.damageCooldown;
    const priorSpeed = this.speed;

    const nextState =
      state.state === "idle" ||
      state.state === "chasing" ||
      state.state === "attacking"
        ? state.state
        : this.state;
    const nextCooldown =
      typeof state.damageCooldown === "number"
        ? state.damageCooldown
        : this.damageCooldown;
    const nextSpeed =
      typeof state.speed === "number" ? state.speed : this.speed;

    return {
      commit: () => {
        this.state = nextState;
        this.damageCooldown = nextCooldown;
        this.speed = nextSpeed;
      },
      rollback: () => {
        this.state = priorState;
        this.damageCooldown = priorCooldown;
        this.speed = priorSpeed;
      },
    };
  }

  restoreState(state: Record<string, unknown>): void {
    const prepared = this.prepareRestoreState(state);
    prepared.commit();
  }
}

export type ArenaRunStatus = "idle" | "active" | "completed" | "failed";

export interface ArenaObjective {
  id: string;
  description: string;
  completed: boolean;
}

export interface ArenaChallengeState {
  active: boolean;
  status: "idle" | "active" | "completed" | "failed";
  enemySpeedMultiplier: number;
  alertTriggered: boolean;
}

export interface ArenaSessionState {
  status: "playing" | "won" | "lost";
  playerHealth: number;
  enemyState: string;
  goalReached: boolean;
  run: {
    status: ArenaRunStatus;
  };
  objectives: ArenaObjective[];
  challenge: ArenaChallengeState;
}

export class ArenaGameManager implements GameScript {
  status: "playing" | "won" | "lost" = "playing";
  playerHealth = 3;
  enemyState = "chasing";
  goalReached = false;
  runStatus: ArenaRunStatus = "active";
  objectives: ArenaObjective[] = [
    {
      id: "obj_activate_terminal",
      description: "Activate Security Console",
      completed: false,
    },
    {
      id: "obj_retrieve_core",
      description: "Retrieve Power Core",
      completed: false,
    },
    {
      id: "obj_survive_escape",
      description: "Survive Lockdown & Reach Extraction",
      completed: false,
    },
  ];
  challenge: ArenaChallengeState = {
    active: false,
    status: "idle",
    enemySpeedMultiplier: 1.0,
    alertTriggered: false,
  };
  readonly terminalPosition: [number, number, number] = [-5, 0.5, 2];
  readonly terminalRadius = 1.8;
  readonly corePosition: [number, number, number] = [5, 0.5, 2];
  readonly coreRadius = 1.8;
  readonly goalPosition: [number, number, number] = [5, 0.1, -5];
  readonly goalRadius = 1.8;

  onCreate(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", {
      phase: "onCreate",
      entityId: context.entityId,
    });
  }

  onStart(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", {
      phase: "onStart",
      entityId: context.entityId,
    });
  }

  onUpdate(context: GameScriptContext, _deltaSeconds: number): void {
    if (this.status !== "playing") {
      return;
    }

    // Check player interactions with objectives and goal
    const playerEntity = context.scene?.findEntityByName?.("Player");
    if (playerEntity) {
      const playerPos = context.scene?.getEntityTransform(playerEntity.entityId);
      if (playerPos) {
        // 1. Objective 1: Security Console
        const terminalObj = this.objectives.find((o) => o.id === "obj_activate_terminal");
        if (terminalObj && !terminalObj.completed) {
          const distToTerminal = Math.hypot(
            playerPos[0] - this.terminalPosition[0],
            playerPos[2] - this.terminalPosition[2],
          );
          if (distToTerminal <= this.terminalRadius) {
            terminalObj.completed = true;
            context.log?.("info", "objective.completed", {
              id: "obj_activate_terminal",
              distToTerminal,
            });
            context.emit?.("gameplay.objectiveCompleted", { id: "obj_activate_terminal" });
          }
        }

        // 2. Objective 2: Power Core
        const coreObj = this.objectives.find((o) => o.id === "obj_retrieve_core");
        if (coreObj && !coreObj.completed) {
          const distToCore = Math.hypot(
            playerPos[0] - this.corePosition[0],
            playerPos[2] - this.corePosition[2],
          );
          if (distToCore <= this.coreRadius) {
            coreObj.completed = true;
            context.log?.("info", "objective.completed", {
              id: "obj_retrieve_core",
              distToCore,
            });
            context.emit?.("gameplay.objectiveCompleted", { id: "obj_retrieve_core" });

            // Start Lockdown Survival Challenge!
            this.challenge.active = true;
            this.challenge.status = "active";
            this.challenge.enemySpeedMultiplier = 1.6;
            this.challenge.alertTriggered = true;
            context.log?.("info", "challenge.started", {
              challenge: "lockdown",
              multiplier: this.challenge.enemySpeedMultiplier,
            });
            context.emit?.("gameplay.challengeStarted", {
              challenge: "lockdown",
              multiplier: this.challenge.enemySpeedMultiplier,
            });
          }
        }

        // 3. Objective 3 / Goal arrival
        const distToGoal = Math.hypot(
          playerPos[0] - this.goalPosition[0],
          playerPos[2] - this.goalPosition[2],
        );
        if (distToGoal <= this.goalRadius) {
          this.goalReached = true;
          this.status = "won";
          this.runStatus = "completed";

          const escapeObj = this.objectives.find((o) => o.id === "obj_survive_escape");
          if (escapeObj) {
            escapeObj.completed = true;
          }

          if (this.challenge.active) {
            this.challenge.status = "completed";
            this.challenge.active = false;
          }

          void context.audio?.play({ assetId: ARENA_SFX_WIN_ASSET_ID, bus: "sfx" });
          context.log?.("info", "gameplay.win", {
            distToGoal,
            playerPos,
            goalPos: this.goalPosition,
            runStatus: this.runStatus,
          });
          return;
        }
      }
    }

    // Check player health
    if (this.playerHealth <= 0) {
      this.status = "lost";
      this.runStatus = "failed";
      if (this.challenge.active) {
        this.challenge.status = "failed";
        this.challenge.active = false;
      }
      void context.audio?.play({ assetId: ARENA_SFX_LOSE_ASSET_ID, bus: "sfx" });
      context.log?.("info", "gameplay.lose", {
        playerHealth: this.playerHealth,
        runStatus: this.runStatus,
      });
    }
  }

  onEvent(event: string, payload?: unknown, context?: GameScriptContext): void {
    if (event === "gameplay.playerHealthChanged") {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "health" in payload &&
        typeof (payload as { health: unknown }).health === "number"
      ) {
        this.playerHealth = (payload as { health: number }).health;
        if (this.playerHealth <= 0 && this.status === "playing") {
          this.status = "lost";
          this.runStatus = "failed";
          if (this.challenge.active) {
            this.challenge.status = "failed";
            this.challenge.active = false;
          }
          void context?.audio?.play({ assetId: ARENA_SFX_LOSE_ASSET_ID, bus: "sfx" });
          context?.log?.("info", "gameplay.lose", {
            playerHealth: this.playerHealth,
            runStatus: this.runStatus,
          });
        }
      }
    } else if (event === "enemy.stateChanged") {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "state" in payload &&
        typeof (payload as { state: unknown }).state === "string"
      ) {
        this.enemyState = (payload as { state: string }).state;
      }
    }
  }

  getState(): Record<string, unknown> {
    const session: ArenaSessionState = {
      status: this.status,
      playerHealth: this.playerHealth,
      enemyState: this.enemyState,
      goalReached: this.goalReached,
      run: {
        status: this.runStatus,
      },
      objectives: this.objectives.map((obj) => ({ ...obj })),
      challenge: { ...this.challenge },
    };
    return {
      session,
      status: this.status,
      playerHealth: this.playerHealth,
      enemyState: this.enemyState,
      goalReached: this.goalReached,
      run: {
        status: this.runStatus,
      },
      objectives: this.objectives.map((obj) => ({ ...obj })),
      challenge: { ...this.challenge },
    };
  }

  validateRestoreState(
    state: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return { valid: false, error: "State must be a non-null object" };
    }

    const sessionData =
      typeof state.session === "object" && state.session !== null
        ? (state.session as Record<string, unknown>)
        : state;

    if ("status" in sessionData) {
      if (
        sessionData.status !== "playing" &&
        sessionData.status !== "won" &&
        sessionData.status !== "lost"
      ) {
        return { valid: false, error: 'status must be "playing", "won", or "lost"' };
      }
    }
    if ("playerHealth" in sessionData) {
      if (
        typeof sessionData.playerHealth !== "number" ||
        !Number.isFinite(sessionData.playerHealth) ||
        sessionData.playerHealth < 0 ||
        sessionData.playerHealth > 3
      ) {
        return { valid: false, error: "playerHealth must be a finite number in [0, 3]" };
      }
    }
    if ("goalReached" in sessionData) {
      if (typeof sessionData.goalReached !== "boolean") {
        return { valid: false, error: "goalReached must be a boolean" };
      }
    }
    if ("run" in sessionData && sessionData.run !== undefined) {
      if (
        typeof sessionData.run !== "object" ||
        sessionData.run === null ||
        !("status" in (sessionData.run as Record<string, unknown>)) ||
        !["idle", "active", "completed", "failed"].includes(
          String((sessionData.run as Record<string, unknown>).status),
        )
      ) {
        return {
          valid: false,
          error: 'run.status must be "idle", "active", "completed", or "failed"',
        };
      }
    }
    if ("objectives" in sessionData && sessionData.objectives !== undefined) {
      if (!Array.isArray(sessionData.objectives)) {
        return { valid: false, error: "objectives must be an array" };
      }
      for (const obj of sessionData.objectives) {
        if (
          typeof obj !== "object" ||
          obj === null ||
          typeof (obj as Record<string, unknown>).id !== "string" ||
          typeof (obj as Record<string, unknown>).description !== "string" ||
          typeof (obj as Record<string, unknown>).completed !== "boolean"
        ) {
          return {
            valid: false,
            error: "Each objective must have id, description, and completed boolean",
          };
        }
      }
    }
    if ("challenge" in sessionData && sessionData.challenge !== undefined) {
      if (
        typeof sessionData.challenge !== "object" ||
        sessionData.challenge === null
      ) {
        return { valid: false, error: "challenge must be an object" };
      }
      const ch = sessionData.challenge as Record<string, unknown>;
      if (typeof ch.active !== "boolean") {
        return { valid: false, error: "challenge.active must be a boolean" };
      }
      if (!["idle", "active", "completed", "failed"].includes(String(ch.status))) {
        return {
          valid: false,
          error: 'challenge.status must be "idle", "active", "completed", or "failed"',
        };
      }
    }
    return { valid: true };
  }

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const validation = this.validateRestoreState(state);
    if (!validation.valid) {
      throw new Error(`Invalid ArenaGameManager state: ${validation.error}`);
    }

    const sessionData =
      typeof state.session === "object" && state.session !== null
        ? (state.session as Record<string, unknown>)
        : state;

    const priorStatus = this.status;
    const priorHealth = this.playerHealth;
    const priorEnemyState = this.enemyState;
    const priorGoalReached = this.goalReached;
    const priorRunStatus = this.runStatus;
    const priorObjectives = this.objectives.map((o) => ({ ...o }));
    const priorChallenge = { ...this.challenge };

    const nextStatus =
      sessionData.status === "playing" ||
      sessionData.status === "won" ||
      sessionData.status === "lost"
        ? sessionData.status
        : this.status;
    const nextHealth =
      typeof sessionData.playerHealth === "number"
        ? sessionData.playerHealth
        : this.playerHealth;
    const nextEnemyState =
      typeof sessionData.enemyState === "string"
        ? sessionData.enemyState
        : this.enemyState;
    const nextGoalReached =
      typeof sessionData.goalReached === "boolean"
        ? sessionData.goalReached
        : this.goalReached;

    const nextRunStatus =
      typeof sessionData.run === "object" &&
      sessionData.run !== null &&
      "status" in (sessionData.run as Record<string, unknown>)
        ? ((sessionData.run as Record<string, unknown>).status as ArenaRunStatus)
        : this.runStatus;

    const nextObjectives =
      Array.isArray(sessionData.objectives)
        ? (sessionData.objectives as ArenaObjective[]).map((o) => ({
            id: String(o.id),
            description: String(o.description),
            completed: Boolean(o.completed),
          }))
        : this.objectives.map((o) => ({ ...o }));

    const nextChallenge =
      typeof sessionData.challenge === "object" && sessionData.challenge !== null
        ? {
            active: Boolean((sessionData.challenge as Record<string, unknown>).active),
            status: (sessionData.challenge as Record<string, unknown>).status as ArenaChallengeState["status"],
            enemySpeedMultiplier:
              typeof (sessionData.challenge as Record<string, unknown>).enemySpeedMultiplier === "number"
                ? ((sessionData.challenge as Record<string, unknown>).enemySpeedMultiplier as number)
                : this.challenge.enemySpeedMultiplier,
            alertTriggered: Boolean((sessionData.challenge as Record<string, unknown>).alertTriggered),
          }
        : { ...this.challenge };

    return {
      commit: () => {
        this.status = nextStatus;
        this.playerHealth = nextHealth;
        this.enemyState = nextEnemyState;
        this.goalReached = nextGoalReached;
        this.runStatus = nextRunStatus;
        this.objectives = nextObjectives;
        this.challenge = nextChallenge;
      },
      rollback: () => {
        this.status = priorStatus;
        this.playerHealth = priorHealth;
        this.enemyState = priorEnemyState;
        this.goalReached = priorGoalReached;
        this.runStatus = priorRunStatus;
        this.objectives = priorObjectives;
        this.challenge = priorChallenge;
      },
    };
  }

  restoreState(state: Record<string, unknown>): void {
    const prepared = this.prepareRestoreState(state);
    prepared.commit();
  }
}
