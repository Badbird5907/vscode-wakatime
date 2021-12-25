import * as vscode from 'vscode';

import { COMMAND_DASHBOARD, LogLevel } from '../constants';
import { Logger } from './logger';
import { Utils } from '../utils';
import { Memento } from 'vscode';
import highlight, { AutoHighlightResult } from 'highlight.js';

interface FileSelection {
  selection: vscode.Position;
  lastHeartbeatAt: number;
}

interface FileSelectionMap {
  [key: string]: FileSelection;
}

export class WakaTime {
  private agentName: string;
  private extension;
  private statusBar: vscode.StatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  );
  private disposable: vscode.Disposable;
  private lastFile: string;
  private lastHeartbeat: number = 0;
  private dedupe: FileSelectionMap = {};
  private logger: Logger;
  private config: Memento;
  private getCodingActivityTimeout: number;
  private fetchTodayInterval: number = 60000;
  private lastFetchToday: number = 0;
  private showStatusBar: boolean;
  private showCodingActivity: boolean;
  private disabled: boolean = true;

  constructor(logger: Logger, config: Memento) {
    this.logger = logger;
    this.config = config;
  }

  public initialize(): void {
    this.statusBar.command = COMMAND_DASHBOARD;

    if (this.config.get('wakatime.debug') == 'true') {
      this.logger.setLevel(LogLevel.DEBUG);
    }

    let extension = vscode.extensions.getExtension('WakaTime.vscode-wakatime');
    this.extension = (extension != undefined && extension.packageJSON) || { version: '0.0.0' };
    this.logger.debug(`Initializing WakaTime v${this.extension.version}`);
    this.agentName = 'vscode';
    this.statusBar.text = '$(clock) WakaTime Initializing...';
    this.statusBar.show();

    this.setupEventListeners();

    this.disabled = this.config.get('wakatime.disabled') === 'true';
    if (this.disabled) {
      this.setStatusBarVisibility(false);
      this.logger.debug('Extension disabled, will not report coding stats to dashboard.');
      return;
    }

    this.checkApiKey();
    this.initializeDependencies();
  }

  public initializeDependencies(): void {
    this.logger.debug('WakaTime initialized.');
    this.statusBar.text = '$(clock)';
    this.statusBar.tooltip = 'WakaTime: Initialized';

    const showStatusBar = this.config.get('wakatime.status_bar_enabled');
    this.showStatusBar = showStatusBar !== 'false';
    this.setStatusBarVisibility(this.showStatusBar);

    const showCodingActivity = this.config.get('wakatime.status_bar_coding_activity');
    if (showCodingActivity == 'false') {
      this.showCodingActivity = false;
    } else {
      this.showCodingActivity = true;
      this.getCodingActivity();
    }
  }

  public promptForApiKey(): void {
    let defaultVal: string = this.config.get('wakatime.api_key') || '';
    if (Utils.validateKey(defaultVal) != '') defaultVal = '';
    let promptOptions = {
      prompt: 'WakaTime Api Key',
      placeHolder: 'Enter your api key from https://wakatime.com/settings',
      value: defaultVal,
      ignoreFocusOut: true,
      validateInput: Utils.validateKey.bind(this),
    };
    vscode.window.showInputBox(promptOptions).then(val => {
      if (val != undefined) {
        let validation = Utils.validateKey(val);
        if (validation === '') this.config.update('wakatime.api_key', val);
        else vscode.window.setStatusBarMessage(validation);
      } else vscode.window.setStatusBarMessage('WakaTime api key not provided');
    });
  }

  public promptForDebug(): void {
    let defaultVal: string = this.config.get('wakatime.debug') || '';
    if (!defaultVal || defaultVal !== 'true') defaultVal = 'false';
    let items: string[] = ['true', 'false'];
    let promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then(newVal => {
      if (newVal == null) return;
      this.config.update('wakatime.debug', newVal);
      if (newVal === 'true') {
        this.logger.setLevel(LogLevel.DEBUG);
        this.logger.debug('Debug enabled');
      } else {
        this.logger.setLevel(LogLevel.INFO);
      }
    });
  }

  public promptToDisable(): void {
    let currentVal = this.config.get('wakatime.disabled');
    if (!currentVal || currentVal !== 'true') currentVal = 'false';
    let items: string[] = ['disable', 'enable'];
    const helperText = currentVal === 'true' ? 'disabled' : 'enabled';
    let promptOptions = {
      placeHolder: `disable or enable (extension is currently "${helperText}")`,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then(newVal => {
      if (newVal !== 'enable' && newVal !== 'disable') return;
      this.disabled = newVal === 'disable';
      if (this.disabled) {
        this.config.update('wakatime.disabled', 'true');
        this.setStatusBarVisibility(false);
        this.logger.debug('Extension disabled, will not report coding stats to dashboard.');
      } else {
        this.config.update('wakatime.disabled', 'false');
        this.checkApiKey();
        this.initializeDependencies();
        if (this.showStatusBar) this.setStatusBarVisibility(true);
        this.logger.debug('Extension enabled and reporting coding stats to dashboard.');
      }
    });
  }

  public promptStatusBarIcon(): void {
    let defaultVal: string = this.config.get('wakatime.status_bar_enabled') || '';
    if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
    let items: string[] = ['true', 'false'];
    let promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then(newVal => {
      if (newVal !== 'true' && newVal !== 'false') return;
      this.config.update('wakatime.status_bar_enabled', newVal);
      this.showStatusBar = newVal === 'true'; // cache setting to prevent reading from disc too often
      this.setStatusBarVisibility(this.showStatusBar);
    });
  }

  public promptStatusBarCodingActivity(): void {
    let defaultVal: string = this.config.get('wakatime.status_bar_coding_activity') || '';
    if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
    let items: string[] = ['true', 'false'];
    let promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then(newVal => {
      if (newVal !== 'true' && newVal !== 'false') return;
      this.config.update('wakatime.status_bar_coding_activity', newVal);
      if (newVal === 'true') {
        this.logger.debug('Coding activity in status bar has been enabled');
        this.showCodingActivity = true;
        this.getCodingActivity(true);
      } else {
        this.logger.debug('Coding activity in status bar has been disabled');
        this.showCodingActivity = false;
        if (this.statusBar.text.indexOf('Error') == -1) {
          this.statusBar.text = '$(clock)';
        }
      }
    });
  }

  public openDashboardWebsite(): void {
    let url = 'https://wakatime.com/';
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  public dispose() {
    this.statusBar.dispose();
    this.disposable.dispose();
    clearTimeout(this.getCodingActivityTimeout);
  }

  private checkApiKey(): void {
    this.hasApiKey(hasApiKey => {
      if (!hasApiKey) this.promptForApiKey();
    });
  }

  private hasApiKey(callback: (arg0: boolean) => void): void {
    const apiKey: string = this.config.get('wakatime.api_key') || '';
    callback(Utils.validateKey(apiKey) === '');
  }

  private setStatusBarVisibility(isVisible: boolean): void {
    if (isVisible) {
      this.statusBar.show();
      this.logger.debug('Status bar icon enabled.');
    } else {
      this.statusBar.hide();
      this.logger.debug('Status bar icon disabled.');
    }
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    let subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeTextEditorSelection(this.onChange, this, subscriptions);
    vscode.window.onDidChangeActiveTextEditor(this.onChange, this, subscriptions);
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions);

    // create a combined disposable from both event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private onChange(): void {
    this.onEvent(false);
  }

  private onSave(): void {
    this.onEvent(true);
  }

  private onEvent(isWrite: boolean): void {
    if (this.disabled) return;

    let editor = vscode.window.activeTextEditor;
    if (editor) {
      let doc = editor.document;
      if (doc) {
        doc.languageId;
        let file: string = doc.fileName;
        if (file) {
          let time: number = Date.now();
          if (isWrite || this.enoughTimePassed(time) || this.lastFile !== file) {
            const language = this.getLanguage(doc);
            this.sendHeartbeat(
              file,
              time,
              editor.selection.start,
              doc.lineCount,
              language,
              isWrite,
            );
            this.lastFile = file;
            this.lastHeartbeat = time;
          }
        }
      }
    }
  }

  private sendHeartbeat(
    file: string,
    time: number,
    selection: vscode.Position,
    lines: number,
    language: string,
    isWrite: boolean,
  ): void {
    this.hasApiKey(hasApiKey => {
      if (hasApiKey) {
        this._sendHeartbeat(file, time, selection, lines, language, isWrite);
      } else {
        this.promptForApiKey();
      }
    });
  }

  private async _sendHeartbeat(
    file: string,
    time: number,
    selection: vscode.Position,
    lines: number,
    language: string,
    isWrite: boolean,
  ) {
    // prevent sending the same heartbeat (https://github.com/wakatime/vscode-wakatime/issues/163)
    if (isWrite && this.isDuplicateHeartbeat(file, time, selection)) return;

    const payload = {
      type: 'file',
      entity: file,
      time: Date.now() / 1000,
      plugin: this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version,
      lineno: String(selection.line + 1),
      cursorpos: String(selection.character + 1),
      lines: String(lines),
      is_write: isWrite,
    };
    let project = Utils.getProjectName(file);
    if (project) payload['project'] = project;
    if (language) payload['language'] = language;

    this.logger.debug(`Sending heartbeat: ${JSON.stringify(payload)}`);

    const apiKey = this.config.get('wakatime.api_key');
    const url = `https://api.wakatime.com/api/v1/users/current/heartbeats?api_key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version,
        },
        body: JSON.stringify(payload),
      });
      const parsedJSON = await response.json();
      if (response.status == 200 || response.status == 201 || response.status == 202) {
        if (this.showStatusBar) {
          if (!this.showCodingActivity) this.statusBar.text = '$(clock)';
          this.getCodingActivity();
        }
        this.logger.debug(`last heartbeat sent ${Utils.formatDate(new Date())}`);
      } else {
        this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
        if (response && response.status == 401) {
          let error_msg = 'Invalid WakaTime Api Key';
          if (this.showStatusBar) {
            this.statusBar.text = '$(clock) WakaTime Error';
            this.statusBar.tooltip = `WakaTime: ${error_msg}`;
          }
          this.logger.error(error_msg);
        } else {
          let error_msg = `Error sending heartbeat (${response.status}); Check your browser console for more details.`;
          if (this.showStatusBar) {
            this.statusBar.text = '$(clock) WakaTime Error';
            this.statusBar.tooltip = `WakaTime: ${error_msg}`;
          }
          this.logger.error(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
      let error_msg = `Error sending heartbeat; Check your browser console for more details.`;
      if (this.showStatusBar) {
        this.statusBar.text = '$(clock) WakaTime Error';
        this.statusBar.tooltip = `WakaTime: ${error_msg}`;
      }
      this.logger.error(error_msg);
    }
  }

  private getCodingActivity(force: boolean = false) {
    if (!this.showCodingActivity || !this.showStatusBar) return;
    const cutoff = Date.now() - this.fetchTodayInterval;
    if (!force && this.lastFetchToday > cutoff) return;

    this.lastFetchToday = Date.now();
    this.getCodingActivityTimeout = setTimeout(this.getCodingActivity, this.fetchTodayInterval);

    this.hasApiKey(hasApiKey => {
      if (!hasApiKey) return;
      this._getCodingActivity();
    });
  }

  private async _getCodingActivity() {
    this.logger.debug('Fetching coding activity for Today from api.');
    const apiKey = this.config.get('wakatime.api_key');
    const url = `https://api.wakatime.com/api/v1/users/current/statusbar/today?api_key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version,
        },
      });
      const parsedJSON = await response.json();
      if (response.status == 200) {
        this.config.get('wakatime.status_bar_coding_activity');
        if (this.showStatusBar && this.showCodingActivity) {
          let output = parsedJSON.data.grand_total.text;
          if (this.config.get('wakatime.status_bar_hide_categories') != 'true' && parsedJSON.data.categories.length > 1) {
            output = parsedJSON.data.categories.map(x => x.text + ' ' + x.name).join(', ');
          }
          if (output && output.trim()) {
            this.statusBar.text = `$(clock) ${output.trim()}`;
            this.statusBar.tooltip = `WakaTime: Today you’ve spent ${output.trim()}.`;
          } else {
            this.statusBar.text = `$(clock)`;
            this.statusBar.tooltip = `WakaTime: Calculating time spent today in background...`;
          }
        }
      } else {
        this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
        if (response && response.status == 401) {
          let error_msg = 'Invalid WakaTime Api Key';
          if (this.showStatusBar) {
            this.statusBar.text = '$(clock) WakaTime Error';
            this.statusBar.tooltip = `WakaTime: ${error_msg}`;
          }
          this.logger.error(error_msg);
        } else {
          let error_msg = `Error fetching code stats for status bar (${response.status}); Check your browser console for more details.`;
          this.logger.debug(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
    }
  }

  private enoughTimePassed(time: number): boolean {
    return this.lastHeartbeat + 120000 < time;
  }

  private isDuplicateHeartbeat(file: string, time: number, selection: vscode.Position): boolean {
    let duplicate = false;
    let minutes = 30;
    let milliseconds = minutes * 60000;
    if (
      this.dedupe[file] &&
      this.dedupe[file].lastHeartbeatAt + milliseconds < time &&
      this.dedupe[file].selection.line == selection.line &&
      this.dedupe[file].selection.character == selection.character
    ) {
      duplicate = true;
    }
    this.dedupe[file] = {
      selection: selection,
      lastHeartbeatAt: time,
    };
    return duplicate;
  }

  private getLanguage(doc: vscode.TextDocument): string {
    if (doc.languageId) {
      const langName = vscode.languages.getLanguages()[doc.languageId];
      if (langName) return langName;
    }
    const result: AutoHighlightResult = highlight.highlightAuto(doc.getText());
    return result.language || '';
  }
}