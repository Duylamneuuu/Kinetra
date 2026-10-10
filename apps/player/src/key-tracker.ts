/**
 * Tracks which physical keys are held. Owns its window listeners so they can
 * be removed (dispose), and forgets every held key when the window loses focus
 * (a keyup delivered to another window would otherwise leave the key "held").
 */

export interface KeyEventTargetLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export class KeyTracker {
  readonly keys = new Set<string>();
  readonly #target: KeyEventTargetLike;
  readonly #onKeyDown = (event: { code: string }): void => {
    this.keys.add(event.code);
  };
  readonly #onKeyUp = (event: { code: string }): void => {
    this.keys.delete(event.code);
  };
  readonly #onBlur = (): void => {
    this.keys.clear();
  };
  #attached = true;

  constructor(target: KeyEventTargetLike) {
    this.#target = target;
    target.addEventListener("keydown", this.#onKeyDown);
    target.addEventListener("keyup", this.#onKeyUp);
    target.addEventListener("blur", this.#onBlur);
  }

  dispose(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#target.removeEventListener("keydown", this.#onKeyDown);
    this.#target.removeEventListener("keyup", this.#onKeyUp);
    this.#target.removeEventListener("blur", this.#onBlur);
    this.keys.clear();
  }
}
