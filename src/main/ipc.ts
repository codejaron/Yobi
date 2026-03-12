import { BrowserWindow, dialog, ipcMain, shell, WebContents } from "electron";
import type { OpenDialogOptions } from "electron";
import type {
  AppConfig,
  CommandApprovalDecision
} from "@shared/types";
import type { CompanionRuntime } from "./app-runtime";

const STATUS_CHANNEL = "runtime:status";
const CONSOLE_RUN_EVENT_CHANNEL = "runtime:console-run-event";
const WHISPER_MODEL_PROGRESS_CHANNEL = "runtime:whisper-model-progress";

interface IpcSubscription {
  unsubscribe: () => void;
  onDestroyed: () => void;
}

const statusSubscriptions = new Map<number, IpcSubscription>();
const consoleRunSubscriptions = new Map<number, IpcSubscription>();

function clearSubscription(target: WebContents, subscriptions: Map<number, IpcSubscription>): void {
  const current = subscriptions.get(target.id);
  if (!current) {
    return;
  }

  target.removeListener("destroyed", current.onDestroyed);
  current.unsubscribe();
  subscriptions.delete(target.id);
}

export function registerIpcHandlers(runtime: CompanionRuntime): void {
  ipcMain.handle("config:get", () => runtime.getConfig());
  ipcMain.handle("config:save", (_, config: AppConfig) => runtime.saveConfig(config));
  ipcMain.handle("voice:stt:status", () => runtime.getSpeechRecognitionStatus());
  ipcMain.handle(
    "whisper:model:ensure",
    async (
      event,
      payload: {
        modelSize?: AppConfig["whisperLocal"]["modelSize"];
      }
    ) => {
      const modelSize = payload?.modelSize ?? "base";
      return runtime.ensureWhisperModel({
        modelSize,
        onProgress: (percent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(WHISPER_MODEL_PROGRESS_CHANNEL, {
              modelSize,
              percent
            });
          }
        }
      });
    }
  );
  ipcMain.handle(
    "whisper:model:status",
    (
      _,
      payload: {
        modelSize?: AppConfig["whisperLocal"]["modelSize"];
      }
    ) => runtime.getWhisperModelStatus(payload)
  );

  ipcMain.handle("history:list", (_, query: { query?: string; limit?: number; offset?: number }) =>
    runtime.getHistory(query)
  );
  ipcMain.handle("history:clear", () => runtime.clearHistory());

  ipcMain.handle("mind:snapshot:get", () => runtime.getMindSnapshot());
  ipcMain.handle("mind:soul:get", () => runtime.getSoul());
  ipcMain.handle("mind:soul:save", (_, input: { markdown: string }) => runtime.saveSoul(input));
  ipcMain.handle("mind:state:patch", (_, input: { patch: Record<string, unknown> }) =>
    runtime.patchState({
      patch: input.patch as any
    })
  );
  ipcMain.handle("mind:profile:patch", (_, input: { patch: Record<string, unknown> }) =>
    runtime.patchProfile({
      patch: input.patch as any
    })
  );
  ipcMain.handle(
    "mind:section:reset",
    (
      _,
      input: {
        section?: "soul" | "state" | "profile" | "facts" | "episodes";
      }
    ) =>
      runtime.resetMindSection({
        section: input?.section ?? "state"
      })
  );
  ipcMain.handle("kernel:task:trigger", (_, input: { taskType?: "tick-now" | "daily-now" }) =>
    runtime.triggerKernelTask(input?.taskType === "daily-now" ? "daily-now" : "tick-now")
  );

  ipcMain.handle("status:get", () => runtime.getStatus());
  ipcMain.handle("browse:bili:qr:start", () => runtime.startBilibiliQrAuth());
  ipcMain.handle("browse:bili:qr:poll", (_, payload: { qrcodeKey?: string }) =>
    runtime.pollBilibiliQrAuth({
      qrcodeKey: payload?.qrcodeKey ?? ""
    })
  );
  ipcMain.handle("browse:bili:cookie:save", (_, payload: { cookie?: string }) =>
    runtime.saveBilibiliCookie({
      cookie: payload?.cookie ?? ""
    })
  );
  ipcMain.handle("browse:bili:sync:trigger", () => runtime.triggerBilibiliSync());
  ipcMain.handle("browse:bili:account:open", () => runtime.openBilibiliAccount());
  ipcMain.handle(
    "system:permissions:open-settings",
    (
      _,
      permission: "accessibility" | "microphone" | "screenCapture"
    ) => runtime.openSystemPermissionSettings(permission)
  );
  ipcMain.handle("system:permissions:reset", () => runtime.resetSystemPermissions());

  ipcMain.handle("pet:model:import", async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "选择 Live2D 模型文件夹",
      properties: ["openDirectory"]
    };
    const picked = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (picked.canceled || picked.filePaths.length === 0) {
      return {
        canceled: true
      };
    }

    const imported = await runtime.importPetModelDirectory(picked.filePaths[0]);
    return {
      canceled: false,
      modelDir: imported.modelDir
    };
  });

  ipcMain.handle("skills:list", () => runtime.listSkills());
  ipcMain.handle("skills:rescan", () => runtime.rescanSkills());
  ipcMain.handle("skills:set-enabled", (_, payload: { skillId?: string; enabled?: boolean }) =>
    runtime.setSkillEnabled({
      skillId: payload?.skillId ?? "",
      enabled: payload?.enabled === true
    })
  );
  ipcMain.handle("skills:delete", (_, payload: { skillId?: string }) =>
    runtime.deleteSkill(payload?.skillId ?? "")
  );
  ipcMain.handle("skills:import-folder", async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "选择 Skill 文件夹",
      properties: ["openDirectory"]
    };
    const picked = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true };
    }

    const skill = await runtime.importSkillDirectory(picked.filePaths[0]);
    return {
      canceled: false,
      skill
    };
  });

  ipcMain.handle("pet:chat:send", (_, payload: { text?: string }) =>
    runtime.chatFromPet(payload?.text ?? "")
  );
  ipcMain.handle(
    "pet:voice:transcribe-and-send",
    (
      _,
      payload: {
        pcm16Base64?: string;
        sampleRate?: number;
      }
    ) => runtime.transcribeAndSendFromPet(payload)
  );

  ipcMain.handle("console:chat:send", (_, payload: { text?: string }) =>
    runtime.startConsoleChat(payload?.text ?? "")
  );
  ipcMain.handle("console:chat:stop", (_, payload: { requestId?: string }) =>
    runtime.stopConsoleChat(payload?.requestId ?? "")
  );
  ipcMain.handle(
    "voice:transcribe",
    (
      _,
      payload: {
        pcm16Base64?: string;
        sampleRate?: number;
      }
    ) => runtime.transcribeVoiceInput(payload)
  );
  ipcMain.handle(
    "console:chat:history",
    (
      _,
      payload: {
        cursor?: string;
        limit?: number;
      }
    ) => runtime.getConsoleChatHistory(payload)
  );
  ipcMain.handle(
    "console:chat:approve",
    (
      _,
      payload: {
        approvalId: string;
        decision: CommandApprovalDecision;
      }
    ) => runtime.resolveConsoleApproval(payload)
  );
  ipcMain.handle("scheduler:list", () => runtime.getScheduledTasks());
  ipcMain.handle("scheduler:save", (_, payload) => runtime.saveScheduledTask(payload));
  ipcMain.handle("scheduler:pause", (_, payload: { taskId?: string }) =>
    runtime.pauseScheduledTask(payload?.taskId ?? "")
  );
  ipcMain.handle("scheduler:resume", (_, payload: { taskId?: string }) =>
    runtime.resumeScheduledTask(payload?.taskId ?? "")
  );
  ipcMain.handle("scheduler:delete", (_, payload: { taskId?: string }) =>
    runtime.deleteScheduledTask(payload?.taskId ?? "")
  );
  ipcMain.handle("scheduler:run-now", (_, payload: { taskId?: string }) =>
    runtime.runScheduledTaskNow(payload?.taskId ?? "")
  );

  ipcMain.on("status:subscribe", (event) => {
    subscribeToStatus(runtime, event.sender);
  });

  ipcMain.on("console:chat:subscribe", (event) => {
    subscribeToConsoleRun(runtime, event.sender);
  });

  ipcMain.handle("open:path", (_, location: string) => {
    shell.showItemInFolder(location);
    return {
      path: location
    };
  });
}

function subscribeToStatus(runtime: CompanionRuntime, target: WebContents): void {
  clearSubscription(target, statusSubscriptions);

  const unsubscribe = runtime.onStatus((status) => {
    if (target.isDestroyed()) {
      clearSubscription(target, statusSubscriptions);
      return;
    }

    target.send(STATUS_CHANNEL, status);
  });

  const onDestroyed = () => {
    clearSubscription(target, statusSubscriptions);
  };

  statusSubscriptions.set(target.id, {
    unsubscribe,
    onDestroyed
  });
  target.on("destroyed", onDestroyed);
}

function subscribeToConsoleRun(runtime: CompanionRuntime, target: WebContents): void {
  clearSubscription(target, consoleRunSubscriptions);

  const unsubscribe = runtime.onConsoleRunEvent((event) => {
    if (target.isDestroyed()) {
      clearSubscription(target, consoleRunSubscriptions);
      return;
    }

    target.send(CONSOLE_RUN_EVENT_CHANNEL, event);
  });

  const onDestroyed = () => {
    clearSubscription(target, consoleRunSubscriptions);
  };

  consoleRunSubscriptions.set(target.id, {
    unsubscribe,
    onDestroyed
  });
  target.on("destroyed", onDestroyed);
}
