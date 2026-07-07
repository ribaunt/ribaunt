/**
 * Ribaunt CAPTCHA Widget - Web Component
 * 
 * Usage:
 * ```html
 * <ribaunt-widget
 *   challenge-endpoint="/api/challenge"
 *   verify-endpoint="/api/verify"
 *   auto-verify="true"
 *   show-warning="true"
 *   warning-message="Custom warning message"
 * ></ribaunt-widget>
 * ```
 * 
 * Or in React/Vue/Svelte:
 * ```jsx
 * <ribaunt-widget
 *   challengeEndpoint="/api/challenge"
 *   verifyEndpoint="/api/verify"
 * />
 * ```
 * 
 * Events:
 * - verify: Fired when verification is complete
 * - error: Fired when an error occurs
 * - state-change: Fired when widget state changes
 */

import { calibrateBrowser, type ChallengeSolution } from './solver.js';
import {
  solveChallengeWithWorker,
  WorkerUnavailableError,
  type WorkerMode,
} from './worker-client.js';

const WIDGET_STYLES = `
  /* Widget Container Styles */
  :host,
  :host * {
    box-sizing: border-box;
  }

  .captcha {
    background-color: var(--ribaunt-background, #fdfdfd);
    border: 1px solid var(--ribaunt-border-color, #dddddd8f);
    border-radius: var(--ribaunt-border-radius, 14px);
    user-select: none;
    height: var(--ribaunt-widget-height, 58px);
    width: var(--ribaunt-widget-width, 230px);
    display: flex;
    align-items: center;
    padding: var(--ribaunt-widget-padding, 14px);
    gap: var(--ribaunt-gap, 15px);
    cursor: pointer;
    transition: filter .2s, transform .2s;
    position: relative;
    -webkit-tap-highlight-color: rgba(255, 255, 255, 0);
    overflow: hidden;
    color: var(--ribaunt-color, #212121);
  }

  :host([disabled]) .captcha {
    cursor: not-allowed;
    opacity: 0.72;
  }

  :host([disabled]) .captcha:hover {
    filter: none;
  }

  :host([disabled]) .captcha[data-state=fetching],
  :host([disabled]) .captcha[data-state=solving],
  :host([disabled]) .captcha[data-state=verifying] {
    cursor: progress;
  }

  :host([disabled]) .captcha[data-state=done] {
    cursor: default;
  }

  .captcha:hover {
    filter: brightness(98%);
  }

  .captcha:focus-visible {
    outline: 3px solid var(--ribaunt-focus-color, #1677ff);
    outline-offset: 3px;
  }

  /* Checkbox Styles */
  .checkbox {
    width: var(--ribaunt-checkbox-size, 25px);
    height: var(--ribaunt-checkbox-size, 25px);
    border: var(--ribaunt-checkbox-border, 1px solid #aaaaaad1);
    border-radius: var(--ribaunt-checkbox-border-radius, 6px);
    background-color: var(--ribaunt-checkbox-background, #fafafa91);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    margin-top: var(--ribaunt-checkbox-margin, 2px);
    margin-bottom: var(--ribaunt-checkbox-margin, 2px);
    flex-shrink: 0;
  }

  /* Font Family */
  .captcha * {
    font-family: var(--ribaunt-font, system, -apple-system, "BlinkMacSystemFont", ".SFNSText-Regular", "San Francisco", "Roboto", "Segoe UI", "Helvetica Neue", "Lucida Grande", "Ubuntu", "arial", sans-serif);
  }

  /* Keyframes */
  @keyframes ribaunt-spin {
    from { transform: scale(1.1) rotate(0deg); }
    to { transform: scale(1.1) rotate(360deg); }
  }

  @keyframes ribaunt-pop {
    0% { transform: scale(1); }
    60% { transform: scale(1.12); }
    100% { transform: scale(1); }
  }

  /* Label Text */
  .captcha p {
    margin: 0;
    font-weight: 500;
    font-size: 15px;
    user-select: none;
    transition: opacity .2s;
  }

  /* Verifying State */
  .captcha[data-state=fetching] .checkbox,
  .captcha[data-state=solving] .checkbox,
  .captcha[data-state=verifying] .checkbox {
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: conic-gradient(
      var(--ribaunt-spinner-color, #000) 0%, 
      var(--ribaunt-spinner-color, #000) var(--progress, 0%), 
      var(--ribaunt-spinner-background-color, #eee) var(--progress, 0%), 
      var(--ribaunt-spinner-background-color, #eee) 100%
    );
    position: relative;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .captcha[data-state=fetching] .checkbox::after,
  .captcha[data-state=solving] .checkbox::after,
  .captcha[data-state=verifying] .checkbox::after {
    content: "";
    background-color: var(--ribaunt-background, #fdfdfd);
    width: calc(100% - var(--ribaunt-spinner-thickness, 5px));
    height: calc(100% - var(--ribaunt-spinner-thickness, 5px));
    border-radius: 50%;
    margin: calc(var(--ribaunt-spinner-thickness, 5px) / 2);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Done/Success State */
  .captcha[data-state=done] .checkbox {
    border: 1px solid transparent;
    background-image: var(--ribaunt-checkmark, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cstyle%3E%40keyframes%20anim%7B0%25%7Bstroke-dashoffset%3A23.21320343017578px%7Dto%7Bstroke-dashoffset%3A0%7D%7D%3C%2Fstyle%3E%3Cpath%20fill%3D%22none%22%20stroke%3D%22%2300a67d%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%222%22%20d%3D%22m5%2012%205%205L20%207%22%20style%3D%22stroke-dashoffset%3A0%3Bstroke-dasharray%3A23.21320343017578px%3Banimation%3Aanim%20.5s%20ease%22%2F%3E%3C%2Fsvg%3E"));
    background-size: cover;
    animation: ribaunt-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
    box-shadow: 0 0 0 3px rgba(0, 166, 125, 0.25);
    transition: box-shadow 0.5s ease-out;
  }

  /* Error State */
  .captcha[data-state=error] .checkbox {
    border: 1px solid transparent;
    background-image: var(--ribaunt-error-cross, url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 24 24'%3E%3Cpath fill='%23f55b50' d='M11 15h2v2h-2zm0-8h2v6h-2zm1-5C6.47 2 2 6.5 2 12a10 10 0 0 0 10 10a10 10 0 0 0 10-10A10 10 0 0 0 12 2m0 18a8 8 0 0 1-8-8a8 8 0 0 1 8-8a8 8 0 0 1 8 8a8 8 0 0 1-8 8'/%3E%3C/svg%3E"));
    background-size: cover;
  }

  /* Logo */
  .logo {
    position: absolute;
    bottom: 8px;
    right: 8px;
    width: 20px;
    height: auto;
    opacity: 0.6;
    transition: opacity 0.2s, color 0.2s;
    color: var(--ribaunt-logo-color, #666);
    pointer-events: auto;
  }

  .logo svg {
    width: 100%;
    height: auto;
    display: block;
  }

  /* Logo color adapts to theme */
  @media (prefers-color-scheme: dark) {
    .captcha {
      background-color: var(--ribaunt-background, #171717);
      border-color: var(--ribaunt-border-color, #454545);
      color: var(--ribaunt-color, #f4f4f4);
    }

    .checkbox {
      background-color: var(--ribaunt-checkbox-background, #242424);
    }

    .logo {
      color: var(--ribaunt-logo-color, #999);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .captcha,
    .checkbox,
    .warning,
    .logo {
      transition: none !important;
      animation: none !important;
    }
  }

  /* Warning Message */
  .warning {
    width: var(--ribaunt-widget-width, 230px);
    background: rgb(237, 56, 46);
    color: white;
    padding: 4px 6px;
    padding-bottom: calc(var(--ribaunt-border-radius, 14px) + 5px);
    font-size: 10px;
    box-sizing: border-box;
    font-family: system-ui;
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    text-align: center;
    user-select: none;
    margin-bottom: -35.5px;
    opacity: 0;
    transition: margin-bottom .3s, opacity .3s;
  }

  .warning.visible {
    margin-bottom: calc(-1 * var(--ribaunt-border-radius, 14px));
    opacity: 1;
  }
`;

