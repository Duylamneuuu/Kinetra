import {
  ARENA_SCENE_ID,
  arenaAudioAssets,
  createArenaProject,
} from "@kinetra/reference-game";
import type { InputBinding } from "@kinetra/input";
import {
  SettingsStore,
  type PlayerSettingsData,
} from "@kinetra/save-state";
import type {
  PlayerRuntimeController,
  GameShellMode,
} from "./runtime-controller.js";

export class GameShellController {
  #runtime: PlayerRuntimeController;
  #settingsStore: SettingsStore;
  #currentMode: GameShellMode = "mainMenu";
  #previousMode: GameShellMode = "mainMenu";
  #settings: PlayerSettingsData;

  // DOM Elements
  readonly #viewMainMenu: HTMLElement | null;
  readonly #viewHud: HTMLElement | null;
  readonly #viewPause: HTMLElement | null;
  readonly #viewSettings: HTMLElement | null;
  readonly #viewWin: HTMLElement | null;
  readonly #viewLose: HTMLElement | null;

  readonly #btnNewGame: HTMLButtonElement | null;
  readonly #btnContinue: HTMLButtonElement | null;
  readonly #btnMenuSettings: HTMLButtonElement | null;
  readonly #btnQuit: HTMLButtonElement | null;

  readonly #hudHpVal: HTMLElement | null;
  readonly #hudObjectiveVal: HTMLElement | null;
  readonly #hudStatusVal: HTMLElement | null;
  readonly #btnHudPause: HTMLButtonElement | null;

  readonly #btnPauseResume: HTMLButtonElement | null;
  readonly #btnPauseSettings: HTMLButtonElement | null;
  readonly #btnPauseRestart: HTMLButtonElement | null;
  readonly #btnPauseMainMenu: HTMLButtonElement | null;

  readonly #settingMasterGain: HTMLInputElement | null;
  readonly #settingSfxGain: HTMLInputElement | null;
  readonly #valMasterGain: HTMLElement | null;
  readonly #valSfxGain: HTMLElement | null;
  readonly #settingFullscreen: HTMLInputElement | null;
  readonly #btnSettingsBack: HTMLButtonElement | null;

  readonly #bindingMoveForward: HTMLElement | null;
  readonly #bindingMoveBackward: HTMLElement | null;
  readonly #bindingMoveLeft: HTMLElement | null;
  readonly #bindingMoveRight: HTMLElement | null;
  readonly #bindingPause: HTMLElement | null;

  readonly #btnWinRestart: HTMLButtonElement | null;
  readonly #btnWinMainMenu: HTMLButtonElement | null;
  readonly #btnLoseRestart: HTMLButtonElement | null;
  readonly #btnLoseMainMenu: HTMLButtonElement | null;

  constructor(runtime: PlayerRuntimeController, settingsStore: SettingsStore) {
    this.#runtime = runtime;
    this.#settingsStore = settingsStore;
    this.#settings = {
      schemaVersion: 1,
      audio: { masterGain: 1.0, sfxGain: 1.0 },
      display: { fullscreen: false },
    };

    this.#viewMainMenu = document.querySelector("#view-main-menu");
    this.#viewHud = document.querySelector("#view-hud");
    this.#viewPause = document.querySelector("#view-pause");
    this.#viewSettings = document.querySelector("#view-settings");
    this.#viewWin = document.querySelector("#view-win");
    this.#viewLose = document.querySelector("#view-lose");

    this.#btnNewGame = document.querySelector("#btn-new-game");
    this.#btnContinue = document.querySelector("#btn-continue");
    this.#btnMenuSettings = document.querySelector("#btn-menu-settings");
    this.#btnQuit = document.querySelector("#btn-quit");

    this.#hudHpVal = document.querySelector("#hud-hp-val");
    this.#hudObjectiveVal = document.querySelector("#hud-objective-val");
    this.#hudStatusVal = document.querySelector("#hud-status-val");
    this.#btnHudPause = document.querySelector("#btn-hud-pause");

    this.#btnPauseResume = document.querySelector("#btn-pause-resume");
    this.#btnPauseSettings = document.querySelector("#btn-pause-settings");
    this.#btnPauseRestart = document.querySelector("#btn-pause-restart");
    this.#btnPauseMainMenu = document.querySelector("#btn-pause-main-menu");

    this.#settingMasterGain = document.querySelector("#setting-master-gain");
    this.#settingSfxGain = document.querySelector("#setting-sfx-gain");
    this.#valMasterGain = document.querySelector("#val-master-gain");
    this.#valSfxGain = document.querySelector("#val-sfx-gain");
    this.#settingFullscreen = document.querySelector("#setting-fullscreen");
    this.#btnSettingsBack = document.querySelector("#btn-settings-back");

    this.#bindingMoveForward = document.querySelector("#binding-move-forward");
    this.#bindingMoveBackward = document.querySelector("#binding-move-backward");
    this.#bindingMoveLeft = document.querySelector("#binding-move-left");
    this.#bindingMoveRight = document.querySelector("#binding-move-right");
    this.#bindingPause = document.querySelector("#binding-pause");

