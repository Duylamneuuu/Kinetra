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
  attackCooldown = 0;
  readonly attackCooldownDuration = 2;
  readonly attackRange = 2.0;
  lastAction?: string | undefined;
  hurtCooldown = 0;

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

    if (this.hurtCooldown > 0) {
      this.hurtCooldown--;
    }

    if (this.attackCooldown > 0) {
      this.attackCooldown--;
    }

    // Handle attack input
    const attack = context.input?.getAction("player.attack") ?? 0;
    if (attack > 0 && this.attackCooldown <= 0) {
      this.attackCooldown = this.attackCooldownDuration;
      this.lastAction = "player.attack";

      const playerPos = context.transform?.getPosition();
      const enemyEntity = context.scene?.findEntityByName?.("Enemy");
      if (playerPos && enemyEntity) {
        const enemyPos = context.scene?.getEntityTransform(enemyEntity.entityId);
        if (enemyPos) {
          const dist = Math.hypot(playerPos[0] - enemyPos[0], playerPos[2] - enemyPos[2]);
          if (dist <= this.attackRange) {
            void context.audio?.play({ assetId: ARENA_SFX_HIT_ASSET_ID, bus: "sfx" });
            context.emit?.("gameplay.enemyDamage", { amount: 1, attackerId: context.entityId });
            context.log?.("info", "player.attackHit", {
              entityId: context.entityId,
              targetId: enemyEntity.entityId,
              dist,
              damage: 1,
              cooldown: this.attackCooldown,
            });
          } else {
            context.log?.("info", "player.attackMiss", {
              entityId: context.entityId,
              targetId: enemyEntity.entityId,
              dist,
              attackRange: this.attackRange,
            });
          }
        }
      }
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

      this.hurtCooldown = 1;
      const previous = this.health;
      this.health = Math.max(0, Math.min(3, this.health - amount));
      context?.log?.("info", "player.hurt", {
        entityId: context?.entityId,
        damage: amount,
        health: this.health,
      });
      context?.emit?.("player.hurt", {
        entityId: context?.entityId,
        damage: amount,
        health: this.health,
      });
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
      attackCooldown: this.attackCooldown,
      isHurt: this.hurtCooldown > 0,
      hurtCooldown: this.hurtCooldown,
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
    if ("attackCooldown" in state && state.attackCooldown !== undefined) {
      if (
        typeof state.attackCooldown !== "number" ||
        !Number.isFinite(state.attackCooldown) ||
        state.attackCooldown < 0
      ) {
        return { valid: false, error: "attackCooldown must be a non-negative finite number" };
      }
    }
    if ("hurtCooldown" in state && state.hurtCooldown !== undefined) {
      if (
        typeof state.hurtCooldown !== "number" ||
        !Number.isFinite(state.hurtCooldown) ||
        state.hurtCooldown < 0
      ) {
        return { valid: false, error: "hurtCooldown must be a non-negative finite number" };
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
    const priorCooldown = this.attackCooldown;
    const priorLastAction = this.lastAction;
    const priorHurtCooldown = this.hurtCooldown;

    const nextHealth =
      typeof state.health === "number" ? state.health : this.health;
    const nextMoveCount =
      typeof state.moveCount === "number" ? state.moveCount : this.moveCount;
    const nextCooldown =
      typeof state.attackCooldown === "number" ? state.attackCooldown : this.attackCooldown;
    const nextLastAction =
      typeof state.lastAction === "string" ? state.lastAction : this.lastAction;
    const nextHurtCooldown =
      typeof state.hurtCooldown === "number" ? state.hurtCooldown : this.hurtCooldown;

    return {
      commit: () => {
        this.health = nextHealth;
        this.moveCount = nextMoveCount;
        this.attackCooldown = nextCooldown;
        this.lastAction = nextLastAction;
        this.hurtCooldown = nextHurtCooldown;
      },
      rollback: () => {
        this.health = priorHealth;
        this.moveCount = priorMoveCount;
        this.attackCooldown = priorCooldown;
        this.lastAction = priorLastAction;
        this.hurtCooldown = priorHurtCooldown;
      },
    };
  }

  restoreState(state: Record<string, unknown>): void {
    const prepared = this.prepareRestoreState(state);
    prepared.commit();
  }
}

export class ArenaEnemyController implements GameScript {
  health = 3;
  readonly maxHealth = 3;
  state: "idle" | "chasing" | "telegraph" | "attacking" | "cooldown" | "defeated" = "chasing";
  damageCooldown = 0;
  telegraphTimer = 0;
  telegraphDuration = 1;
  hurtCooldown = 0;
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
    if (this.state === "defeated" || this.health <= 0) {
      return; // Defeated enemies stop navigation, attacks, and state transitions
    }

    if (this.hurtCooldown > 0) {
      this.hurtCooldown--;
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

    if (this.state === "telegraph") {
      if (dist <= this.attackRange) {
        // Warning phase complete and player still within range -> attack connects!
        this.state = "attacking";
        context.emit?.("enemy.stateChanged", { state: this.state });
        context.emit?.("gameplay.damage", { amount: 1 });
        void context.audio?.play({ assetId: ARENA_SFX_HIT_ASSET_ID, bus: "sfx" });
        this.damageCooldown = 2; // deterministic simulation-step cooldown
        context.log?.("info", "enemy.attack", {
          entityId: context.entityId,
          targetId: playerEntity.entityId,
          dist,
          cooldown: this.damageCooldown,
        });
        this.state = "cooldown";
        context.emit?.("enemy.stateChanged", { state: this.state });
      } else {
        // Player evaded attack range during telegraph window!
        this.state = "chasing";
        context.emit?.("enemy.stateChanged", { state: this.state });
        context.log?.("info", "enemy.attackEvaded", {
          entityId: context.entityId,
          targetId: playerEntity.entityId,
          dist,
          attackRange: this.attackRange,
        });
      }
      return;
    }

    if (this.state === "cooldown") {
      if (this.damageCooldown > 0) {
        this.damageCooldown--;
      }
      if (this.damageCooldown <= 0) {
        if (dist <= this.attackRange) {
          this.state = "telegraph";
          this.telegraphTimer = this.telegraphDuration;
          context.emit?.("enemy.stateChanged", { state: this.state });
          context.emit?.("enemy.telegraph", {
            entityId: context.entityId,
            targetId: playerEntity.entityId,
            dist,
          });
          context.log?.("info", "enemy.attackTelegraph", {
            entityId: context.entityId,
            targetId: playerEntity.entityId,
            dist,
          });
        } else {
          this.state = "chasing";
          context.emit?.("enemy.stateChanged", { state: this.state });
        }
      }
      return;
    }

    if (dist <= this.attackRange) {
      this.state = "telegraph";
      this.telegraphTimer = this.telegraphDuration;
      context.emit?.("enemy.stateChanged", { state: this.state });
      context.emit?.("enemy.telegraph", {
        entityId: context.entityId,
        targetId: playerEntity.entityId,
        dist,
      });
      context.log?.("info", "enemy.attackTelegraph", {
        entityId: context.entityId,
        targetId: playerEntity.entityId,
        dist,
      });
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
    } else if (event === "gameplay.enemyDamage") {
      if (this.state === "defeated" || this.health <= 0) {
        return;
      }
      const amount =
        typeof payload === "object" &&
        payload !== null &&
        "amount" in payload &&
        typeof (payload as { amount: unknown }).amount === "number"
          ? (payload as { amount: number }).amount
          : 1;

      this.hurtCooldown = 1;
      const previous = this.health;
      this.health = Math.max(0, Math.min(this.maxHealth, this.health - amount));
      context?.log?.("info", "enemy.hurt", {
        entityId: context?.entityId,
        damage: amount,
        health: this.health,
      });
      context?.emit?.("enemy.hurt", {
        entityId: context?.entityId,
        damage: amount,
        health: this.health,
      });
      context?.log?.("info", "gameplay.enemyDamaged", {
        entityId: context?.entityId,
        previousHealth: previous,
        currentHealth: this.health,
        damage: amount,
      });

      context?.emit?.("enemy.healthChanged", {
        health: this.health,
        previousHealth: previous,
      });

      if (this.health <= 0) {
        this.state = "defeated";
        context?.emit?.("enemy.defeated", { entityId: context?.entityId });
        context?.emit?.("enemy.stateChanged", { state: "defeated" });
        context?.log?.("info", "gameplay.enemyDefeated", {
          entityId: context?.entityId,
          health: this.health,
          state: this.state,
        });
      }
    }
  }

  getState(): Record<string, unknown> {
    return {
      health: this.health,
      state: this.state,
      damageCooldown: this.damageCooldown,
      speed: this.speed,
      telegraphTimer: this.telegraphTimer,
      telegraphDuration: this.telegraphDuration,
      isHurt: this.hurtCooldown > 0,
      hurtCooldown: this.hurtCooldown,
    };
  }

  validateRestoreState(
    state: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return { valid: false, error: "State must be a non-null object" };
    }
    if ("health" in state && state.health !== undefined) {
      if (
        typeof state.health !== "number" ||
        !Number.isFinite(state.health) ||
        state.health < 0 ||
        state.health > 3
      ) {
        return { valid: false, error: "health must be a finite number in [0, 3]" };
      }
    }
    if ("state" in state) {
      if (
        state.state !== "idle" &&
        state.state !== "chasing" &&
        state.state !== "telegraph" &&
        state.state !== "attacking" &&
        state.state !== "cooldown" &&
        state.state !== "defeated"
      ) {
        return {
          valid: false,
          error: 'state must be "idle", "chasing", "telegraph", "attacking", "cooldown", or "defeated"',
        };
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
    if ("telegraphTimer" in state && state.telegraphTimer !== undefined) {
      if (
        typeof state.telegraphTimer !== "number" ||
        !Number.isFinite(state.telegraphTimer) ||
        state.telegraphTimer < 0
      ) {
        return { valid: false, error: "telegraphTimer must be a non-negative finite number" };
      }
    }
    if ("hurtCooldown" in state && state.hurtCooldown !== undefined) {
      if (
        typeof state.hurtCooldown !== "number" ||
        !Number.isFinite(state.hurtCooldown) ||
        state.hurtCooldown < 0
      ) {
        return { valid: false, error: "hurtCooldown must be a non-negative finite number" };
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

    const priorHealth = this.health;
    const priorState = this.state;
    const priorCooldown = this.damageCooldown;
    const priorSpeed = this.speed;
    const priorTelegraphTimer = this.telegraphTimer;
    const priorHurtCooldown = this.hurtCooldown;

    const nextHealth =
      typeof state.health === "number" ? state.health : this.health;
    const nextState =
      state.state === "idle" ||
      state.state === "chasing" ||
      state.state === "telegraph" ||
      state.state === "attacking" ||
      state.state === "cooldown" ||
      state.state === "defeated"
        ? state.state
        : this.state;
    const nextCooldown =
      typeof state.damageCooldown === "number"
        ? state.damageCooldown
        : this.damageCooldown;
    const nextSpeed =
      typeof state.speed === "number" ? state.speed : this.speed;
    const nextTelegraphTimer =
      typeof state.telegraphTimer === "number"
        ? state.telegraphTimer
        : this.telegraphTimer;
    const nextHurtCooldown =
      typeof state.hurtCooldown === "number"
        ? state.hurtCooldown
        : this.hurtCooldown;

    return {
      commit: () => {
        this.health = nextHealth;
        this.state = nextState;
        this.damageCooldown = nextCooldown;
        this.speed = nextSpeed;
        this.telegraphTimer = nextTelegraphTimer;
        this.hurtCooldown = nextHurtCooldown;
      },
      rollback: () => {
        this.health = priorHealth;
        this.state = priorState;
        this.damageCooldown = priorCooldown;
        this.speed = priorSpeed;
        this.telegraphTimer = priorTelegraphTimer;
        this.hurtCooldown = priorHurtCooldown;
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

export interface ArenaRunStats {
  elapsedSteps: number;
  elapsedTimeMs: number;
  damageDealt: number;
  damageTaken: number;
  enemiesDefeated: number;
}

export interface ArenaEncounterState {
  status: "active" | "defeated";
  enemyDefeated: boolean;
  extractionUnlocked: boolean;
}

export interface ArenaSessionState {
  status: "playing" | "won" | "lost";
  playerHealth: number;
  enemyHealth: number;
  enemyState: string;
  goalReached: boolean;
  run: {
    status: ArenaRunStatus;
  };
  objectives: ArenaObjective[];
  challenge: ArenaChallengeState;
  encounter: ArenaEncounterState;
  stats: ArenaRunStats;
}

export class ArenaGameManager implements GameScript {
  status: "playing" | "won" | "lost" = "playing";
  playerHealth = 3;
  enemyHealth = 3;
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
  encounter: ArenaEncounterState = {
    status: "active",
    enemyDefeated: false,
    extractionUnlocked: false,
  };
  stats: ArenaRunStats = {
    elapsedSteps: 0,
    elapsedTimeMs: 0,
    damageDealt: 0,
    damageTaken: 0,
    enemiesDefeated: 0,
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

  onUpdate(context: GameScriptContext, deltaSeconds: number): void {
    if (this.status !== "playing") {
      return;
    }

    this.stats.elapsedSteps++;
    this.stats.elapsedTimeMs += Math.round((deltaSeconds || 0.016) * 1000);

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
          context.log?.("info", "gameplay.runSummary", {
            status: this.status,
            runStatus: this.runStatus,
            stats: { ...this.stats },
            encounter: { ...this.encounter },
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
      context.log?.("info", "gameplay.runSummary", {
        status: this.status,
        runStatus: this.runStatus,
        stats: { ...this.stats },
        encounter: { ...this.encounter },
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
          context?.log?.("info", "gameplay.runSummary", {
            status: this.status,
            runStatus: this.runStatus,
            stats: { ...this.stats },
            encounter: { ...this.encounter },
          });
        }
      }
    } else if (event === "gameplay.damage") {
      const amount =
        typeof payload === "object" &&
        payload !== null &&
        "amount" in payload &&
        typeof (payload as { amount: unknown }).amount === "number"
          ? (payload as { amount: number }).amount
          : 1;
      this.stats.damageTaken += amount;
    } else if (event === "gameplay.enemyDamage") {
      const amount =
        typeof payload === "object" &&
        payload !== null &&
        "amount" in payload &&
        typeof (payload as { amount: unknown }).amount === "number"
          ? (payload as { amount: number }).amount
          : 1;
      this.stats.damageDealt += amount;
    } else if (event === "enemy.stateChanged") {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "state" in payload &&
        typeof (payload as { state: unknown }).state === "string"
      ) {
        this.enemyState = (payload as { state: string }).state;
      }
    } else if (event === "enemy.healthChanged") {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "health" in payload &&
        typeof (payload as { health: unknown }).health === "number"
      ) {
        this.enemyHealth = (payload as { health: number }).health;
      }
    } else if (event === "enemy.defeated") {
      this.stats.enemiesDefeated += 1;
      this.encounter.enemyDefeated = true;
      this.encounter.extractionUnlocked = true;
      this.encounter.status = "defeated";
      context?.emit?.("gameplay.extractionUnlocked", {
        unlocked: true,
        enemiesDefeated: this.stats.enemiesDefeated,
      });
      context?.log?.("info", "gameplay.extractionUnlocked", {
        unlocked: true,
        enemiesDefeated: this.stats.enemiesDefeated,
      });
      context?.log?.("info", "gameplay.enemyDefeated", {
        enemyHealth: this.enemyHealth,
        enemyState: this.enemyState,
      });
    }
  }

  getState(): Record<string, unknown> {
    const session: ArenaSessionState = {
      status: this.status,
      playerHealth: this.playerHealth,
      enemyHealth: this.enemyHealth,
      enemyState: this.enemyState,
      goalReached: this.goalReached,
      run: {
        status: this.runStatus,
      },
      objectives: this.objectives.map((obj) => ({ ...obj })),
      challenge: { ...this.challenge },
      encounter: { ...this.encounter },
      stats: { ...this.stats },
    };
    return {
      session,
      status: this.status,
      playerHealth: this.playerHealth,
      enemyHealth: this.enemyHealth,
      enemyState: this.enemyState,
      goalReached: this.goalReached,
      run: {
        status: this.runStatus,
      },
      objectives: this.objectives.map((obj) => ({ ...obj })),
      challenge: { ...this.challenge },
      encounter: { ...this.encounter },
      stats: { ...this.stats },
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
    if ("enemyHealth" in sessionData && sessionData.enemyHealth !== undefined) {
      if (
        typeof sessionData.enemyHealth !== "number" ||
        !Number.isFinite(sessionData.enemyHealth) ||
        sessionData.enemyHealth < 0 ||
        sessionData.enemyHealth > 3
      ) {
        return { valid: false, error: "enemyHealth must be a finite number in [0, 3]" };
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
    if ("encounter" in sessionData && sessionData.encounter !== undefined) {
      if (
        typeof sessionData.encounter !== "object" ||
        sessionData.encounter === null
      ) {
        return { valid: false, error: "encounter must be an object" };
      }
      const enc = sessionData.encounter as Record<string, unknown>;
      if (enc.status !== "active" && enc.status !== "defeated") {
        return { valid: false, error: 'encounter.status must be "active" or "defeated"' };
      }
      if (typeof enc.enemyDefeated !== "boolean") {
        return { valid: false, error: "encounter.enemyDefeated must be a boolean" };
      }
      if (typeof enc.extractionUnlocked !== "boolean") {
        return { valid: false, error: "encounter.extractionUnlocked must be a boolean" };
      }
    }
    if ("stats" in sessionData && sessionData.stats !== undefined) {
      if (
        typeof sessionData.stats !== "object" ||
        sessionData.stats === null
      ) {
        return { valid: false, error: "stats must be an object" };
      }
      const st = sessionData.stats as Record<string, unknown>;
      for (const field of [
        "elapsedSteps",
        "elapsedTimeMs",
        "damageDealt",
        "damageTaken",
        "enemiesDefeated",
      ]) {
        if (
          field in st &&
          st[field] !== undefined &&
          (typeof st[field] !== "number" ||
            !Number.isFinite(st[field]) ||
            (st[field] as number) < 0)
        ) {
          return { valid: false, error: `stats.${field} must be a non-negative finite number` };
        }
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
    const priorEnemyHealth = this.enemyHealth;
    const priorEnemyState = this.enemyState;
    const priorGoalReached = this.goalReached;
    const priorRunStatus = this.runStatus;
    const priorObjectives = this.objectives.map((o) => ({ ...o }));
    const priorChallenge = { ...this.challenge };
    const priorEncounter = { ...this.encounter };
    const priorStats = { ...this.stats };

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
    const nextEnemyHealth =
      typeof sessionData.enemyHealth === "number"
        ? sessionData.enemyHealth
        : this.enemyHealth;
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

    const nextEncounter =
      typeof sessionData.encounter === "object" && sessionData.encounter !== null
        ? {
            status:
              (sessionData.encounter as Record<string, unknown>).status === "defeated"
                ? ("defeated" as const)
                : ("active" as const),
            enemyDefeated: Boolean((sessionData.encounter as Record<string, unknown>).enemyDefeated),
            extractionUnlocked: Boolean((sessionData.encounter as Record<string, unknown>).extractionUnlocked),
          }
        : { ...this.encounter };

    const nextStats =
      typeof sessionData.stats === "object" && sessionData.stats !== null
        ? {
            elapsedSteps:
              typeof (sessionData.stats as Record<string, unknown>).elapsedSteps === "number"
                ? ((sessionData.stats as Record<string, unknown>).elapsedSteps as number)
                : this.stats.elapsedSteps,
            elapsedTimeMs:
              typeof (sessionData.stats as Record<string, unknown>).elapsedTimeMs === "number"
                ? ((sessionData.stats as Record<string, unknown>).elapsedTimeMs as number)
                : this.stats.elapsedTimeMs,
            damageDealt:
              typeof (sessionData.stats as Record<string, unknown>).damageDealt === "number"
                ? ((sessionData.stats as Record<string, unknown>).damageDealt as number)
                : this.stats.damageDealt,
            damageTaken:
              typeof (sessionData.stats as Record<string, unknown>).damageTaken === "number"
                ? ((sessionData.stats as Record<string, unknown>).damageTaken as number)
                : this.stats.damageTaken,
            enemiesDefeated:
              typeof (sessionData.stats as Record<string, unknown>).enemiesDefeated === "number"
                ? ((sessionData.stats as Record<string, unknown>).enemiesDefeated as number)
                : this.stats.enemiesDefeated,
          }
        : { ...this.stats };

    return {
      commit: () => {
        this.status = nextStatus;
        this.playerHealth = nextHealth;
        this.enemyHealth = nextEnemyHealth;
        this.enemyState = nextEnemyState;
        this.goalReached = nextGoalReached;
        this.runStatus = nextRunStatus;
        this.objectives = nextObjectives;
        this.challenge = nextChallenge;
        this.encounter = nextEncounter;
        this.stats = nextStats;
      },
      rollback: () => {
        this.status = priorStatus;
        this.playerHealth = priorHealth;
        this.enemyHealth = priorEnemyHealth;
        this.enemyState = priorEnemyState;
        this.goalReached = priorGoalReached;
        this.runStatus = priorRunStatus;
        this.objectives = priorObjectives;
        this.challenge = priorChallenge;
        this.encounter = priorEncounter;
        this.stats = priorStats;
      },
    };
  }

  restoreState(state: Record<string, unknown>): void {
    const prepared = this.prepareRestoreState(state);
    prepared.commit();
  }
}