const RIBAUNT_LOGO = `
  <svg width="500" height="384" viewBox="0 0 500 384" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M368.357 122.188H236.618L187.59 0H450.972L500 122.188L434.14 286.295H302.478L368.357 122.188Z" fill="currentColor"/>
    <path fill-rule="evenodd" clip-rule="evenodd" d="M236.619 122.188L341.575 383.702H209.913L170.796 286.199L131.663 383.702H0L104.957 122.188H236.619Z" fill="currentColor"/>
  </svg>
`;

export type WidgetState = 'initial' | 'fetching' | 'solving' | 'verifying' | 'done' | 'error';
export type WidgetErrorCode =
  | 'aborted'
  | 'challenge-fetch-failed'
  | 'invalid-challenge'
  | 'solve-failed'
  | 'timeout'
  | 'verification-failed'
  | 'worker-unavailable'
  | 'unknown';

export interface WidgetStateDetail {
  state: WidgetState;
  phase: WidgetState;
  progress: number;
}

export interface WidgetVerifyDetail {
  solutions: ChallengeSolution[];
  phase: 'done';
  progress: 100;
}

export interface WidgetErrorDetail {
  error: string;
  code: WidgetErrorCode;
  timeout: boolean;
  phase: 'error';
}

function parseTokenArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Challenge response must be an array of token strings');
  }

  if (value.length === 0) {
    throw new Error('No challenge tokens available');
  }

  if (!value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw new Error('Challenge response contains invalid token values');
  }

  return value;
}