    this.#btnWinRestart = document.querySelector("#btn-win-restart");
    this.#btnWinMainMenu = document.querySelector("#btn-win-main-menu");
    this.#btnLoseRestart = document.querySelector("#btn-lose-restart");
    this.#btnLoseMainMenu = document.querySelector("#btn-lose-main-menu");

    this.#attachListeners();
  }

  async init(): Promise<void> {
    this.#settings = await this.#settingsStore.load();
    this.#applySettings();
    await this.refreshContinueAvailable();
    if (this.#currentMode === "mainMenu") {
      this.setMode("mainMenu");
    }
  }

  getMode(): GameShellMode {
    return this.#currentMode;
  }

  setMode(mode: GameShellMode): void {
    this.#currentMode = mode;
    this.#runtime.setShellMode(mode);

    if (this.#viewMainMenu) this.#viewMainMenu.classList.toggle("hidden", mode !== "mainMenu");
    if (this.#viewHud) this.#viewHud.classList.toggle("hidden", mode === "mainMenu" || mode === "settings");
    if (this.#viewPause) this.#viewPause.classList.toggle("hidden", mode !== "paused");
    if (this.#viewSettings) this.#viewSettings.classList.toggle("hidden", mode !== "settings");
    if (this.#viewWin) this.#viewWin.classList.toggle("hidden", mode !== "won");
    if (this.#viewLose) this.#viewLose.classList.toggle("hidden", mode !== "lost");
  }

  async refreshContinueAvailable(): Promise<boolean> {
    const hasSave = await this.#runtime.hasSave("arena-progress");
    if (this.#btnContinue) {
      this.#btnContinue.disabled = !hasSave;
      if (hasSave) {
        this.#btnContinue.classList.remove("disabled");
      } else {
        this.#btnContinue.classList.add("disabled");
      }
    }
    return hasSave;
  }

  async startArenaGame(fromSave = false): Promise<void> {
    await this.#runtime.stop();
    const defaultArenaProject = createArenaProject();
    await this.#runtime.start(defaultArenaProject, ARENA_SCENE_ID, 0, {
      assets: arenaAudioAssets,
    });

    if (fromSave) {
      await this.#runtime.loadSave({ slotId: "arena-progress" });
    }

    this.setMode("playing");
    this.updateFromRuntime();
  }

  openSettings(sourceMode: GameShellMode): void {
    this.#previousMode = sourceMode;
    this.#syncSettingsControls();
    this.setMode("settings");
  }

  closeSettings(): void {
    this.setMode(this.#previousMode);
  }

  async setMasterVolume(gain: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, gain));
    this.#settings.audio.masterGain = clamped;
    this.#runtime.getAudioController().setBusGain("master", clamped);
    if (this.#valMasterGain) {
      this.#valMasterGain.textContent = `${Math.round(clamped * 100)}%`;
    }
    await this.#settingsStore.save(this.#settings);
  }

  async setSfxVolume(gain: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, gain));
    this.#settings.audio.sfxGain = clamped;
    this.#runtime.getAudioController().setBusGain("sfx", clamped);
    if (this.#valSfxGain) {
      this.#valSfxGain.textContent = `${Math.round(clamped * 100)}%`;
    }
    await this.#settingsStore.save(this.#settings);
  }

  async setFullscreen(fullscreen: boolean): Promise<void> {
    this.#settings.display.fullscreen = fullscreen;
    if (window.kinetraPlatform) {
      await window.kinetraPlatform.setFullscreen(fullscreen);
    } else if (typeof document !== "undefined") {
      if (fullscreen && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => {});
      } else if (!fullscreen && document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
    }
    await this.#settingsStore.save(this.#settings);
  }

  async remapAction(actionId: string, bindings: InputBinding[]): Promise<void> {
    this.#runtime.getInputRouter().remap(actionId, bindings);
    if (!this.#settings.input) {
      this.#settings.input = {};
    }
    if (!this.#settings.input.customBindings) {
      this.#settings.input.customBindings = {};
    }
    this.#settings.input.customBindings[actionId] = bindings;
    await this.#settingsStore.save(this.#settings);
    this.#syncBindingsDisplay();
  }

  getSettings(): Readonly<PlayerSettingsData> {
    return this.#settings;
  }

  updateFromRuntime(): void {
    const query = this.#runtime.query();

    // Check pause synchronization
    if (this.#runtime.isPaused() && this.#currentMode === "playing") {
      this.setMode("paused");
    } else if (!this.#runtime.isPaused() && this.#currentMode === "paused") {
      this.setMode("playing");
    }

    const session = query.game ?? (query.gameplay?.session as Record<string, unknown> | undefined);
    if (session) {
      const health = typeof session.playerHealth === "number" ? session.playerHealth : 3;
      const status = typeof session.status === "string" ? session.status : "playing";

      if (this.#hudHpVal) {
        this.#hudHpVal.textContent = `${health} / 3`;
      }
      if (this.#hudStatusVal) {
        this.#hudStatusVal.textContent = status.toUpperCase();
      }

      if (status === "won" && this.#currentMode === "playing") {
        this.setMode("won");
      } else if (status === "lost" && this.#currentMode === "playing") {
        this.setMode("lost");
      }
    }
  }

  #attachListeners(): void {
    this.#btnNewGame?.addEventListener("click", () => {
      void this.startArenaGame(false);
    });

    this.#btnContinue?.addEventListener("click", () => {
      void this.startArenaGame(true);
    });

    this.#btnMenuSettings?.addEventListener("click", () => {
      this.openSettings("mainMenu");
    });

    this.#btnQuit?.addEventListener("click", () => {
      if (window.kinetraPlatform) {
        void window.kinetraPlatform.quit();
      } else {
        window.close();
      }
    });

    this.#btnHudPause?.addEventListener("click", () => {
      this.#runtime.pause();
      this.setMode("paused");
    });

    this.#btnPauseResume?.addEventListener("click", () => {
      this.#runtime.resume();
      this.setMode("playing");
    });

    this.#btnPauseSettings?.addEventListener("click", () => {
      this.openSettings("paused");
    });

    this.#btnPauseRestart?.addEventListener("click", () => {
      void this.startArenaGame(false);
    });

    this.#btnPauseMainMenu?.addEventListener("click", async () => {
      await this.#runtime.stop();
      await this.refreshContinueAvailable();
      this.setMode("mainMenu");
    });

    this.#settingMasterGain?.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      void this.setMasterVolume(parseFloat(target.value));
    });

    this.#settingSfxGain?.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      void this.setSfxVolume(parseFloat(target.value));
    });

    this.#settingFullscreen?.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      void this.setFullscreen(target.checked);
    });

    this.#btnSettingsBack?.addEventListener("click", () => {
      this.closeSettings();
    });

    this.#btnWinRestart?.addEventListener("click", () => {
      void this.startArenaGame(false);
    });

    this.#btnWinMainMenu?.addEventListener("click", async () => {
      await this.#runtime.stop();
      await this.refreshContinueAvailable();
      this.setMode("mainMenu");
    });

    this.#btnLoseRestart?.addEventListener("click", () => {
      void this.startArenaGame(false);
    });

    this.#btnLoseMainMenu?.addEventListener("click", async () => {
      await this.#runtime.stop();
      await this.refreshContinueAvailable();
      this.setMode("mainMenu");
    });
  }

  #applySettings(): void {
    this.#runtime.getAudioController().setBusGain("master", this.#settings.audio.masterGain);
    this.#runtime.getAudioController().setBusGain("sfx", this.#settings.audio.sfxGain);

    if (this.#settings.input?.customBindings) {
      for (const [actionId, bindings] of Object.entries(this.#settings.input.customBindings)) {
        if (Array.isArray(bindings)) {
          this.#runtime.getInputRouter().remap(actionId, bindings as InputBinding[]);
        }
      }
    }

    if (this.#settings.display.fullscreen) {
      void this.setFullscreen(true);
    }

    this.#syncSettingsControls();
  }

  #syncSettingsControls(): void {
    if (this.#settingMasterGain) {
      this.#settingMasterGain.value = String(this.#settings.audio.masterGain);
    }
    if (this.#valMasterGain) {
      this.#valMasterGain.textContent = `${Math.round(this.#settings.audio.masterGain * 100)}%`;
    }
    if (this.#settingSfxGain) {
      this.#settingSfxGain.value = String(this.#settings.audio.sfxGain);
    }
    if (this.#valSfxGain) {
      this.#valSfxGain.textContent = `${Math.round(this.#settings.audio.sfxGain * 100)}%`;
    }
    if (this.#settingFullscreen) {
      this.#settingFullscreen.checked = this.#settings.display.fullscreen;
    }
    this.#syncBindingsDisplay();
  }

  #syncBindingsDisplay(): void {
    const router = this.#runtime.getInputRouter();
    const map = router.exportMap();

    const formatBindings = (actionId: string, fallback: string) => {
      const action = map.actions.find(a => a.id === actionId);
      if (!action || action.bindings.length === 0) return fallback;
      return action.bindings
        .map(b => b.kind === "key" ? b.code : b.kind === "gamepad-button" ? `PadB${b.button}` : `PadAxis${b.axis}`)
        .join(" / ");
    };

    if (this.#bindingMoveForward) this.#bindingMoveForward.textContent = formatBindings("player.moveForward", "KeyW / ArrowUp");
    if (this.#bindingMoveBackward) this.#bindingMoveBackward.textContent = formatBindings("player.moveBackward", "KeyS / ArrowDown");
    if (this.#bindingMoveLeft) this.#bindingMoveLeft.textContent = formatBindings("player.moveLeft", "KeyA / ArrowLeft");
    if (this.#bindingMoveRight) this.#bindingMoveRight.textContent = formatBindings("player.moveRight", "KeyD / ArrowRight");
    if (this.#bindingPause) this.#bindingPause.textContent = formatBindings("game.pause", "Escape");
  }
}
