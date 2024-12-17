// import * as azdata from 'azdata';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { COMMAND_DASHBOARD, LogLevel } from './constants';
import { Options, Setting } from './options';

import { Dependencies } from './dependencies';
import { Desktop } from './desktop';
import { Logger } from './logger';
import { Utils } from './utils';

interface FileSelection {
  selection: vscode.Position;
  lastHeartbeatAt: number;
}

interface FileSelectionMap {
  [key: string]: FileSelection;
}

export class WakaTime {
  private agentName: string;
  private extension: any;
  private statusBar?: vscode.StatusBarItem = undefined;
  private statusBarTeamYou?: vscode.StatusBarItem = undefined;
  private statusBarTeamOther?: vscode.StatusBarItem = undefined;
  private disposable: vscode.Disposable;
  private lastFile: string;
  private lastHeartbeat: number = 0;
  private lastDebug: boolean = false;
  private lastCompile: boolean = false;
  private dedupe: FileSelectionMap = {};
  private debounceTimeoutId: any = null;
  private debounceMs = 50;
  private dependencies: Dependencies;
  private options: Options;
  private logger: Logger;
  private fetchTodayInterval: number = 60000;
  private lastFetchToday: number = 0;
  private showStatusBar: boolean;
  private showCodingActivity: boolean;
  private showStatusBarTeam: boolean;
  private hasTeamFeatures: boolean;
  private disabled: boolean = true;
  private extensionPath: string;
  private isCompiling: boolean = false;
  private isDebugging: boolean = false;
  private currentlyFocusedFile: string;
  private teamDevsForFileCache = {};
  private resourcesLocation: string;

  constructor(extensionPath: string, logger: Logger) {
    this.extensionPath = extensionPath;
    this.logger = logger;
    this.setResourcesLocation();
    this.options = new Options(logger, this.resourcesLocation);
  }

  public initialize(): void {
    this.options.getSetting('settings', 'debug', false, (setting: Setting) => {
      if (setting.value === 'true') {
        this.logger.setLevel(LogLevel.DEBUG);
      }
      // this.options.getSetting('settings', 'metrics', false, (metrics: Setting) => {
      //   if (metrics.value === 'true') {
      //     this.isMetricsEnabled = true;
      //   }

      this.dependencies = new Dependencies(this.options, this.logger, this.resourcesLocation);

      let extension = vscode.extensions.getExtension('WakaTime.vscode-wakatime');
      this.extension = (extension != undefined && extension.packageJSON) || { version: '0.0.0' };
      this.agentName = Utils.getEditorName();

      this.options.getSetting('settings', 'disabled', false, (disabled: Setting) => {
        this.disabled = disabled.value === 'true';
        if (this.disabled) {
          this.dispose();
          return;
        }

        this.initializeDependencies();
      });
      // });
    });
  }

  public dispose() {
    this.statusBar?.dispose();
    this.statusBarTeamYou?.dispose();
    this.statusBarTeamOther?.dispose();
    this.disposable?.dispose();
  }

  private setResourcesLocation() {
    const home = Desktop.getHomeDirectory();
    const folder = path.join(home, '.wakatime');

    try {
      fs.mkdirSync(folder, { recursive: true });
      this.resourcesLocation = folder;
    } catch (e) {
      this.resourcesLocation = this.extensionPath;
    }
  }