function parseChallengeTokens(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return parseTokenArray(payload);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Challenge response must be an object or array of token strings');
  }

  const record = payload as Record<string, unknown>;

  if ('challenges' in record) {
    return parseTokenArray(record.challenges);
  }

  if ('tokens' in record) {
    return parseTokenArray(record.tokens);
  }

  throw new Error('Challenge response must include "challenges" or "tokens"');
}

export class RibauntWidget extends HTMLElement {
  private shadow: ShadowRoot;
  private state: WidgetState = 'initial';
  private progress: number = 0;
  private timeoutError = false;
  private captchaElement: HTMLDivElement | null = null;
  private checkboxElement: HTMLDivElement | null = null;
  private messageElement: HTMLParagraphElement | null = null;
  private warningElement: HTMLDivElement | null = null;
  private logoElement: HTMLAnchorElement | null = null;
  private autoVerifyStarted = false;
  private attemptController: AbortController | null = null;

  static get observedAttributes() {
    return [
      'challenge-endpoint',
      'verify-endpoint',
      'auto-verify',
      'show-warning',
      'warning-message',
      'solve-timeout',
      'worker-mode',
      'challenge-method',
      'calibrate',
      'disabled',
    ];
  }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.handleClick = this.handleClick.bind(this);
    this.handleKeyPress = this.handleKeyPress.bind(this);
    this.handleLogoClick = this.handleLogoClick.bind(this);
  }

  connectedCallback() {
    this.render();
    this.dispatchStateChange();
    this.maybeAutoVerify();
  }

  disconnectedCallback() {
    this.cancelAttempt();
    this.removeEventListeners();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) {
      this.render();
      if (name === 'auto-verify') {
        this.maybeAutoVerify();
      }
    }
  }

  private render() {
    this.removeEventListeners();

    const showWarning = this.hasAttribute('show-warning') && this.getAttribute('show-warning') !== 'false';
    const warningMessage = this.getAttribute('warning-message') || 'Enable WASM for significantly faster solving';
    const disabled = this.isDisabled();

    this.shadow.innerHTML = `
      <style>${WIDGET_STYLES}</style>
      <div>
        ${showWarning ? '<div class="warning"></div>' : ''}
        <div class="captcha" data-state="${this.state}" role="button" tabindex="${disabled ? '-1' : '0'}" aria-disabled="${disabled}" aria-label="${this.getMessage()}" aria-busy="${this.isBusy()}">
          <div class="checkbox"></div>
          <p role="status" aria-live="polite">${this.getMessage()}</p>
          <a class="logo" href="https://ribaunt.com" target="_blank" rel="noopener noreferrer" aria-label="Powered by Ribaunt">
            ${RIBAUNT_LOGO}
          </a>
        </div>
      </div>
    `;

    this.captchaElement = this.shadow.querySelector('.captcha');
    this.checkboxElement = this.shadow.querySelector('.checkbox');
    this.messageElement = this.shadow.querySelector('p');
    this.warningElement = this.shadow.querySelector('.warning');
    this.logoElement = this.shadow.querySelector('.logo');

    if (showWarning && this.warningElement) {
      this.warningElement.textContent = warningMessage;
      setTimeout(() => {
        this.warningElement?.classList.add('visible');
      }, 0);
    }

    // Update progress CSS variable if verifying
    if (this.isBusy() && this.captchaElement) {
      this.captchaElement.style.setProperty('--progress', `${this.progress}%`);
    }

    this.attachEventListeners();
  }

  private attachEventListeners() {
    if (this.captchaElement) {
      this.captchaElement.addEventListener('click', this.handleClick);
      this.captchaElement.addEventListener('keypress', this.handleKeyPress);
    }
    if (this.logoElement) {
      this.logoElement.addEventListener('click', this.handleLogoClick);
    }
  }

  private removeEventListeners() {
    if (this.captchaElement) {
      this.captchaElement.removeEventListener('click', this.handleClick);
      this.captchaElement.removeEventListener('keypress', this.handleKeyPress);
    }
    if (this.logoElement) {
      this.logoElement.removeEventListener('click', this.handleLogoClick);
    }
  }

  private handleLogoClick(event: MouseEvent) {
    event.stopPropagation();
  }

  private handleClick() {
    if (this.isDisabled()) return;
    if (this.state !== 'initial' && this.state !== 'error') return;
    this.verify();
  }

  private handleKeyPress(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.handleClick();
    }
  }

  private getMessage(): string {
    switch (this.state) {
      case 'initial':
        return "I'm a human";
      case 'fetching':
        return 'Preparing challenge...';
      case 'solving':
        return `Solving... ${this.progress}%`;
      case 'verifying':
        return 'Verifying...';
      case 'done':
        return "You're a human";
      case 'error':
        return this.timeoutError ? 'Timed out. Try again.' : 'Error. Try again.';
    }
  }

  private isBusy(): boolean {
    return this.state === 'fetching' || this.state === 'solving' || this.state === 'verifying';
  }

  private getWorkerMode(): WorkerMode {
    const value = this.getAttribute('worker-mode');
    return value === 'required' || value === 'disabled' ? value : 'preferred';
  }

  private shouldCalibrate(): boolean {
    return this.hasAttribute('calibrate') && this.getAttribute('calibrate') !== 'false';
  }

  private getChallengeMethod(): 'GET' | 'POST' {
    return this.getAttribute('challenge-method')?.toUpperCase() === 'POST' ? 'POST' : 'GET';
  }

  private getSolveTimeoutMs(): number | undefined {
    const raw = this.getAttribute('solve-timeout');
    if (!raw) {
      return undefined;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    return Math.floor(value);
  }

  private isDisabled(): boolean {
    return this.hasAttribute('disabled') && this.getAttribute('disabled') !== 'false';
  }

  private shouldAutoVerify(): boolean {
    return this.hasAttribute('auto-verify') && this.getAttribute('auto-verify') !== 'false';
  }

  private maybeAutoVerify() {
    if (!this.isConnected || this.autoVerifyStarted || !this.shouldAutoVerify()) {
      return;
    }

    this.autoVerifyStarted = true;
    queueMicrotask(() => {
      this.startVerification();
    });
  }

  private setState(newState: WidgetState) {
    if (newState !== 'error') {
      this.timeoutError = false;
    }

    this.state = newState;
    if (this.captchaElement) {
      this.captchaElement.setAttribute('data-state', this.state);
      this.captchaElement.setAttribute('aria-label', this.getMessage());
      this.captchaElement.tabIndex = this.isDisabled() ? -1 : 0;
      this.captchaElement.setAttribute('aria-disabled', String(this.isDisabled()));
      this.captchaElement.setAttribute('aria-busy', String(this.isBusy()));
    }
    if (this.messageElement) {
      this.messageElement.textContent = this.getMessage();
    }

    this.dispatchStateChange();
  }

  private dispatchStateChange() {
    // Dispatch state change event
    this.dispatchEvent(
      new CustomEvent('state-change', {
        detail: {
          state: this.state,
          phase: this.state,
          progress: this.progress,
        } satisfies WidgetStateDetail,
        bubbles: true,
        composed: true,
      })
    );
  }

  private setProgress(value: number) {
    // Smooth the progress value for better animation
    const smoothedProgress = Math.round(value * 10) / 10;
    this.progress = smoothedProgress;
    if (this.messageElement) {
      this.messageElement.textContent = this.getMessage();
    }
    if (this.captchaElement) {
      this.captchaElement.style.setProperty('--progress', `${smoothedProgress}%`);
    }
  }

  private cancelAttempt() {
    this.attemptController?.abort();
    this.attemptController = null;
  }

  private getErrorCode(error: unknown): WidgetErrorCode {
    if (error instanceof WorkerUnavailableError) return 'worker-unavailable';
    if (error instanceof DOMException && error.name === 'AbortError') {
      return this.timeoutError ? 'timeout' : 'aborted';
    }
    if (!(error instanceof Error)) return 'unknown';
    if (error.message === 'Failed to fetch challenge') return 'challenge-fetch-failed';
    if (error.message === 'Verification failed') return 'verification-failed';
    if (error.message.startsWith('Challenge response') || error.message === 'No challenge tokens available') {
      return 'invalid-challenge';
    }
    if (error.message.includes('solve') || error.message.includes('challenge')) return 'solve-failed';
    return 'unknown';
  }

  private async verify() {
    this.cancelAttempt();
    const controller = new AbortController();
    this.attemptController = controller;
    this.setProgress(0);

    const timeoutMs = this.getSolveTimeoutMs();
    const timeoutHandle = timeoutMs
      ? setTimeout(() => {
          this.timeoutError = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

    try {
      const challengeEndpoint = this.getAttribute('challenge-endpoint');
      const verifyEndpoint = this.getAttribute('verify-endpoint');

      this.setState('fetching');
      let tokens: string[] = [];
      if (challengeEndpoint) {
        const method = this.getChallengeMethod();
        let calibration;
        if (method === 'POST' && this.shouldCalibrate()) {
          calibration = await calibrateBrowser();
        }
        const request = method === 'POST'
          ? {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(calibration ? { calibration } : {}),
              signal: controller.signal,
            }
          : { signal: controller.signal };
        const response = await fetch(challengeEndpoint, request);
        if (!response.ok) throw new Error('Failed to fetch challenge');
        const data = await response.json() as unknown;
        tokens = parseChallengeTokens(data);
      }

      if (tokens.length === 0) {
        throw new Error('No challenge tokens available');
      }

      this.setState('solving');
      const solutions = await solveChallengeWithWorker(tokens, (progress) => {
        this.setProgress(progress);
      }, controller.signal, this.getWorkerMode());

      this.setState('verifying');
      if (verifyEndpoint) {
        const response = await fetch(verifyEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokens, solutions }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error('Verification failed');
        }
      }

      this.setState('done');
      
      this.dispatchEvent(
        new CustomEvent('verify', {
          detail: {
            solutions,
            phase: 'done',
            progress: 100,
          } satisfies WidgetVerifyDetail,
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      if (controller.signal.aborted && this.attemptController !== controller) return;
      if (!this.timeoutError) {
        this.timeoutError = error instanceof DOMException
          && error.name === 'AbortError'
          && timeoutMs !== undefined;
      }
      const code = this.getErrorCode(error);
      this.setState('error');
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: {
            error: this.timeoutError
              ? 'Timed out. Try again.'
              : (error instanceof Error ? error.message : String(error)),
            code,
            timeout: this.timeoutError,
            phase: 'error',
          } satisfies WidgetErrorDetail,
          bubbles: true,
          composed: true,
        })
      );
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (this.attemptController === controller) {
        this.attemptController = null;
      }
    }
  }

  /**
   * Public API: Reset the widget to initial state
   */
  reset() {
    this.cancelAttempt();
    this.timeoutError = false;
    this.setState('initial');
    this.setProgress(0);
  }

  /**
   * Public API: Get current state
   */
  getState(): WidgetState {
    return this.state;
  }

  /**
   * Public API: Programmatically trigger verification
   */
  startVerification() {
    if (!this.isDisabled() && (this.state === 'initial' || this.state === 'error')) {
      this.verify();
    }
  }
}

export interface RibauntWidgetElement extends HTMLElement {
  reset(): void;
  getState(): WidgetState;
  startVerification(): void;
}

// Register the custom element
/* v8 ignore next -- environment guard for SSR/repeated imports */
if (typeof window !== 'undefined' && typeof customElements !== 'undefined' && !customElements.get('ribaunt-widget')) {
  customElements.define('ribaunt-widget', RibauntWidget);
}

// Export for use in TypeScript
export default RibauntWidget;

// Types declaration for DOM and JSX
declare global {
  interface HTMLElementTagNameMap {
    'ribaunt-widget': RibauntWidgetElement;
  }

  namespace JSX {
    interface IntrinsicElements {
      'ribaunt-widget': import('react').DetailedHTMLProps<import('react').HTMLAttributes<RibauntWidgetElement>, RibauntWidgetElement> & {
        'challenge-endpoint'?: string;
        'verify-endpoint'?: string;
        'auto-verify'?: string | boolean;
        'show-warning'?: string | boolean;
        'warning-message'?: string;
        'solve-timeout'?: string;
        'worker-mode'?: WorkerMode;
        'challenge-method'?: 'GET' | 'POST';
        calibrate?: string | boolean;
        disabled?: string | boolean;
      };
    }
  }
}
