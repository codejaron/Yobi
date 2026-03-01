import { useState } from "react";
import { ConsoleActionPane } from "@renderer/pages/console-chat/ConsoleActionPane";
import { ConsoleChatPane } from "@renderer/pages/console-chat/ConsoleChatPane";
import { useConsoleChatController } from "@renderer/pages/console-chat/useConsoleChatController";
import { ClawTabPanel } from "./ClawTabPanel";

export function ConsoleChatPage() {
  const [activeTab, setActiveTab] = useState<"yobi" | "claw">("yobi");

  const {
    messages,
    actions,
    logEnabled,
    setLogEnabled,
    draft,
    setDraft,
    sttReady,
    micHint,
    pendingApproval,
    approvalIndex,
    setApprovalIndex,
    expandedActions,
    historyLoaded,
    historyHasMore,
    loadingMoreHistory,
    clearingHistory,
    busy,
    recording,
    transcribing,
    inputDisabled,
    micButtonDisabled,
    micButtonLabel,
    chatBottomRef,
    chatListRef,
    actionBottomRef,
    inputRef,
    clearHistory,
    clearActionLogs,
    toggleActionExpanded,
    handleChatScroll,
    handleSubmit,
    handleInputKeyDown,
    toggleMicRecording,
    submitApproval,
    isToolAction
  } = useConsoleChatController();

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-full border border-border/70 bg-white/75 p-1">
        <button
          type="button"
          onClick={() => setActiveTab("yobi")}
          className={`rounded-full px-4 py-1.5 text-sm transition ${
            activeTab === "yobi"
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Yobi
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("claw")}
          className={`rounded-full px-4 py-1.5 text-sm transition ${
            activeTab === "claw"
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Claw
        </button>
      </div>

      <div className={activeTab === "yobi" ? "block" : "hidden"}>
        <div className="grid h-[calc(100vh-140px)] min-h-[680px] max-h-[900px] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <ConsoleChatPane
            busy={busy}
            clearingHistory={clearingHistory}
            historyLoaded={historyLoaded}
            historyHasMore={historyHasMore}
            loadingMoreHistory={loadingMoreHistory}
            messages={messages}
            chatListRef={chatListRef}
            chatBottomRef={chatBottomRef}
            onChatScroll={handleChatScroll}
            pendingApproval={pendingApproval}
            approvalIndex={approvalIndex}
            setApprovalIndex={setApprovalIndex}
            submitApproval={submitApproval}
            draft={draft}
            setDraft={setDraft}
            inputRef={inputRef}
            inputDisabled={inputDisabled}
            onInputKeyDown={handleInputKeyDown}
            toggleMicRecording={toggleMicRecording}
            micButtonDisabled={micButtonDisabled}
            recording={recording}
            transcribing={transcribing}
            micButtonLabel={micButtonLabel}
            sttReady={sttReady}
            micHint={micHint}
            onSubmit={handleSubmit}
            clearHistory={clearHistory}
          />
          <ConsoleActionPane
            logEnabled={logEnabled}
            setLogEnabled={setLogEnabled}
            clearActionLogs={clearActionLogs}
            actions={actions}
            isToolAction={isToolAction}
            expandedActions={expandedActions}
            toggleActionExpanded={toggleActionExpanded}
            actionBottomRef={actionBottomRef}
          />
        </div>
      </div>

      <div className={activeTab === "claw" ? "block" : "hidden"}>
        <ClawTabPanel active={activeTab === "claw"} />
      </div>
    </div>
  );
}