  public initializeDependencies(): void {
    this.logger.debug(`Initializing WakaTime v${this.extension.version}`);

    this.statusBar = vscode.window.createStatusBarItem(
      'com.wakatime.statusbar',
      vscode.StatusBarAlignment.Left,
      3,
    );
    this.statusBar.name = 'WakaTime';
    this.statusBar.command = COMMAND_DASHBOARD;

    this.statusBarTeamYou = vscode.window.createStatusBarItem(
      'com.wakatime.teamyou',
      vscode.StatusBarAlignment.Left,
      2,
    );
    this.statusBarTeamYou.name = 'WakaTime Top dev';

    this.statusBarTeamOther = vscode.window.createStatusBarItem(
      'com.wakatime.teamother',
      vscode.StatusBarAlignment.Left,
      1,
    );
    this.statusBarTeamOther.name = 'WakaTime Team Total';

    this.options.getSetting('settings', 'status_bar_team', false, (statusBarTeam: Setting) => {
      this.showStatusBarTeam = statusBarTeam.value !== 'false';
      this.options.getSetting(
        'settings',
        'status_bar_enabled',
        false,
        (statusBarEnabled: Setting) => {
          this.showStatusBar = statusBarEnabled.value !== 'false';
          this.setStatusBarVisibility(this.showStatusBar);
          this.updateStatusBarText('WakaTime Initializing...');

          this.setupEventListeners();

          this.options.getSetting(
            'settings',
            'status_bar_coding_activity',
            false,
            (showCodingActivity: Setting) => {
              this.showCodingActivity = showCodingActivity.value !== 'false';

              this.dependencies.checkAndInstallCli(() => {
                this.logger.debug('WakaTime initialized');
                this.updateStatusBarText();
                this.updateStatusBarTooltip('WakaTime: Initialized');
                this.getCodingActivity();
              });
            },
          );
        },
      );
    });
  }

  private updateStatusBarText(text?: string): void {
    if (!this.statusBar) return;
    if (!text) {
      this.statusBar.text = '$(clock)';
    } else {
      this.statusBar.text = '$(clock) ' + text;
    }
  }

  private updateStatusBarTooltip(tooltipText: string): void {
    if (!this.statusBar) return;
    this.statusBar.tooltip = tooltipText;
  }

  private statusBarShowingError(): boolean {
    if (!this.statusBar) return false;
    return this.statusBar.text.indexOf('Error') != -1;
  }

  private updateTeamStatusBarTextForCurrentUser(text?: string): void {
    if (!this.statusBarTeamYou) return;
    if (!text) {
      this.statusBarTeamYou.text = '';
    } else {
      this.statusBarTeamYou.text = text;
    }
  }

  private updateStatusBarTooltipForCurrentUser(tooltipText: string): void {
    if (!this.statusBarTeamYou) return;
    this.statusBarTeamYou.tooltip = tooltipText;
  }

  private updateTeamStatusBarTextForOther(text?: string): void {
    if (!this.statusBarTeamOther) return;
    if (!text) {
      this.statusBarTeamOther.text = '';
    } else {
      this.statusBarTeamOther.text = text;
      this.statusBarTeamOther.tooltip = 'Developer with the most time spent in this file';
    }
  }

  private updateStatusBarTooltipForOther(tooltipText: string): void {
    if (!this.statusBarTeamOther) return;
    this.statusBarTeamOther.tooltip = tooltipText;
  }

  public promptForProxy(): void {
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      let defaultVal = proxy.value;
      if (!defaultVal) defaultVal = '';
      let promptOptions = {
        prompt: 'WakaTime Proxy',
        placeHolder: `Proxy format is https://user:pass@host:port (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
        validateInput: Utils.validateProxy.bind(this),
      };
      vscode.window.showInputBox(promptOptions).then((val) => {
        if (val || val === '') this.options.setSetting('settings', 'proxy', val, false);
      });
    });
  }

  public promptForDebug(): void {
    this.options.getSetting('settings', 'debug', false, (debug: Setting) => {
      let defaultVal = debug.value;
      if (!defaultVal || defaultVal !== 'true') defaultVal = 'false';
      let items: string[] = ['true', 'false'];
      let promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal == null) return;
        this.options.setSetting('settings', 'debug', newVal, false);
        if (newVal === 'true') {
          this.logger.setLevel(LogLevel.DEBUG);
          this.logger.debug('Debug enabled');
        } else {
          this.logger.setLevel(LogLevel.INFO);
        }
      });
    });
  }

  public promptToDisable(): void {
    this.options.getSetting('settings', 'disabled', false, (setting: Setting) => {
      const previousValue = this.disabled;
      let currentVal = setting.value;
      if (!currentVal || currentVal !== 'true') currentVal = 'false';
      let items: string[] = ['disable', 'enable'];
      const helperText = currentVal === 'true' ? 'disabled' : 'enabled';
      let promptOptions = {
        placeHolder: `disable or enable (extension is currently "${helperText}")`,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal !== 'enable' && newVal !== 'disable') return;
        this.disabled = newVal === 'disable';
        if (this.disabled != previousValue) {
          if (this.disabled) {
            this.options.setSetting('settings', 'disabled', 'true', false);
            this.logger.debug('Extension disabled, will not report code stats to dashboard');
            this.dispose();
          } else {
            this.options.setSetting('settings', 'disabled', 'false', false);
            this.initializeDependencies();
          }
        }
      });
    });
  }

  public promptStatusBarIcon(): void {
    this.options.getSetting('settings', 'status_bar_enabled', false, (setting: Setting) => {
      let defaultVal = setting.value;
      if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
      let items: string[] = ['true', 'false'];
      let promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal !== 'true' && newVal !== 'false') return;
        this.options.setSetting('settings', 'status_bar_enabled', newVal, false);
        this.showStatusBar = newVal === 'true'; // cache setting to prevent reading from disc too often
        this.setStatusBarVisibility(this.showStatusBar);
      });
    });
  }

  public promptStatusBarCodingActivity(): void {
    this.options.getSetting('settings', 'status_bar_coding_activity', false, (setting: Setting) => {
      let defaultVal = setting.value;
      if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
      let items: string[] = ['true', 'false'];
      let promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal !== 'true' && newVal !== 'false') return;
        this.options.setSetting('settings', 'status_bar_coding_activity', newVal, false);
        if (newVal === 'true') {
          this.logger.debug('Coding activity in status bar has been enabled');
          this.showCodingActivity = true;
          this.getCodingActivity();
        } else {
          this.logger.debug('Coding activity in status bar has been disabled');
          this.showCodingActivity = false;
          if (!this.statusBarShowingError()) {
            this.updateStatusBarText();
          }
        }
      });
    });
  }

  public async openDashboardWebsite(): Promise<void> {
    // const url = (await this.options.getApiUrl(true)).replace('/api/v1', '').replace('://api.', '://');
    // vscode.env.openExternal(vscode.Uri.parse(url));
    const cfgs = await this.options.getApiConfigs();
    if (cfgs.length === 0) return;
    if (cfgs.length === 1) {
      vscode.env.openExternal(vscode.Uri.parse(cfgs[0].apiUrl.replace('/api/v1', '').replace('://api.', '://')));
      return;
    }

    const items = cfgs.map(cfg => ({
      label: new URL(cfg.apiUrl).hostname,
      url: cfg.apiUrl.replace('/api/v1', '').replace('://api.', '://')
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select dashboard to open',
      ignoreFocusOut: true
    });

    if (selected) {
      vscode.env.openExternal(vscode.Uri.parse(selected.url));
    }
  }

  public openConfigFile(): void {
    let path = this.options.getConfigFile(false);
    if (path) {
      let uri = vscode.Uri.file(path);
      vscode.window.showTextDocument(uri);
    }
  }

  public openLogFile(): void {
    let path = this.options.getLogFile();
    if (path) {
      let uri = vscode.Uri.file(path);
      vscode.window.showTextDocument(uri);
    }
  }

  private setStatusBarVisibility(isVisible: boolean): void {
    if (isVisible) {
      this.statusBar?.show();
      this.statusBarTeamYou?.show();
      this.statusBarTeamOther?.show();
      this.logger.debug('Status bar icon enabled.');
    } else {
      this.statusBar?.hide();
      this.statusBarTeamYou?.hide();
      this.statusBarTeamOther?.hide();
      this.logger.debug('Status bar icon disabled.');
    }
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    let subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeTextEditorSelection(this.onChangeSelection, this, subscriptions);
    vscode.window.onDidChangeActiveTextEditor(this.onChangeTab, this, subscriptions);
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions);

    vscode.tasks.onDidStartTask(this.onDidStartTask, this, subscriptions);
    vscode.tasks.onDidEndTask(this.onDidEndTask, this, subscriptions);

    vscode.debug.onDidChangeActiveDebugSession(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidChangeBreakpoints(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession, this, subscriptions);
    vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession, this, subscriptions);

    // create a combined disposable for all event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private onDebuggingChanged(): void {
    this.onEvent(false);
  }

  private onDidStartDebugSession(): void {
    this.isDebugging = true;
    this.onEvent(false);
  }

  private onDidTerminateDebugSession(): void {
    this.isDebugging = false;
    this.onEvent(false);
  }

  private onDidStartTask(e: vscode.TaskStartEvent): void {
    if (e.execution.task.isBackground) return;
    if (e.execution.task.detail && e.execution.task.detail.indexOf('watch') !== -1) return;
    this.isCompiling = true;
    this.onEvent(false);
  }

  private onDidEndTask(): void {
    this.isCompiling = false;
    this.onEvent(false);
  }

  private onChangeSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
    this.onEvent(false);
  }

  private onChangeTab(_e: vscode.TextEditor | undefined): void {
    this.onEvent(false);
  }

  private onSave(_e: vscode.TextDocument | undefined): void {
    this.onEvent(true);
  }

  private onEvent(isWrite: boolean): void {
    clearTimeout(this.debounceTimeoutId);
    this.debounceTimeoutId = setTimeout(() => {
      if (this.disabled) return;
      let editor = vscode.window.activeTextEditor;
      if (editor) {
        let doc = editor.document;
        if (doc) {
          let file: string = doc.fileName;
          if (file) {
            if (this.currentlyFocusedFile !== file) {
              this.updateTeamStatusBarFromJson();
              this.updateTeamStatusBar(doc);
            }

            let time: number = Date.now();
            if (
              isWrite ||
              this.enoughTimePassed(time) ||
              this.lastFile !== file ||
              this.lastDebug !== this.isDebugging ||
              this.lastCompile !== this.isCompiling
            ) {
              this.sendHeartbeat(
                doc,
                time,
                editor.selection.start,
                isWrite,
                this.isCompiling,
                this.isDebugging,
              );
              this.lastFile = file;
              this.lastHeartbeat = time;
              this.lastDebug = this.isDebugging;
              this.lastCompile = this.isCompiling;
            }
          }
        }
      }
    }, this.debounceMs);
  }
  private getOperatingSystem(): string | null {
    const platform = process.platform;
    if (platform === 'darwin') return 'Mac';
    if (platform === 'win32') return 'Windows';
    if (platform === 'linux') return 'Linux';
    return platform;
  }
  private getPlugin(): string {
    const agent = `${this.agentName}/${vscode.version} vscode-wakatime/${this.extension.version}`;
    const os = this.getOperatingSystem();
    if (os) return `(${os}) ${agent}`;
    return agent;
  }
  private async sendHeartbeat(
    doc: vscode.TextDocument,
    time: number,
    selection: vscode.Position,
    isWrite: boolean,
    isCompiling: boolean,
    isDebugging: boolean,
  ): Promise<void> {
    let file = doc.fileName;
    if (Utils.isRemoteUri(doc.uri)) {
      file = `${doc.uri.authority}${doc.uri.path}`;
      file = file.replace('ssh-remote+', 'ssh://');
      // TODO: how to support 'dev-container', 'attached-container', 'wsl', and 'codespaces' schemes?
    }

    // prevent sending the same heartbeat (https://github.com/wakatime/vscode-wakatime/issues/163)
    if (isWrite && this.isDuplicateHeartbeat(file, time, selection)) return;

    const payload = {
      type: 'file',
      entity: file,
      time: Date.now() / 1000,
      lineno: selection.line + 1,
      cursorpos: selection.character + 1,
      lines: doc.lineCount,
      is_write: isWrite,
      plugin: this.getPlugin(),
    };
    this.logger.debug(`Sending heartbeat: ${JSON.stringify(payload)}`);

    const project = this.getProjectName(doc.uri);
    if (project) payload['project'] = project;

    const language = doc.languageId ?? "";
    if (language) payload['language'] = language;

    const folder = this.getProjectFolder(doc.uri);
    if (folder && file.indexOf(folder) === 0) {
      payload['project_root_count'] = this.countSlashesInPath(folder);
    }

    if (isDebugging) {
      payload['category'] = 'debugging';
    } else if (isCompiling) {
      payload['category'] = 'building';
    } else if (Utils.isPullRequest(doc.uri)) {
      payload['category'] = 'code reviewing';
    }

    this.logger.debug(`Sending heartbeat: ${JSON.stringify(payload)}`);

    const apiConfigs = await this.options.getApiConfigs();
    const promises = apiConfigs.map(async ({apiUrl, apiKey}) => {
      const url = `${apiUrl}/users/current/heartbeats?api_key=${apiKey}`;
      this.logger.debug(` |-> Sending heartbeat to ${url}`);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Machine-Name': vscode.env.appHost,
          },
          body: JSON.stringify(payload),
        }).catch((e) => {
          this.logger.error(`[03] API Error: ${e}`);
          throw e;
        });
        const resp = await response.text();
        this.logger.debug(`API Response: ${resp}`);
        const parsedJSON = JSON.parse(resp); // await response.json();
        if (response.status == 200 || response.status == 201 || response.status == 202) {
          if (this.showStatusBar) this.getCodingActivity();
        } else {
          this.logger.warn(`[01] API Error ${response.status}: ${parsedJSON}`);
          if (response && response.status == 401) {
            let error_msg = 'Invalid WakaTime Api Key [@${apiUrl}]';
            if (this.showStatusBar) {
              this.updateStatusBarText('WakaTime Error');
              this.updateStatusBarTooltip(`WakaTime: ${error_msg} @ ${apiUrl}`);
            }
            this.logger.error(error_msg);
            // let now: number = Date.now();
            // if (this.lastApiKeyPrompted < now - 86400000) {
            //   // only prompt once per day
            //   this.promptForApiKey(false);
            //   this.lastApiKeyPrompted = now;
            // }
          } else {
            let error_msg = `Error sending heartbeat (${response.status}); Check your browser console for more details.`;
            if (this.showStatusBar) {
              this.updateStatusBarText('WakaTime Error');
              this.updateStatusBarTooltip(`WakaTime: ${error_msg}`);
            }
            this.logger.error(error_msg);
          }
        }
      } catch (ex) {
        this.logger.warn(`[02] API Error: ${ex}`);
        let error_msg = `Error sending heartbeat; Check your browser console for more details.`;
        if (this.showStatusBar) {
          this.updateStatusBarText('WakaTime Error');
          this.updateStatusBarTooltip(`WakaTime: ${error_msg}`);
        }
        this.logger.error(error_msg);
      }
    });
    await Promise.all(promises);
  }

  private async getCodingActivity() {
    if (!this.showStatusBar) return;

    const cutoff = Date.now() - this.fetchTodayInterval;
    if (this.lastFetchToday > cutoff) return;

    this.lastFetchToday = Date.now();

    const apiConfigs = await this.options.getApiConfigs();
    if (!apiConfigs) return;

    await this._getCodingActivity();
  }

  private async _getCodingActivity() {
    this.logger.debug('Fetching coding activity for Today from api.');
    const apiConfigs = await this.options.getApiConfigs();
    const promises = apiConfigs.map(async ({apiUrl, apiKey}) => {
      const url = `${apiUrl}/users/current/statusbar/today?api_key=${apiKey}`;
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
          if (this.showStatusBar) {
            if (parsedJSON.data) this.hasTeamFeatures = parsedJSON.data.has_team_features;
            let output = parsedJSON.data.grand_total.text;
            if (
              await this.options.getSettingAsync("settings", "wakatime.status_bar_hide_categories") != 'true' &&
              parsedJSON.data.categories.length > 1
            ) {
              output = parsedJSON.data.categories.map((x) => x.text + ' ' + x.name).join(', ');
            }
            if (output && output.trim()) {
              if (this.showCodingActivity) {
                this.updateStatusBarText(output.trim());
                this.updateStatusBarTooltip(
                  'WakaTime: Today’s coding time. Click to visit dashboard.',
                );
              } else {
                this.updateStatusBarText();
                this.updateStatusBarTooltip(output.trim());
              }
            } else {
              this.updateStatusBarText();
              this.updateStatusBarTooltip('WakaTime: Calculating time spent today in background...');
            }
            this.updateTeamStatusBar();
          }
        } else {
          this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
          if (response && response.status == 401) {
            let error_msg = 'Invalid WakaTime Api Key';
            if (this.showStatusBar) {
              this.updateStatusBarText('WakaTime Error');
              this.updateStatusBarTooltip(`WakaTime: ${error_msg}`);
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
    });
    await Promise.all(promises);
  }

  private async updateTeamStatusBar(doc?: vscode.TextDocument) {
    if (!this.showStatusBarTeam) return;
    if (!this.hasTeamFeatures) return;

    if (!doc) {
      doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
    }

    let file = doc.fileName;
    if (Utils.isRemoteUri(doc.uri)) {
      file = `${doc.uri.authority}${doc.uri.path}`;
      file = file.replace('ssh-remote+', 'ssh://');
      // TODO: how to support 'dev-container', 'attached-container', 'wsl', and 'codespaces' schemes?
    }

    this.currentlyFocusedFile = file;

    if (this.teamDevsForFileCache[file]) {
      this.updateTeamStatusBarFromJson(this.teamDevsForFileCache[file]);
      return;
    }

    this.logger.debug('Fetching devs for currently focused file from api.');
    const apiConfigs = await this.options.getApiConfigs();
    const promises = apiConfigs.map(async ({apiUrl, apiKey}) => {
      const url = `${apiUrl}/users/current/file_experts?api_key=${apiKey}`;

      const payload = {
        entity: file,
        plugin: this.agentName + '/' + vscode.version + ' vscode-wakatime/' + this.extension.version,
      };
  
      const project = this.getProjectName(doc!.uri);
      if (!project) return;
      payload['project'] = project;
  
      const folder = this.getProjectFolder(doc!.uri);
      if (!folder || file.indexOf(folder) !== 0) return;
      payload['project_root_count'] = this.countSlashesInPath(folder);
  
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
        if (response.status == 200) {
          const devs = {
            you: null,
            other: null,
          };
          if (parsedJSON.data) {
            const currentUser = parsedJSON.data.find((dev) => dev.user.is_current_user);
            let topDev = parsedJSON.data[0];
            if (topDev.user.is_current_user) {
              if (parsedJSON.data.length > 1) {
                topDev = parsedJSON.data[1];
              } else {
                topDev = null;
              }
            }
  
            devs.you = currentUser;
            devs.other = topDev;
            this.teamDevsForFileCache[file] = devs;
          }
  
          // make sure this file is still the currently focused file
          if (file !== this.currentlyFocusedFile) return;
  
          if (this.showStatusBar) {
            this.updateTeamStatusBarFromJson(devs);
          }
        } else {
          this.updateTeamStatusBarTextForCurrentUser();
          this.updateTeamStatusBarTextForOther();
          this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
          if (response && response.status == 401) {
            this.logger.error('Invalid WakaTime Api Key');
          } else {
            let error_msg = `Error fetching devs for currently focused file (${response.status}); Check your browser console for more details.`;
            this.logger.debug(error_msg);
          }
        }
      } catch (ex) {
        this.logger.warn(`API Error: ${ex}`);
      }
    });
    await Promise.all(promises);
  }

  private updateTeamStatusBarFromJson(jsonData?: any) {
    if (!jsonData) {
      this.updateTeamStatusBarTextForCurrentUser();
      this.updateTeamStatusBarTextForOther();
      return;
    }

    const you = jsonData.you;
    const other = jsonData.other;

    if (you) {
      this.updateTeamStatusBarTextForCurrentUser('You: ' + you.total.text);
      this.updateStatusBarTooltipForCurrentUser('Your total time spent in this file');
    } else {
      this.updateTeamStatusBarTextForCurrentUser();
    }
    if (other) {
      this.updateTeamStatusBarTextForOther(other.user.name + ': ' + other.total.text);
      this.updateStatusBarTooltipForOther(
        other.user.long_name + '’s total time spent in this file',
      );
    } else {
      this.updateTeamStatusBarTextForOther();
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

  private getProjectName(uri: vscode.Uri): string {
    if (!vscode.workspace) return '';
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      try {
        return workspaceFolder.name;
      } catch (e) {}
    }
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      return vscode.workspace.workspaceFolders[0].name;
    }
    return vscode.workspace.name || '';
  }

  private getProjectFolder(uri: vscode.Uri): string {
    if (!vscode.workspace) return '';
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      try {
        return workspaceFolder.uri.fsPath;
      } catch (e) {}
    }
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return '';
  }

  private countSlashesInPath(path: string): number {
    if (!path) return 0;

    const windowsNetDrive = path.indexOf('\\\\') === 0;

    path = path.replace(/[\\/]+/, '/');

    if (windowsNetDrive) {
      path = '\\\\' + path.slice(1);
    }

    if (!path.endsWith('/')) path = path + '/';

    return (path.match(/\//g) || []).length;
  }
}
